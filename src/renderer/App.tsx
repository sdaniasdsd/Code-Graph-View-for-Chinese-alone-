import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import dagre from 'dagre';
import {
  Activity, AlertTriangle, ArrowDownLeft, ArrowUpRight, Bot, Braces, Check, ChevronDown,
  ChevronRight, CircleHelp, Code2, FileCode2, Folder, FolderOpen, GitBranch,
  GitCompareArrows, KeyRound, LoaderCircle, Maximize2, MessageSquareText, Network,
  Search, Send, Settings2, Sparkles, SquareArrowOutUpRight, Waypoints, X,
} from 'lucide-react';

type Mode = 'files' | 'calls' | 'git';
type GraphNodeData = { label: string; sub: string; active?: boolean; kind: 'file' | 'function'; confidence?: string; relation?: 'focus' | 'upstream' | 'downstream' | 'both'; summary?: string };
type AppNode = Node<GraphNodeData>;

function MapNode({ data, selected }: NodeProps<AppNode>) {
  const relationLabel = data.relation === 'focus' ? '当前函数' : data.relation === 'upstream' ? '上游' : data.relation === 'downstream' ? '下游' : data.relation === 'both' ? '上下游' : '';
  return <div className={`map-node ${data.kind} ${data.summary ? 'has-summary' : ''} ${data.relation ? `relation-${data.relation}` : ''} ${selected || data.active ? 'active' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <div className="map-node-main"><div className="map-node-icon">{data.kind === 'file' ? <FileCode2 size={15} /> : <Braces size={15} />}</div>
      <div className="map-node-copy"><strong title={data.label}>{data.label}</strong><small title={data.sub}>{data.sub}</small></div>
      {relationLabel ? <span className={`relation-badge ${data.relation}`}>{relationLabel}</span> : data.confidence && <span className="confidence-mark">≈</span>}
    </div>
    {data.summary && <div className="map-node-summary" title={data.summary}><small>AI 注释</small><span>{data.summary}</span></div>}
    <Handle type="source" position={Position.Right} />
  </div>;
}
const nodeTypes = { map: MapNode };

function layout(nodes: AppNode[], edges: Edge[]) {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: 42, ranksep: 92, marginx: 30, marginy: 30 });
  for (const node of nodes) graph.setNode(node.id, node.data.summary ? { width: 260, height: 118 } : { width: 230, height: 64 });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  return nodes.map((node) => {
    const point = graph.node(node.id);
    const width = node.data.summary ? 260 : 230;
    const height = node.data.summary ? 118 : 64;
    return { ...node, position: { x: point?.x ? point.x - width / 2 : 0, y: point?.y ? point.y - height / 2 : 0 } };
  });
}

function relativeLabel(path: string) {
  const parts = path.split(/[\\/]/);
  return parts.length > 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : path;
}

function findTreeFile(entries: ProjectTreeEntry[], relativePath: string): ProjectTreeEntry | undefined {
  for (const entry of entries) {
    if (entry.kind === 'file' && entry.relativePath === relativePath) return entry;
    if (entry.children) {
      const found = findTreeFile(entry.children, relativePath);
      if (found) return found;
    }
  }
}

function findTreeEntry(entries: ProjectTreeEntry[], relativePath: string): ProjectTreeEntry | undefined {
  for (const entry of entries) {
    if (entry.relativePath === relativePath) return entry;
    if (entry.children) {
      const found = findTreeEntry(entry.children, relativePath);
      if (found) return found;
    }
  }
}

function initialProjectSelection(project: ProjectIndex): string {
  const cDefinition = project.definitions.find((fn) => fn.file.toLowerCase().endsWith('.c'));
  const cFile = project.files.find((file) => file.relativePath.toLowerCase().endsWith('.c'))?.relativePath;
  const fallbackFunction = project.definitions[0];
  return cDefinition
    ? `${cDefinition.file}::${cDefinition.name}`
    : cFile ?? (fallbackFunction ? `${fallbackFunction.file}::${fallbackFunction.name}` : project.files[0]?.relativePath ?? '');
}

function parentFolderPaths(relativePath: string): string[] {
  const parts = relativePath.split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

function fuzzyScore(query: string, value: string): number | null {
  const needle = query.trim().toLocaleLowerCase();
  const haystack = value.toLocaleLowerCase();
  if (!needle) return 0;
  const directIndex = haystack.indexOf(needle);
  if (directIndex >= 0) return 1000 - directIndex * 8 - haystack.length * 0.2;
  let needleIndex = 0;
  let previousMatch = -2;
  let score = 0;
  for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[needleIndex]) continue;
    score += 12 + (index === previousMatch + 1 ? 10 : 0);
    if (index === 0 || /[^a-z0-9_]/i.test(haystack[index - 1])) score += 8;
    previousMatch = index;
    needleIndex += 1;
  }
  return needleIndex === needle.length ? score - haystack.length * 0.15 : null;
}

function parseFunctionSummaryLines(text: string): Record<string, string> {
  const summaries: Record<string, string> = {};
  for (const match of text.matchAll(/^\s*(?:[-*]\s*)?\[\[(F\d+)\]\]\s*[:：-]?\s*(.*?)\s*$/gm)) {
    const summary = match[2].replace(/^['"“”]+|['"“”]+$/g, '').trim();
    if (summary) summaries[match[1]] = summary;
  }
  return summaries;
}

function countTreeFiles(entries: ProjectTreeEntry[]): number {
  return entries.reduce((count, entry) => count + (entry.kind === 'file' ? 1 : countTreeFiles(entry.children ?? [])), 0);
}

function readRecentProjects(): Array<{ name: string; path: string }> {
  try {
    const recent = JSON.parse(localStorage.getItem('rtt.recent') || '[]') as Array<{ name?: unknown; path?: unknown }>;
    return recent.filter((item): item is { name: string; path: string } => typeof item.name === 'string' && typeof item.path === 'string');
  } catch { return []; }
}

export function App() {
  const [project, setProject] = useState<ProjectIndex | null>(null);
  const [mode, setMode] = useState<Mode>('calls');
  const [selectedId, setSelectedId] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [tab, setTab] = useState<'detail' | 'ai'>('detail');
  const [functionSearch, setFunctionSearch] = useState('');
  const [functionSearchOpen, setFunctionSearchOpen] = useState(false);
  const [functionSearchIndex, setFunctionSearchIndex] = useState(0);
  const [showAllUpstream, setShowAllUpstream] = useState(false);
  const [showAllDownstream, setShowAllDownstream] = useState(false);
  const [functionTrail, setFunctionTrail] = useState<string[]>([]);
  const [functionTrailIndex, setFunctionTrailIndex] = useState(-1);
  const [functionSummary, setFunctionSummary] = useState('');
  const [functionSummaries, setFunctionSummaries] = useState<Record<string, string>>({});
  const [functionSummaryProgress, setFunctionSummaryProgress] = useState({ complete: 0, total: 0 });
  const [functionSummaryError, setFunctionSummaryError] = useState('');
  const [functionSummaryLoading, setFunctionSummaryLoading] = useState(false);
  const functionSummaryRequestRef = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: '', keyConfigured: false, vscodePath: '' });
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [gitInfo, setGitInfo] = useState<Awaited<ReturnType<typeof window.rttApp.getGitImpact>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [configuringEditor, setConfiguringEditor] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('请解释这段调用链的作用，并指出值得关注的边界情况。');
  const [aiResult, setAiResult] = useState('');
  const [aiError, setAiError] = useState('');
  const [contextConfirmed, setContextConfirmed] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [preview, setPreview] = useState('');
  const reactFlowRef = useRef<ReactFlowInstance<AppNode, Edge> | null>(null);

  useEffect(() => {
    void window.rttApp.getSettings().then(setSettings);
    void window.rttApp.detectEditor().then((result) => setEditorPath(result.path));
  }, []);

  useEffect(() => {
    setContextConfirmed(false);
    setAiError('');
    setShowAllUpstream(false);
    setShowAllDownstream(false);
    setFunctionSummary(functionSummaries[selectedId] ?? '');
    setFunctionSummaryError('');
    setFunctionSummaryLoading(false);
    functionSummaryRequestRef.current += 1;
  }, [selectedId]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  }, []);

  const openProject = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.rttApp.openProject();
      if (!result) return;
      const initialSelection = initialProjectSelection(result);
      setProject(result);
      setFunctionSummaries({});
      setSelectedId(initialSelection);
      setFunctionTrail(initialSelection.includes('::') ? [initialSelection] : []);
      setFunctionTrailIndex(initialSelection.includes('::') ? 0 : -1);
      setExpandedFolders(new Set(parentFolderPaths(initialSelection)));
      setMode('calls'); setAiResult(''); setPreview('');
      const recent = JSON.parse(localStorage.getItem('rtt.recent') || '[]') as Array<{ name: string; path: string }>;
      localStorage.setItem('rtt.recent', JSON.stringify([{ name: result.projectName, path: result.root }, ...recent.filter((item) => item.path !== result.root)].slice(0, 6)));
      const git = await window.rttApp.getGitImpact(result.root);
      setGitInfo(git);
      notify(`已打开 ${result.projectName}，发现 ${result.files.length} 个源码文件`);
    } catch (error) { notify(error instanceof Error ? error.message : '打开工程失败'); }
    finally { setBusy(false); }
  }, [notify]);

  const autoConfigureEditor = useCallback(async () => {
    setConfiguringEditor(true);
    try {
      const result = await window.rttApp.detectEditor();
      if (!result.path) {
        notify('没有自动找到 VS Code。可以点“手动选择”指定 Code.exe。');
        setSettingsOpen(true);
        return;
      }
      await window.rttApp.saveSettings({ ...settings, vscodePath: result.path });
      const updated = await window.rttApp.getSettings();
      setSettings({ ...updated, apiKey: '' });
      setEditorPath(result.path);
      notify('已配置本机 VS Code，可以从源码详情直接跳转。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '配置 VS Code 失败');
    } finally {
      setConfiguringEditor(false);
    }
  }, [notify, settings]);

  const recentProjects = useMemo(() => readRecentProjects(), [project]);

  const reopenProject = useCallback(async (root: string) => {
    setBusy(true);
    try {
      const result = await window.rttApp.analyzeProject(root);
      const initialSelection = initialProjectSelection(result);
      setProject(result);
      setFunctionSummaries({});
      setSelectedId(initialSelection);
      setFunctionTrail(initialSelection.includes('::') ? [initialSelection] : []);
      setFunctionTrailIndex(initialSelection.includes('::') ? 0 : -1);
      setExpandedFolders(new Set(parentFolderPaths(initialSelection)));
      setMode('calls');
      setGitInfo(await window.rttApp.getGitImpact(root));
    } catch (error) {
      const recent = readRecentProjects().filter((item) => item.path !== root);
      localStorage.setItem('rtt.recent', JSON.stringify(recent));
      notify(error instanceof Error ? error.message : '无法读取该工程，请重新选择文件夹。');
    }
    finally { setBusy(false); }
  }, [notify]);

  const selectedFunction = useMemo(() => project?.definitions.find((fn) => `${fn.file}::${fn.name}` === selectedId), [project, selectedId]);
  const selectedFile = useMemo(() => project?.files.find((file) => file.relativePath === selectedId) ?? (selectedFunction ? project?.files.find((file) => file.relativePath === selectedFunction.file) : undefined) ?? (project ? findTreeFile(project.tree, selectedId) : undefined), [project, selectedId, selectedFunction]);
  const selectedTreeEntry = useMemo(() => project ? findTreeEntry(project.tree, selectedId) : undefined, [project, selectedId]);
  const selectedFolder = selectedTreeEntry?.kind === 'directory' ? selectedTreeEntry : undefined;
  const functionSearchResults = useMemo(() => {
    if (!project || !functionSearch.trim()) return [];
    return project.definitions
      .map((fn) => {
        const nameScore = fuzzyScore(functionSearch, fn.name);
        const fileScore = fuzzyScore(functionSearch, fn.file);
        const score = Math.max(nameScore ?? -1, fileScore === null ? -1 : fileScore - 80);
        return score < 0 ? null : { fn, score };
      })
      .filter((item): item is { fn: ProjectIndex['definitions'][number]; score: number } => item !== null)
      .sort((a, b) => b.score - a.score || a.fn.name.localeCompare(b.fn.name) || a.fn.file.localeCompare(b.fn.file))
      .slice(0, 12);
  }, [project, functionSearch]);
  const selectedCallNeighborCounts = useMemo(() => {
    if (!project || !selectedFunction) return { upstream: 0, downstream: 0 };
    const key = `${selectedFunction.file}::${selectedFunction.name}`;
    return {
      upstream: project.functionEdges.filter((edge) => edge.to === key && edge.from !== key).length,
      downstream: project.functionEdges.filter((edge) => edge.from === key && edge.to !== key).length,
    };
  }, [project, selectedFunction]);

  useEffect(() => {
    let active = true;
    if (!selectedFile) { setPreview(''); return; }
    void window.rttApp.readFile(selectedFile.path).then((content) => { if (active) setPreview(content); });
    return () => { active = false; };
  }, [selectedFile]);

  const graph = useMemo(() => {
    if (!project) return { nodes: [] as AppNode[], edges: [] as Edge[] };
    let nodes: AppNode[] = [];
    let edges: Edge[] = [];
    if (mode === 'files') {
      const isFolder = selectedTreeEntry?.kind === 'directory';
      const folderPrefix = isFolder ? `${selectedId}/` : '';
      const folderFiles = isFolder
        ? project.files.filter((file) => file.relativePath.startsWith(folderPrefix) && !file.relativePath.slice(folderPrefix.length).includes('/'))
        : [];
      const center = project.files.some((file) => file.relativePath === selectedId)
        ? selectedId
        : selectedFunction?.file ?? (!isFolder && selectedTreeEntry?.kind !== 'file' ? project.files[0]?.relativePath : undefined);
      const scopePaths = new Set(folderFiles.map((file) => file.relativePath));
      if (center) scopePaths.add(center);
      const relatedEdges = isFolder
        ? project.fileEdges.filter((edge) => scopePaths.has(edge.from) || scopePaths.has(edge.to)).slice(0, 120)
        : center ? project.fileEdges.filter((edge) => edge.from === center || edge.to === center).slice(0, 120) : [];
      const visiblePaths = new Set([...scopePaths, ...relatedEdges.flatMap((edge) => [edge.from, edge.to])]);
      const visibleFiles = project.files.filter((file) => visiblePaths.has(file.relativePath));
      nodes = visibleFiles.map((file) => ({ id: file.relativePath, type: 'map', data: { label: relativeLabel(file.relativePath), sub: file.relativePath, kind: 'file', active: file.relativePath === center || scopePaths.has(file.relativePath) }, position: { x: 0, y: 0 } }));
      const nodeIds = new Set(nodes.map((node) => node.id));
      edges = relatedEdges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).map((edge, index) => ({ id: `file-${index}`, source: edge.from, target: edge.to, animated: false, style: { stroke: '#96a4bd', strokeWidth: 1.5 } }));
    } else if (mode === 'calls') {
      let visible = project.definitions;
      const relationByKey = new Map<string, GraphNodeData['relation']>();
      if (selectedFunction) {
        const selectedKey = `${selectedFunction.file}::${selectedFunction.name}`;
        relationByKey.set(selectedKey, 'focus');
        const incoming = project.functionEdges.filter((edge) => edge.to === selectedKey && edge.from !== selectedKey);
        const outgoing = project.functionEdges.filter((edge) => edge.from === selectedKey && edge.to !== selectedKey);
        for (const edge of (showAllUpstream ? incoming : incoming.slice(0, 12))) {
          relationByKey.set(edge.from, relationByKey.has(edge.from) ? 'both' : 'upstream');
        }
        for (const edge of (showAllDownstream ? outgoing : outgoing.slice(0, 12))) {
          relationByKey.set(edge.to, relationByKey.has(edge.to) ? 'both' : 'downstream');
        }
        visible = project.definitions.filter((fn) => relationByKey.has(`${fn.file}::${fn.name}`));
      } else visible = [];
      visible = visible.slice(0, 60);
      const nodeIds = new Set(visible.map((fn) => `${fn.file}::${fn.name}`));
      nodes = visible.map((fn) => { const id = `${fn.file}::${fn.name}`; return { id, type: 'map', data: { label: fn.name, sub: fn.file, kind: 'function', active: selectedId === id, confidence: '可能调用', relation: relationByKey.get(id), summary: functionSummaries[id] }, position: { x: 0, y: 0 } }; });
      const selectedKey = selectedFunction ? `${selectedFunction.file}::${selectedFunction.name}` : '';
      edges = project.functionEdges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to) && (!selectedFunction || edge.from === selectedKey || edge.to === selectedKey)).map((edge, index) => ({ id: `call-${index}`, source: edge.from, target: edge.to, label: '≈', labelStyle: { fill: '#9a6b20', fontWeight: 700 }, labelBgStyle: { fill: '#fff7e5' }, style: { stroke: '#9eacc4', strokeWidth: 1.6 } }));
    } else {
      const changed = new Set([...(gitInfo?.changedSymbols ?? []), ...(gitInfo?.impactedSymbols ?? [])]);
      const visible = project.definitions.filter((fn) => changed.has(`${fn.file}::${fn.name}`)).slice(0, 220);
      const ids = new Set(visible.map((fn) => `${fn.file}::${fn.name}`));
      nodes = visible.map((fn) => { const id = `${fn.file}::${fn.name}`; return { id, type: 'map', data: { label: fn.name, sub: fn.file, kind: 'function', active: selectedId === id, summary: functionSummaries[id] }, position: { x: 0, y: 0 } }; });
      edges = project.functionEdges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge, index) => ({ id: `git-${index}`, source: edge.from, target: edge.to, style: { stroke: '#b36a42', strokeWidth: 1.8 } }));
    }
    return { nodes: layout(nodes, edges), edges };
  }, [project, mode, selectedId, selectedFunction, selectedFolder, selectedTreeEntry, gitInfo, showAllUpstream, showAllDownstream, functionSummaries]);

  const fitGraph = useCallback(() => {
    void reactFlowRef.current?.fitView({ padding: 0.18, minZoom: 0.08, maxZoom: 1.6, duration: 180 });
  }, []);
  const graphNodeIds = graph.nodes.map((node) => node.id).join('\u0000');
  useEffect(() => {
    if (!graphNodeIds || !reactFlowRef.current) return;
    const frame = window.requestAnimationFrame(() => fitGraph());
    return () => window.cancelAnimationFrame(frame);
  }, [fitGraph, graphNodeIds]);

  useEffect(() => {
    if (mode !== 'calls' || !selectedFunction || !reactFlowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const instance = reactFlowRef.current;
      if (!instance) return;
      void instance.fitView({ padding: 0.2, minZoom: 0.08, maxZoom: 1.2, duration: 0 }).then(() => {
        const node = instance.getNode(selectedId);
        if (!node) return;
        const nodeWidth = node.data.summary ? 260 : 230;
        const nodeHeight = node.data.summary ? 118 : 64;
        instance.setCenter(node.position.x + nodeWidth / 2, node.position.y + nodeHeight / 2, { zoom: instance.getZoom(), duration: 220 });
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mode, selectedFunction, selectedId, graphNodeIds]);

  const contextText = useMemo(() => {
    if (!project || !selectedId) return '';
    const key = selectedFunction ? `${selectedFunction.file}::${selectedFunction.name}` : selectedId;
    const related = project.functionEdges.filter((edge) => edge.from === key || edge.to === key).slice(0, 20);
    const code = selectedFunction?.body ?? preview.slice(0, 12000);
    return [`工程：${project.projectName}`, `目标：${key}`, '相关调用关系：', ...related.map((edge) => `${edge.from} → ${edge.to}（${edge.confidence}）`), '', '源码：', code].join('\n');
  }, [project, selectedId, selectedFunction, preview]);

  const handleAnalyze = async () => {
    if (!project || !selectedId) { notify('请先在图谱中选择一个函数或文件。'); return; }
    if (!contextConfirmed) { setContextOpen(true); notify('请先预览并确认要发送给 LLM 的上下文。'); return; }
    setAnalyzing(true); setAiError(''); setAiResult('');
    try {
      const result = await window.rttApp.analyzeWithLlm({ prompt: aiPrompt, context: contextText });
      setAiResult(result.text);
    } catch (error) { setAiError(error instanceof Error ? error.message : '分析失败，请检查模型配置。'); }
    finally { setAnalyzing(false); }
  };

  const analyzeFunctionPurpose = async () => {
    if (!selectedFunction) { notify('请先搜索并选择一个函数。'); return; }
    const key = `${selectedFunction.file}::${selectedFunction.name}`;
    if (!settings.keyConfigured) {
      setFunctionSummaryError('请先配置 LLM 服务和 API Key。');
      await editSettings();
      return;
    }
    setFunctionSummaryLoading(true);
    setFunctionSummaryError('');
    setFunctionSummary('');
    const requestId = ++functionSummaryRequestRef.current;
    const targets = [...new Set([
      key,
      ...graph.nodes.filter((node) => node.data.kind === 'function').map((node) => node.id),
    ])].map((id) => project?.definitions.find((fn) => `${fn.file}::${fn.name}` === id)).filter((fn): fn is NonNullable<typeof fn> => Boolean(fn));
    const batches: typeof targets[] = [];
    for (let index = 0; index < targets.length; index += 6) batches.push(targets.slice(index, index + 6));
    setFunctionSummaryProgress({ complete: 0, total: targets.length });
    let completedCount = 0;
    let missingCount = 0;
    try {
      for (const [batchIndex, batch] of batches.entries()) {
        if (functionSummaryRequestRef.current !== requestId) return;
        const entries = batch.map((fn, index) => {
          const targetIndex = batchIndex * 6 + index;
          const targetId = `${fn.file}::${fn.name}`;
          const role = targetId === key ? '当前选中函数' : project?.functionEdges.some((edge) => edge.to === key && edge.from === targetId) ? '上游调用者' : '下游被调用函数';
          const body = fn.body.trim().slice(0, targetId === key ? 3200 : 2000);
          const relations = project?.functionEdges.filter((edge) => edge.from === targetId || edge.to === targetId).slice(0, 8).map((edge) => `${edge.from} → ${edge.to}`).join('\n') || '未发现明确上下游';
          return `[[F${targetIndex}]] ${fn.file}:${fn.line} ${fn.name}（${role}）\n调用关系：\n${relations}\n源码：\n${body || '未提取到函数体'}`;
        });
        const result = await window.rttApp.analyzeWithLlm({
          prompt: '你是嵌入式 C 代码分析助手。请分别解释下面每个函数在当前调用链中的作用，依据对应源码分析，不要猜测。每个函数只写一句简体中文短注释，建议 20 到 45 个汉字。严格按给出的标记逐行输出，例如 [[F0]] 初始化 UART 并启动接收中断。必须覆盖所有标记，不要合并函数，也不要输出其他内容。',
          context: entries.join('\n\n').slice(0, 24000),
        });
        if (functionSummaryRequestRef.current !== requestId) return;
        const parsed = parseFunctionSummaryLines(result.text);
        const updates: Record<string, string> = {};
        batch.forEach((fn, index) => {
          const summary = parsed[`F${batchIndex * 6 + index}`];
          if (!summary) { missingCount += 1; return; }
          const targetId = `${fn.file}::${fn.name}`;
          updates[targetId] = summary;
          if (targetId === key) setFunctionSummary(summary);
        });
        if (Object.keys(updates).length) setFunctionSummaries((current) => ({ ...current, ...updates }));
        completedCount += batch.length;
        setFunctionSummaryProgress({ complete: completedCount, total: targets.length });
      }
      if (missingCount) setFunctionSummaryError(`${missingCount} 个函数没有生成注释，请重试分析。`);
    } catch (error) {
      if (functionSummaryRequestRef.current === requestId) setFunctionSummaryError(error instanceof Error ? error.message : '函数分析失败，请检查 LLM 配置。');
    } finally {
      if (functionSummaryRequestRef.current === requestId) setFunctionSummaryLoading(false);
    }
  };

  const openSelectedInVscode = async () => {
    if (!selectedFile) return;
    const result = await window.rttApp.openInEditor(selectedFile.path, selectedFunction?.line ?? 1);
    if (!result.ok) notify(result.reason ?? '无法打开 VS Code');
  };

  const editSettings = async () => {
    const updated = await window.rttApp.getSettings();
    setSettings({ ...updated, apiKey: '' });
    setSettingsOpen(true);
  };

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await window.rttApp.saveSettings(settings);
      const updated = await window.rttApp.getSettings();
      setSettings({ ...updated, apiKey: '' });
      setEditorPath(updated.vscodePath || (await window.rttApp.detectEditor()).path);
      setSettingsOpen(false); notify('设置已保存');
    } catch (error) { notify(error instanceof Error ? error.message : '保存设置失败'); }
  };

  const navigateToFunction = (id: string) => {
    setFunctionTrail((trail) => {
      const prefix = trail.slice(0, functionTrailIndex + 1);
      if (prefix.at(-1) === id) return prefix;
      return [...prefix, id];
    });
    setFunctionTrailIndex((index) => {
      const prefix = functionTrail.slice(0, index + 1);
      return prefix.at(-1) === id ? prefix.length - 1 : prefix.length;
    });
    setSelectedId(id);
    setShowAllUpstream(false);
    setShowAllDownstream(false);
  };
  const moveFunctionTrail = (offset: -1 | 1) => {
    const nextIndex = functionTrailIndex + offset;
    const nextId = functionTrail[nextIndex];
    if (!nextId) return;
    setFunctionTrailIndex(nextIndex);
    setSelectedId(nextId);
    setShowAllUpstream(false);
    setShowAllDownstream(false);
  };
  const selectNode = (_: unknown, node: Node) => {
    if (mode === 'calls') navigateToFunction(node.id);
    else setSelectedId(node.id);
  };
  const selectTreeFile = (entry: ProjectTreeEntry) => {
    if (mode === 'calls') {
      const fileDefinitions = project?.definitions.filter((fn) => fn.file === entry.relativePath) ?? [];
      const preferred = fileDefinitions.find((fn) => fn.name === 'main') ?? fileDefinitions[0];
      if (preferred) {
        navigateToFunction(`${preferred.file}::${preferred.name}`);
        return;
      }
    }
    setSelectedId(entry.relativePath);
  };
  const selectSearchFunction = (fn: ProjectIndex['definitions'][number]) => {
    navigateToFunction(`${fn.file}::${fn.name}`);
    setExpandedFolders((previous) => new Set([...previous, ...parentFolderPaths(fn.file)]));
    setMode('calls');
    setTab('detail');
    setFunctionSearchOpen(false);
  };
  const handleFunctionSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && functionSearchResults.length) {
      event.preventDefault();
      setFunctionSearchOpen(true);
      setFunctionSearchIndex((index) => (index + 1) % functionSearchResults.length);
    } else if (event.key === 'ArrowUp' && functionSearchResults.length) {
      event.preventDefault();
      setFunctionSearchIndex((index) => (index - 1 + functionSearchResults.length) % functionSearchResults.length);
    } else if (event.key === 'Enter' && functionSearchResults.length) {
      event.preventDefault();
      selectSearchFunction(functionSearchResults[functionSearchIndex]?.fn ?? functionSearchResults[0].fn);
    } else if (event.key === 'Escape') {
      setFunctionSearchOpen(false);
    }
  };
  const renderFileTree = (entries: ProjectTreeEntry[], depth = 0): ReactNode => entries.map((entry) => {
    const indent = 8 + depth * 15;
    if (entry.kind === 'directory') {
      const expanded = expandedFolders.has(entry.relativePath);
      return <div key={entry.relativePath}>
        <button className={`tree-row folder-row ${selectedId === entry.relativePath ? 'active' : ''}`} style={{ paddingLeft: indent }} title={entry.relativePath} onClick={() => { setSelectedId(entry.relativePath); setExpandedFolders((previous) => { const next = new Set(previous); expanded ? next.delete(entry.relativePath) : next.add(entry.relativePath); return next; }); }}>
          {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>} {expanded ? <FolderOpen size={14}/> : <Folder size={14}/>}<span>{entry.name}</span>
        </button>
        {expanded && entry.children && entry.children.length > 0 && renderFileTree(entry.children, depth + 1)}
      </div>;
    }
    return <button key={entry.relativePath} className={`tree-row file-row ${selectedId === entry.relativePath || selectedFunction?.file === entry.relativePath ? 'active' : ''}`} style={{ paddingLeft: indent + 28 }} title={entry.relativePath} onClick={() => selectTreeFile(entry)}><FileCode2 size={14}/><span>{entry.name}</span></button>;
  });
  const recent = recentProjects;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Network size={18} /></div><div><strong>RTT 源码图谱</strong><small>看懂 RT-Thread 工程，从关系开始</small></div></div>
      <div className="topbar-center">
        {project ? <><span className="project-dot"/><span className="project-name">{project.projectName}</span><span className="path-pill" title={project.root}>{project.root}</span></> : <span className="idle-label">本地代码分析 · 数据留在你的电脑</span>}
      </div>
      <div className="top-actions">
        {project && <button className="button subtle small" onClick={openProject}><FolderOpen size={15}/>切换工程</button>}
        <button className="icon-button" title="设置" onClick={() => void editSettings()}><Settings2 size={18}/></button>
        <div className="avatar">R</div>
      </div>
    </header>

    {!project ? <main className="welcome">
      <div className="welcome-content">
        <div className="eyebrow">RTT 源码图谱</div>
        <h1>打开代码文件夹<span>开始查看</span></h1>
        <p>选择本机的 C/C++ 工程，查看文件依赖和函数调用关系。</p>
        <button className="button primary open-project" onClick={() => void openProject()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18}/> : <FolderOpen size={18}/>}打开文件夹</button>
        <section className="environment-card" aria-label="本机环境设置">
          <div className="environment-head"><strong>本机环境</strong><button className="text-button" onClick={() => void editSettings()}>其他设置</button></div>
          <div className="environment-row"><div className={`environment-status ${editorPath ? 'ready' : ''}`}><SquareArrowOutUpRight size={16}/></div><div className="step-copy"><strong>VS Code</strong><small>{editorPath || '尚未配置；一键查找本机安装路径'}</small></div><button className="button subtle small" onClick={() => void autoConfigureEditor()} disabled={configuringEditor}>{configuringEditor ? <LoaderCircle className="spin" size={14}/> : <Settings2 size={14}/>}一键配置</button></div>
          <div className="environment-row"><div className={`environment-status ${settings.keyConfigured ? 'ready' : ''}`}><Bot size={16}/></div><div className="step-copy"><strong>AI 分析 <em>可选</em></strong><small>{settings.keyConfigured ? `已配置 ${settings.model || '模型'}` : '不配置也可以浏览和分析代码图谱'}</small></div><button className="text-button" onClick={() => void editSettings()}>{settings.keyConfigured ? '修改模型' : '配置模型'}</button></div>
        </section>
        {recent.length > 0 && <div className="recent-box"><div className="recent-head">最近打开 <span>{recent.length}</span></div>{recent.map((item) => <button key={item.path} className="recent-item" onClick={() => void reopenProject(item.path)}><Folder size={15}/><span><strong>{item.name}</strong><small>{item.path}</small></span><ChevronRight size={15}/></button>)}</div>}
      </div>
    </main> : <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-section"><div className="section-title">分析视图 <ChevronDown size={14}/></div>
          <button className={`nav-item ${mode === 'calls' ? 'selected' : ''}`} onClick={() => setMode('calls')}><Waypoints size={16}/><span>函数调用图</span><span className="nav-count">{project.definitions.length}</span></button>
          <button className={`nav-item ${mode === 'files' ? 'selected' : ''}`} onClick={() => setMode('files')}><Network size={16}/><span>文件依赖</span><span className="nav-count">{project.files.length}</span></button>
          <button className={`nav-item ${mode === 'git' ? 'selected' : ''}`} onClick={() => setMode('git')}><GitCompareArrows size={16}/><span>Git 影响</span>{gitInfo?.isRepo && <span className="change-dot"/>}</button>
        </div>
        <div className="sidebar-section file-section"><div className="section-title">工程目录<span>{countTreeFiles(project.tree)}</span></div>
          <div className="function-search-container">
            <div className="function-search-control"><Search size={14}/><input value={functionSearch} placeholder="搜索函数…" aria-label="搜索函数" aria-expanded={functionSearchOpen && Boolean(functionSearch.trim())} onFocus={() => setFunctionSearchOpen(Boolean(functionSearch.trim()))} onChange={(event) => { setFunctionSearch(event.target.value); setFunctionSearchIndex(0); setFunctionSearchOpen(true); }} onKeyDown={handleFunctionSearchKeyDown}/>{functionSearch && <button title="清除搜索" onClick={() => { setFunctionSearch(''); setFunctionSearchOpen(false); }}><X size={13}/></button>}</div>
            {functionSearchOpen && functionSearch.trim() && <div className="function-search-results" role="listbox">{functionSearchResults.length ? functionSearchResults.map(({ fn }, index) => <button key={`${fn.file}::${fn.name}::${fn.line}`} role="option" aria-selected={index === functionSearchIndex} className={index === functionSearchIndex ? 'active' : ''} onMouseEnter={() => setFunctionSearchIndex(index)} onClick={() => selectSearchFunction(fn)}><strong>{fn.name}</strong><small>{fn.file}:{fn.line}</small></button>) : <div className="function-search-empty">没有匹配的函数</div>}</div>}
          </div>
          <div className="project-tree">{renderFileTree(project.tree)}</div>
        </div>
        <div className="sidebar-foot"><div className="analysis-state"><span className="online-dot"/>本地分析就绪</div><button onClick={() => void editSettings()}><Settings2 size={14}/>模型与编辑器设置</button></div>
      </aside>

      <main className="main-panel">
        <div className="view-toolbar"><div className="crumbs"><span>工程</span><ChevronRight size={13}/><strong>{mode === 'calls' ? '函数调用图' : mode === 'files' ? '文件依赖图' : 'Git 影响分析'}</strong></div><div className="toolbar-right"><div className="view-switch"><button className={mode === 'calls' ? 'active' : ''} onClick={() => setMode('calls')} title="函数调用"><Waypoints size={15}/></button><button className={mode === 'files' ? 'active' : ''} onClick={() => setMode('files')} title="文件依赖"><Network size={15}/></button></div><button className="icon-button compact" onClick={fitGraph} title="适配画布"><Maximize2 size={15}/></button><button className="icon-button compact" onClick={() => void openSelectedInVscode()} title={editorPath ? '在 VS Code 中打开' : '配置 VS Code'}><SquareArrowOutUpRight size={15}/></button><button className="icon-button compact" onClick={() => project && void window.rttApp.analyzeProject(project.root).then(setProject)} title="重新扫描"><Activity size={15}/></button></div></div>
        {mode === 'calls' && project.warnings.length > 0 && <div className="warning-banner"><AlertTriangle size={15}/><span>{project.warnings[0]}</span><button onClick={() => setSettingsOpen(true)}><CircleHelp size={14}/></button></div>}
        <div className="graph-caption"><div><h2>{mode === 'calls' ? '调用关系' : mode === 'files' ? '文件依赖关系' : '变更影响范围'}</h2><p>{mode === 'calls' ? selectedFunction ? `当前函数：${selectedFunction.name}；上游 ${selectedCallNeighborCounts.upstream}，下游 ${selectedCallNeighborCounts.downstream}。` : selectedFolder ? '搜索并选择一个函数查看局部调用关系；展开子文件夹可继续缩小搜索范围。' : '搜索并选择函数后查看局部调用关系。' : mode === 'files' ? selectedFolder ? '显示当前文件夹层级的文件及其 include 关系；展开子文件夹继续浏览。' : '显示当前文件的直接 include 关系；切换文件后图谱会同步更新。' : gitInfo?.isRepo ? '基于本地改动和调用关系计算受影响的函数。' : gitInfo?.error ?? '该目录还不是 Git 仓库。'}</p></div><div className="graph-legend"><span><i className="legend-node"/>函数 / 文件</span>{mode === 'calls' && selectedFunction ? <><span className="relation-legend"><i className="focus"/>当前函数</span><span className="relation-legend"><i className="upstream"/>上游</span><span className="relation-legend"><i className="downstream"/>下游</span></> : mode !== 'files' && <span><i className="legend-line"/>调用方向</span>}{mode === 'calls' && <span><b>≈</b>近似关系</span>}</div></div>
        {mode === 'calls' && selectedFunction && <div className="call-navigation-bar">
          <div className="call-trail-controls"><button className="trail-button" onClick={() => moveFunctionTrail(-1)} disabled={functionTrailIndex <= 0} title="返回上一个函数">←</button><button className="trail-button" onClick={() => moveFunctionTrail(1)} disabled={functionTrailIndex >= functionTrail.length - 1} title="前进到下一个函数">→</button><span className="trail-label">调用路径</span>{functionTrail.map((id, index) => <Fragment key={`${id}-${index}`}><span className="trail-separator">›</span><button className={`trail-item ${index === functionTrailIndex ? 'current' : ''}`} title={id.replace('::', ' · ')} onClick={() => { setFunctionTrailIndex(index); setSelectedId(id); }}>{id.split('::').at(-1)}</button></Fragment>)}</div>
          <div className="call-expand-controls"><button className="expand-relations" disabled={selectedCallNeighborCounts.upstream <= 12} onClick={() => setShowAllUpstream((value) => !value)}>{showAllUpstream ? '收起上游' : `显示全部上游 (${selectedCallNeighborCounts.upstream})`}</button><button className="expand-relations" disabled={selectedCallNeighborCounts.downstream <= 12} onClick={() => setShowAllDownstream((value) => !value)}>{showAllDownstream ? '收起下游' : `显示全部下游 (${selectedCallNeighborCounts.downstream})`}</button></div>
        </div>}
        <div className="graph-canvas">
          {mode === 'git' && !gitInfo?.isRepo ? <div className="empty-canvas"><GitBranch size={26}/><strong>还没有 Git 影响数据</strong><p>请打开一个 Git 仓库，或切换到函数调用图继续浏览。</p><button className="button subtle" onClick={() => setMode('calls')}>返回调用图</button></div> : graph.nodes.length === 0 ? <div className="empty-canvas"><Search size={26}/><strong>{mode === 'calls' && selectedTreeEntry?.kind === 'file' ? '这个文件没有识别到函数定义' : mode === 'calls' ? '搜索并选择一个函数' : '当前目录没有可显示的关系'}</strong><p>{mode === 'calls' && selectedTreeEntry?.kind === 'file' ? '可以在左侧搜索函数，或切换到文件依赖视图查看 include 关系。' : mode === 'calls' ? '在左侧搜索框输入函数名；选择结果后仅显示该函数及有限的上下游关系。' : '展开子文件夹，或选择文件查看直接依赖。'}</p></div> : <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} onInit={(instance) => { reactFlowRef.current = instance; window.requestAnimationFrame(() => void instance.fitView({ padding: 0.18, minZoom: 0.08, maxZoom: 1.6 })); }} onNodeClick={selectNode} onNodeDoubleClick={selectNode} fitView fitViewOptions={{ padding: 0.18, minZoom: 0.08, maxZoom: 1.6 }} minZoom={0.08} maxZoom={1.6} proOptions={{ hideAttribution: true }}><Background color="#dfe5ef" gap={24} size={1}/><Controls position="bottom-left"/><MiniMap position="bottom-right" nodeColor={(node) => node.data.active ? '#3c71cb' : '#b9c8de'} maskColor="rgba(246,248,252,.72)"/></ReactFlow>}
        </div>
        <footer className="graph-footer"><span><Network size={13}/>{graph.nodes.length} 个节点</span><span><ArrowUpRight size={13}/>{graph.edges.length} 条关系</span><span className="footer-spacer"/><span>静态分析 · 结果需结合源码验证</span></footer>
      </main>

      <aside className="inspector">
        <div className="inspector-tabs"><button className={tab === 'detail' ? 'active' : ''} onClick={() => setTab('detail')}><Code2 size={15}/>代码详情</button><button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}><Sparkles size={15}/>AI 分析 <span className="beta-tag">AI</span></button></div>
        {tab === 'detail' ? <div className="detail-pane">
          {selectedFunction ? <><div className="detail-heading"><div className="detail-icon"><Braces size={18}/></div><div><h3>{selectedFunction.name}</h3><p>{selectedFunction.file}:{selectedFunction.line}</p></div></div><button className="source-button" onClick={() => void openSelectedInVscode()}><SquareArrowOutUpRight size={14}/>在 VS Code 中打开<span>{editorPath ? '已发现' : '未配置'}</span></button><section className="function-purpose-card"><div className="purpose-card-head"><div><Sparkles size={14}/><strong>这个函数做什么</strong></div><button className="button subtle small" onClick={() => void analyzeFunctionPurpose()} disabled={functionSummaryLoading}>{functionSummaryLoading ? <LoaderCircle size={13} className="spin"/> : <Sparkles size={13}/>}一键分析</button></div><div className={`purpose-card-body ${functionSummaryError ? 'error' : ''}`}>{functionSummaryLoading ? `正在分析当前函数及上下游（${functionSummaryProgress.complete}/${functionSummaryProgress.total}）…` : functionSummaryError || functionSummary || '点击“一键分析”，让 LLM 结合源码解释当前函数和图中上下游。'}</div></section><div className="detail-block relation-block"><div className="block-title">调用关系 <span>{project.functionEdges.filter((edge) => edge.from === selectedId || edge.to === selectedId).length}</span></div>{project.functionEdges.filter((edge) => edge.from === selectedId || edge.to === selectedId).map((edge, index) => { const outgoing = edge.from === selectedId; return <button key={`${edge.from}-${edge.to}-${index}`} className="relation-row" onClick={() => navigateToFunction(outgoing ? edge.to : edge.from)}><span className={`relation-arrow ${outgoing ? 'down' : ''}`}>{outgoing ? <ArrowUpRight size={13}/> : <ArrowDownLeft size={13}/>}</span><span><small>{outgoing ? '调用' : '被调用'}</small><strong>{(outgoing ? edge.to : edge.from).split('::').at(-1)}</strong><em>{(outgoing ? edge.to : edge.from).split('::')[0]}</em></span><ChevronRight size={14}/></button>; })}{project.functionEdges.filter((edge) => edge.from === selectedId || edge.to === selectedId).length === 0 && <div className="subtle-empty">尚未找到确定的上下游关系</div>}</div><div className="detail-block code-block"><div className="block-title">源码预览 <button onClick={() => void openSelectedInVscode()}>打开 <SquareArrowOutUpRight size={12}/></button></div><pre>{selectedFunction.body.slice(0, 6500).trim() || preview.split('\n').slice(Math.max(0, selectedFunction.line - 2), selectedFunction.line + 40).join('\n')}</pre></div></> : selectedFile ? <><div className="detail-heading"><div className="detail-icon file"><FileCode2 size={18}/></div><div><h3>{relativeLabel(selectedFile.relativePath)}</h3><p>{selectedFile.relativePath}</p></div></div><button className="source-button" onClick={() => void window.rttApp.openInEditor(selectedFile.path, 1)}><SquareArrowOutUpRight size={14}/>在 VS Code 中打开<span>{editorPath ? '已发现' : '未配置'}</span></button><div className="detail-block code-block"><div className="block-title">文件预览</div><pre>{preview.slice(0, 9000)}</pre></div></> : selectedFolder ? <><div className="detail-heading"><div className="detail-icon file"><FolderOpen size={18}/></div><div><h3>{selectedFolder.name}</h3><p>{selectedFolder.relativePath}</p></div></div><div className="detail-block"><div className="block-title">当前层级 <span>{project.files.filter((file) => file.relativePath.startsWith(`${selectedFolder.relativePath}/`) && !file.relativePath.slice(selectedFolder.relativePath.length + 1).includes('/')).length} 个源码文件</span></div><div className="subtle-empty">展开子文件夹继续浏览，选择 C 源文件查看函数和源码。</div></div></> : <div className="inspector-empty"><Code2 size={22}/><span>选择一个函数或文件夹</span><small>这里会显示源码和调用关系</small></div>}
        </div> : <div className="ai-pane">
          <div className="ai-intro"><div className="ai-mark"><Bot size={17}/></div><div><strong>代码分析助手</strong><small>{settings.keyConfigured ? `${settings.provider} · ${settings.model || '模型未配置'}` : '配置模型后开始对话'}</small></div><button className="icon-button compact" title="模型设置" onClick={() => void editSettings()}><Settings2 size={15}/></button></div>
          {!settings.keyConfigured && <div className="setup-card"><div className="setup-icon"><KeyRound size={16}/></div><strong>连接你的模型</strong><p>支持 OpenAI 兼容接口、Anthropic 和 Gemini。密钥加密保存在本机。</p><button className="button subtle small" onClick={() => void editSettings()}>配置 LLM <ChevronRight size={14}/></button></div>}
          <div className="ai-presets"><span>快速提问</span><button onClick={() => setAiPrompt('请用简体中文解释所选函数在这条调用链中的作用。')}>解释调用链</button><button onClick={() => setAiPrompt('请检查所选代码的潜在缺陷、边界情况和并发风险，并说明代码依据。')}>查找潜在问题</button><button onClick={() => setAiPrompt('请为所选函数设计覆盖正常、边界和异常输入的测试用例。')}>生成测试建议</button></div>
          <div className="context-card"><button className="context-toggle" onClick={() => setContextOpen(!contextOpen)}><span><Code2 size={14}/>将发送的上下文</span>{contextOpen ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</button>{contextOpen && <><pre>{contextText || '先选择一个函数或文件。'}</pre><label className="confirm-context"><input type="checkbox" checked={contextConfirmed} onChange={(event) => setContextConfirmed(event.target.checked)}/><span>我已检查上下文，允许发送给所选 LLM</span></label></>}</div>
          <div className="ai-response">{analyzing ? <div className="thinking"><LoaderCircle size={17} className="spin"/>正在分析所选代码…</div> : aiError ? <div className="ai-error"><AlertTriangle size={15}/>{aiError}</div> : aiResult ? <div className="ai-answer"><div className="answer-label"><Sparkles size={13}/>分析结果</div><pre>{aiResult}</pre></div> : <div className="ai-placeholder"><MessageSquareText size={19}/><span>基于图谱上下文提问</span><small>先选中函数，再检查并确认发送内容</small></div>}</div>
          <div className="composer"><textarea value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="描述你想了解的问题…"/><div className="composer-bottom"><span><KeyRound size={12}/>发送前会显示上下文</span><button className="send-button" disabled={analyzing || !aiPrompt.trim()} onClick={() => void handleAnalyze()} title="发送分析"><Send size={15}/></button></div></div>
        </div>}
      </aside>
    </div>}

    {settingsOpen && <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><form className="settings-modal" onSubmit={(event) => void saveSettings(event)}><div className="modal-head"><div><div className="eyebrow">偏好设置</div><h2>模型与编辑器</h2></div><button type="button" className="icon-button" onClick={() => setSettingsOpen(false)}><X size={17}/></button></div>
      <div className="settings-section"><h3><Bot size={15}/>LLM 供应商</h3><label className="field-label">接口协议<select value={settings.provider} onChange={(event) => { const provider = event.target.value; setSettings({ ...settings, provider, baseUrl: provider === 'anthropic' ? 'https://api.anthropic.com' : provider === 'gemini' ? 'https://generativelanguage.googleapis.com' : provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1', model: provider === 'deepseek' ? 'deepseek-flash' : settings.model }); }}><option value="deepseek">DeepSeek</option><option value="openai-compatible">OpenAI 兼容接口</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Google Gemini</option></select></label><div className="field-grid"><label className="field-label">模型名称<input value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} placeholder={settings.provider === 'deepseek' ? 'deepseek-flash' : '例如：gpt-4.1-mini'} required/></label><label className="field-label">API 地址<input value={settings.baseUrl} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} placeholder="支持自定义兼容端点"/></label></div><label className="field-label">API Key<input type="password" value={settings.apiKey ?? ''} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} placeholder={settings.keyConfigured ? '密钥已保存；留空表示保持不变' : '粘贴供应商提供的 API Key'} autoComplete="new-password"/></label><p className="field-help"><KeyRound size={12}/>{settings.keyConfigured ? '密钥已加密保存在本机。' : '密钥仅在本机加密保存，不会写入工程文件。'}</p></div>
      <div className="settings-section"><h3><SquareArrowOutUpRight size={15}/>源码跳转编辑器</h3><label className="field-label">VS Code 可执行文件<input value={settings.vscodePath} onChange={(event) => setSettings({ ...settings, vscodePath: event.target.value })} placeholder={editorPath || '自动检测；也可粘贴 Code.exe 路径'}/></label><div className="field-actions"><span>{editorPath ? '已检测到 VS Code' : '尚未检测到，图谱仍可在应用中浏览'}</span><button type="button" className="text-button" onClick={async () => { const chosen = await window.rttApp.chooseEditor(); if (chosen) { setSettings({ ...settings, vscodePath: chosen }); setEditorPath(chosen); } }}>浏览…</button></div></div>
      <div className="modal-actions"><button type="button" className="button subtle" onClick={() => setSettingsOpen(false)}>取消</button><button type="submit" className="button primary"><Check size={15}/>保存设置</button></div>
    </form></div>}
    {toast && <div className="toast"><Check size={15}/>{toast}</div>}
  </div>;
}
