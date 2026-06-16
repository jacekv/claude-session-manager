import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('api', {
  createSession: (): Promise<unknown> => ipcRenderer.invoke('session:create'),
  killSession: (id: string): Promise<void> => ipcRenderer.invoke('session:kill', id),
  listSessions: (): Promise<unknown[]> => ipcRenderer.invoke('session:list'),
  getBuffer: (id: string): Promise<string> => ipcRenderer.invoke('session:buffer', id),
  getCostTotal: (): Promise<{ total: number; month: number }> => ipcRenderer.invoke('cost:total'),

  setActiveSession: (id: string): void => ipcRenderer.send('session:active', id),
  sendInput: (id: string, data: string): void => ipcRenderer.send('session:input', id, data),
  resizeSession: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('session:resize', id, cols, rows),

  onOutput: (callback: (id: string, data: string) => void): void => {
    ipcRenderer.on('session:output', (_, id, data) => callback(id, data));
  },
  onStateChange: (callback: (id: string, state: string) => void): void => {
    ipcRenderer.on('session:state', (_, id, state) => callback(id, state));
  },
  onExit: (callback: (id: string, code: number) => void): void => {
    ipcRenderer.on('session:exit', (_, id, code) => callback(id, code));
  },
  onNewSession: (callback: () => void): void => {
    ipcRenderer.on('new-session', () => callback());
  },
  onSwitchSession: (callback: (id: string) => void): void => {
    ipcRenderer.on('switch-session', (_, id) => callback(id));
  },
  onNavSession: (callback: (direction: 'next' | 'prev') => void): void => {
    ipcRenderer.on('nav-session', (_, direction) => callback(direction));
  },
  onSplitSession: (callback: (direction: 'vertical' | 'horizontal') => void): void => {
    ipcRenderer.on('split-session', (_, direction) => callback(direction));
  },
  onCostUpdate: (callback: (cost: { total: number; month: number }) => void): void => {
    ipcRenderer.on('cost:update', (_, cost) => callback(cost));
  },

  openUrl: (url: string): Promise<void> => ipcRenderer.invoke('open-url', url),
  correctState: (id: string, correctState: string): Promise<void> =>
    ipcRenderer.invoke('session:correct-state', id, correctState),
  getLogPath: (): Promise<string> => ipcRenderer.invoke('session:log-path'),

  createSessionAt: (cwd: string, options?: { continue?: boolean }): Promise<unknown> => ipcRenderer.invoke('session:create-at', cwd, options),
  saveState: (state: string): Promise<void> => ipcRenderer.invoke('state:save', state),
  loadState: (): Promise<string | null> => ipcRenderer.invoke('state:load'),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onSaveAndQuit: (callback: () => Promise<void>): void => {
    ipcRenderer.on('app:save-and-quit', async () => {
      await callback();
      ipcRenderer.send('app:quit-ready');
    });
  },
});
