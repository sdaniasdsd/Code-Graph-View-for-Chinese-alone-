import { contextBridge, ipcRenderer } from 'electron';

const api = {
  openProject: () => ipcRenderer.invoke('project:open'),
  analyzeProject: (root: string) => ipcRenderer.invoke('project:analyze', root),
  detectEditor: () => ipcRenderer.invoke('editor:detect'),
  chooseEditor: () => ipcRenderer.invoke('editor:set-path'),
  openInEditor: (path: string, line: number) => ipcRenderer.invoke('editor:open', path, line),
  readFile: (path: string) => ipcRenderer.invoke('file:read', path),
  getGitImpact: (root: string) => ipcRenderer.invoke('git:impact', root),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  analyzeWithLlm: (input: unknown) => ipcRenderer.invoke('llm:analyze', input),
};

contextBridge.exposeInMainWorld('rttApp', api);
