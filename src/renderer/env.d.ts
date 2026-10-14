type ProjectIndex = {
  root: string;
  projectName: string;
  files: Array<{ path: string; relativePath: string }>;
  tree: ProjectTreeEntry[];
  definitions: Array<{ name: string; file: string; line: number; body: string; calls: string[] }>;
  functionEdges: Array<{ from: string; to: string; confidence: '可能调用' | '确定' }>;
  fileEdges: Array<{ from: string; to: string }>;
  warnings: string[];
};
type ProjectTreeEntry = { name: string; path: string; relativePath: string; kind: 'directory' | 'file'; children?: ProjectTreeEntry[] };
type AppSettings = { provider: string; baseUrl: string; model: string; keyConfigured: boolean; vscodePath: string; apiKey?: string };

interface Window {
  rttApp: {
    openProject(): Promise<ProjectIndex | null>;
    analyzeProject(root: string): Promise<ProjectIndex>;
    detectEditor(): Promise<{ path: string | null; candidates: string[] }>;
    chooseEditor(): Promise<string | null>;
    openInEditor(path: string, line: number): Promise<{ ok: boolean; reason?: string }>;
    readFile(path: string): Promise<string>;
    getGitImpact(root: string): Promise<{ isRepo: boolean; changedFiles: string[]; changedSymbols: string[]; impactedSymbols: string[]; error?: string }>;
    getSettings(): Promise<AppSettings>;
    saveSettings(settings: Partial<AppSettings>): Promise<{ ok: boolean }>;
    analyzeWithLlm(input: { prompt: string; context: string }): Promise<{ text: string }>;
  };
}
