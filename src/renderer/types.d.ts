// xterm.js globals loaded via script tags
declare class Terminal {
  cols: number;
  rows: number;
  constructor(options?: Record<string, unknown>);
  loadAddon(addon: unknown): void;
  open(container: HTMLElement): void;
  write(data: string): void;
  clear(): void;
  reset(): void;
  focus(): void;
  dispose(): void;
  onData(callback: (data: string) => void): void;
}

declare namespace FitAddon {
  class FitAddon {
    fit(): void;
  }
}

declare namespace WebLinksAddon {
  class WebLinksAddon {
    constructor(handler?: (event: MouseEvent, url: string) => void);
  }
}

// Preload API exposed via contextBridge
interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
}

type SessionStatus = 'working' | 'needs-input' | 'idle' | 'done';

interface ElectronAPI {
  createSession(): Promise<SessionInfo | null>;
  killSession(id: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  getBuffer(id: string): Promise<string>;
  setActiveSession(id: string): void;
  sendInput(id: string, data: string): void;
  resizeSession(id: string, cols: number, rows: number): void;
  onOutput(callback: (id: string, data: string) => void): void;
  onStateChange(callback: (id: string, state: SessionStatus) => void): void;
  onExit(callback: (id: string, code: number) => void): void;
  onNewSession(callback: () => void): void;
  onSwitchSession(callback: (id: string) => void): void;
  onNavSession(callback: (direction: 'next' | 'prev') => void): void;
  onSplitSession(callback: (direction: 'vertical' | 'horizontal') => void): void;
  openUrl(url: string): Promise<void>;
  correctState(id: string, correctState: string): Promise<void>;
  getLogPath(): Promise<string>;
  createSessionAt(cwd: string, options?: { continue?: boolean }): Promise<SessionInfo | null>;
  saveState(state: string): Promise<void>;
  loadState(): Promise<string | null>;
  getPathForFile(file: File): string;
  onBeforeQuit(callback: () => void): void;
}

interface Window {
  api: ElectronAPI;
}

interface SessionGroup {
  id: string;
  name: string;
  sessionIds: string[];
  collapsed: boolean;
}

interface SavedState {
  sessions: Array<{ id: string; name: string; cwd: string }>;
  groups: SessionGroup[];
  sidebarOrder: Array<{ type: 'session'; id: string } | { type: 'group'; id: string }>;
  groupCounter: number;
  layout?: SerializedLayout;
}

// TerminalWrapper is declared in terminal.ts and loaded via script tag before app.ts
