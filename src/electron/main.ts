import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { assertProjectDirectory, toProjectRelativePath } from './project-paths';
import { parsePorcelainStatusZ, resolveGitExecutable } from './git-utils';

const execFileAsync = promisify(execFile);
const gitExecutable = () => resolveGitExecutable(app.isPackaged, process.resourcesPath, __dirname, existsSync);
const sourceExtensions = new Set(['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx']);
const skippedDirectories = new Set(['.git', '.svn', '.hg', 'build', 'debug', 'release', 'dist', 'out', 'node_modules', '.venv', 'venv']);
const skippedTreeDirectories = new Set(['.git', '.svn', '.hg', 'node_modules', '.venv', 'venv']);

type SourceFile = { path: string; relativePath: string; content: string };
type ProjectTreeEntry = { name: string; path: string; relativePath: string; kind: 'directory' | 'file'; children?: ProjectTreeEntry[] };
type Settings = { vscodePath?: string; provider?: string; baseUrl?: string; model?: string; encryptedKey?: string };

function settingsPath() { return join(app.getPath('userData'), 'settings.json'); }
function readSettings(): Settings {
  try { return JSON.parse(readFileSync(settingsPath(), 'utf8')) as Settings; } catch { return {}; }
}
function writeSettings(settings: Settings) {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function findVSCodeCandidates(): string[] {
  const env = process.env;
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean) as string[];
  const candidates = [
    ...roots.flatMap((root) => [join(root, 'Programs', 'Microsoft VS Code', 'Code.exe'), join(root, 'Microsoft VS Code', 'Code.exe')]),
  ];
  try {
    const code = execFileSyncWhere('code');
    if (code) {
      const executable = basename(code).toLowerCase() === 'code.exe' ? code : join(dirname(dirname(code)), 'Code.exe');
      if (existsSync(executable)) candidates.unshift(executable);
    }
  } catch { /* PATH lookup can fail; continue with known install locations. */ }
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  for (const key of [
    'HKCU\\Software\\Classes\\Applications\\Code.exe\\shell\\open\\command',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
  ]) {
    const result = spawnSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
    const match = String(result.stdout ?? '').match(/(?:REG_SZ\s+)(?:"([^"]+Code\.exe)"|([^\r\n]+Code\.exe))/i);
    const candidate = match?.[1] ?? match?.[2]?.trim();
    if (candidate && existsSync(candidate)) candidates.unshift(candidate);
  }
  return [...new Set(candidates.filter((path) => existsSync(path)))];
}

function execFileSyncWhere(command: string): string | undefined {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const result = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return undefined;
  return String(result.stdout).split(/\r?\n/).map((item) => item.trim()).find((item) => item && existsSync(item));
}

function collectFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const visit = (directory: string) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name) && !entry.name.startsWith('.')) visit(join(directory, entry.name));
      } else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
        const path = join(directory, entry.name);
        try {
          if (statSync(path).size > 2_000_000) continue;
          files.push({ path, relativePath: toProjectRelativePath(root, path), content: readFileSync(path, 'utf8') });
        } catch { /* Skip unreadable and transient files. */ }
      }
    }
  };
  visit(root);
  return files;
}

function collectProjectTree(root: string): ProjectTreeEntry[] {
  const visit = (directory: string): ProjectTreeEntry[] => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return []; }
    const nodes: ProjectTreeEntry[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const relativePath = toProjectRelativePath(root, path);
      if (entry.isDirectory()) {
        if (skippedTreeDirectories.has(entry.name.toLowerCase())) continue;
        nodes.push({ name: entry.name, path, relativePath, kind: 'directory', children: visit(path) });
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path, relativePath, kind: 'file' });
      }
    }
    return nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
  };
  return visit(root);
}

function cleanForParsing(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (value) => ' '.repeat(value.length))
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (value) => value.replace(/[^\n]/g, ' '));
}

function analyzeProject(root: string) {
  root = assertProjectDirectory(root);
  const files = collectFiles(root);
  const definitions: Array<{ name: string; file: string; line: number; body: string; calls: string[] }> = [];
  const includes: Array<{ from: string; to: string }> = [];
  const knownHeaders = new Map<string, string[]>();

  for (const file of files) {
    knownHeaders.set(basename(file.relativePath).toLowerCase(), [...(knownHeaders.get(basename(file.relativePath).toLowerCase()) ?? []), file.relativePath]);
  }

  for (const file of files) {
    const cleaned = cleanForParsing(file.content);
    const includePattern = /^\s*#\s*include\s*["<]([^">]+)[">]/gm;
    for (const match of file.content.matchAll(includePattern)) {
      const headerName = basename(match[1]).toLowerCase();
      for (const target of knownHeaders.get(headerName) ?? []) includes.push({ from: file.relativePath, to: target });
    }
    const functionPattern = /(?:^|[;{}\n])\s*(?:static\s+|inline\s+|extern\s+|volatile\s+|const\s+|unsigned\s+|signed\s+|long\s+|short\s+|struct\s+\w+\s+|enum\s+\w+\s+|[\w:*&<>]+\s+)+([A-Za-z_]\w*)\s*\(([^;{}()]*(?:\([^()]*\)[^;{}()]*)*)\)\s*(?:__attribute__\s*\(\([^;{}]*\)\)\s*)?\{/gm;
    for (const match of cleaned.matchAll(functionPattern)) {
      const name = match[1];
      if (['if', 'while', 'for', 'switch', 'catch'].includes(name)) continue;
      const openBrace = cleaned.indexOf('{', (match.index ?? 0) + match[0].length - 1);
      let depth = 1;
      let cursor = openBrace + 1;
      for (; cursor < cleaned.length && depth > 0; cursor += 1) {
        if (cleaned[cursor] === '{') depth += 1;
        if (cleaned[cursor] === '}') depth -= 1;
      }
      const body = file.content.slice(openBrace, cursor);
      const bodyClean = cleaned.slice(openBrace, cursor);
      const calls = [...bodyClean.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((call) => call[1]).filter((call) => call !== name && !['if', 'while', 'for', 'switch', 'sizeof', 'return'].includes(call));
      const line = cleaned.slice(0, match.index ?? 0).split('\n').length;
      definitions.push({ name, file: file.relativePath, line, body, calls });
    }
  }

  const defsByName = new Map<string, typeof definitions>();
  for (const definition of definitions) defsByName.set(definition.name, [...(defsByName.get(definition.name) ?? []), definition]);
  const functionEdges: Array<{ from: string; to: string; confidence: '可能调用' | '确定'; }> = [];
  for (const caller of definitions) {
    for (const call of caller.calls) {
      const matches = defsByName.get(call) ?? [];
      for (const callee of matches) {
        functionEdges.push({ from: `${caller.file}::${caller.name}`, to: `${callee.file}::${callee.name}`, confidence: '可能调用' });
      }
    }
  }
  const fileEdges = [...new Map(includes.filter((edge) => edge.from !== edge.to).map((edge) => [`${edge.from}|${edge.to}`, edge])).values()];
  return {
    root,
    files: files.map(({ path, relativePath }) => ({ path, relativePath })),
    tree: collectProjectTree(root),
    definitions,
    functionEdges,
    fileEdges,
    warnings: ['当前版本使用静态语法与符号名匹配；函数指针、宏和同名重载可能影响调用关系准确度。'],
  };
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#f4f6fa',
    title: 'RTT 源码图谱',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  if (!app.isPackaged) await window.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173');
  else await window.loadFile(join(__dirname, '../dist/index.html'));
}

ipcMain.handle('project:open', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const root = resolve(result.filePaths[0]);
  return { ...analyzeProject(root), projectName: basename(root) };
});
ipcMain.handle('project:analyze', async (_event, root: string) => {
  const projectRoot = assertProjectDirectory(resolve(root));
  return { ...analyzeProject(projectRoot), projectName: basename(projectRoot) };
});
ipcMain.handle('editor:detect', () => {
  const settings = readSettings();
  const detected = settings.vscodePath && existsSync(settings.vscodePath) ? settings.vscodePath : findVSCodeCandidates()[0];
  return { path: detected ?? null, candidates: findVSCodeCandidates() };
});
ipcMain.handle('editor:set-path', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Visual Studio Code', extensions: ['exe'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const settings = readSettings();
  settings.vscodePath = result.filePaths[0];
  writeSettings(settings);
  return settings.vscodePath;
});
ipcMain.handle('editor:open', async (_event, filePath: string, line: number) => {
  const settings = readSettings();
  const executable = settings.vscodePath && existsSync(settings.vscodePath) ? settings.vscodePath : findVSCodeCandidates()[0];
  if (executable?.toLowerCase().endsWith('.lnk')) {
    await shell.openPath(executable);
    return { ok: false, reason: '找到了 VS Code 快捷方式，请在设置中选择 Code.exe 以支持精确跳转。' };
  }
  if (!executable) return { ok: false, reason: '没有找到 VS Code，请在设置中指定 Code.exe。' };
  try {
    const child = spawn(executable, ['--goto', `${filePath}:${line}`], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '启动 VS Code 失败。' };
  }
});
ipcMain.handle('file:read', async (_event, filePath: string) => {
  try { return readFileSync(filePath, 'utf8'); } catch { return ''; }
});
ipcMain.handle('git:impact', async (_event, root: string) => {
  try {
    const projectRoot = assertProjectDirectory(root);
    const git = gitExecutable();
    await execFileAsync(git, ['-C', projectRoot, 'rev-parse', '--show-toplevel'], { windowsHide: true });
    const { stdout: status } = await execFileAsync(git, ['-C', projectRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { windowsHide: true, encoding: 'utf8' });
    const changedFiles = parsePorcelainStatusZ(status);
    const changedSymbols = new Set<string>();
    const project = analyzeProject(projectRoot);
    for (const fn of project.definitions) if (changedFiles.includes(fn.file)) changedSymbols.add(`${fn.file}::${fn.name}`);
    const reverse = new Map<string, string[]>();
    for (const edge of project.functionEdges) reverse.set(edge.to, [...(reverse.get(edge.to) ?? []), edge.from]);
    const impacted = new Set<string>();
    const queue = [...changedSymbols];
    while (queue.length) {
      const symbol = queue.shift()!;
      for (const caller of reverse.get(symbol) ?? []) {
        if (!changedSymbols.has(caller) && !impacted.has(caller)) { impacted.add(caller); queue.push(caller); }
      }
    }
    return { isRepo: true, changedFiles, changedSymbols: [...changedSymbols], impactedSymbols: [...impacted] };
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法读取 Git 仓库信息。';
    return { isRepo: false, changedFiles: [], changedSymbols: [], impactedSymbols: [], error: message };
  }
});
ipcMain.handle('settings:get', () => {
  const settings = readSettings();
  return { provider: settings.provider ?? 'openai-compatible', baseUrl: settings.baseUrl ?? '', model: settings.model ?? '', keyConfigured: Boolean(settings.encryptedKey), vscodePath: settings.vscodePath ?? '' };
});
ipcMain.handle('settings:save', (_event, input: Omit<Settings, 'encryptedKey'> & { apiKey?: string }) => {
  const previous = readSettings();
  const settings: Settings = { ...previous, provider: input.provider, baseUrl: input.baseUrl, model: input.model, vscodePath: input.vscodePath || previous.vscodePath };
  if (input.apiKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储暂不可用，密钥未保存。');
    settings.encryptedKey = safeStorage.encryptString(input.apiKey).toString('base64');
  }
  writeSettings(settings);
  return { ok: true };
});
ipcMain.handle('llm:analyze', async (_event, input: { prompt: string; context: string }) => {
  const settings = readSettings();
  if (!settings.encryptedKey) throw new Error('请先在设置中保存 API Key。');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法读取已保存密钥。');
  const apiKey = safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64'));
  const provider = settings.provider ?? 'openai-compatible';
  const model = settings.model?.trim();
  if (!model) throw new Error('请先填写模型名称。');
  const systemPrompt = '你是嵌入式 C/C++ 与 RT-Thread 代码分析助手。优先依据用户给出的源码和调用关系，用简体中文回答；说明证据、推断和不确定性，不要编造未提供的代码。';
  const userPrompt = `用户问题：\n${input.prompt}\n\n已选代码上下文：\n${input.context}`;
  let url = '';
  let headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: Record<string, unknown> = {};
  if (provider === 'anthropic') {
    url = (settings.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
    headers = { ...headers, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    body = { model, max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] };
  } else if (provider === 'gemini') {
    const base = (settings.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    body = { systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: 'user', parts: [{ text: userPrompt }] }], generationConfig: { maxOutputTokens: 4096 } };
  } else {
    const base = (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    url = `${base}/chat/completions`;
    headers.authorization = `Bearer ${apiKey}`;
    body = { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: 0.2 };
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const payload = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(typeof payload.error?.message === 'string' ? payload.error.message : `服务返回 HTTP ${response.status}`);
  const text = provider === 'anthropic' ? payload.content?.map((item: { text?: string }) => item.text ?? '').join('\n') : provider === 'gemini' ? payload.candidates?.[0]?.content?.parts?.map((item: { text?: string }) => item.text ?? '').join('\n') : payload.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('服务没有返回可显示的文本，请检查模型配置。');
  return { text };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
