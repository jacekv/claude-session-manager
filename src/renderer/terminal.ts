// One TerminalWrapper owns exactly one xterm instance bound to one session.
// The PaneManager creates one wrapper per visible pane. Wrappers are NOT
// responsible for document-level concerns (file drag/drop) — with multiple
// wrappers those listeners would fire once per instance. The PaneManager owns
// any document-level handling.
class TerminalWrapper {
  private container: HTMLElement;
  private terminal: Terminal;
  private fitAddon: FitAddon.FitAddon;
  private _resizeObserver: ResizeObserver;
  private onInputCallback: ((sessionId: string, data: string) => void) | null = null;
  private onResizeCallback: ((sessionId: string, cols: number, rows: number) => void) | null = null;
  private onFocusCallback: ((sessionId: string) => void) | null = null;

  readonly sessionId: string;

  constructor(container: HTMLElement, sessionId: string) {
    this.container = container;
    this.sessionId = sessionId;

    this.terminal = new Terminal({
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: '#45475a',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    const webLinksAddon = new WebLinksAddon.WebLinksAddon((_event: MouseEvent, url: string) => {
      (window as any).api.openUrl(url);
    });
    this.terminal.loadAddon(webLinksAddon);

    this.terminal.open(container);
    this.fit();

    this.terminal.onData((data: string) => {
      if (this.onInputCallback) {
        this.onInputCallback(this.sessionId, data);
      }
    });

    // Notify the manager when this pane gains focus (click / keyboard focus).
    container.addEventListener('focusin', () => {
      if (this.onFocusCallback) this.onFocusCallback(this.sessionId);
    });

    this._resizeObserver = new ResizeObserver(() => this.fit());
    this._resizeObserver.observe(container);
  }

  fit(): void {
    try {
      this.fitAddon.fit();
      if (this.onResizeCallback) {
        this.onResizeCallback(this.sessionId, this.terminal.cols, this.terminal.rows);
      }
    } catch {
      // Container may not be visible yet
    }
  }

  onResize(callback: (sessionId: string, cols: number, rows: number) => void): void {
    this.onResizeCallback = callback;
  }

  onInput(callback: (sessionId: string, data: string) => void): void {
    this.onInputCallback = callback;
  }

  onFocus(callback: (sessionId: string) => void): void {
    this.onFocusCallback = callback;
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  /** Replay a session's scrollback into this pane (used on initial mount). */
  load(buffer: string): void {
    this.terminal.clear();
    this.terminal.reset();
    if (buffer) {
      this.terminal.write(buffer);
    }
    this.fit();
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  focus(): void {
    this.terminal.focus();
  }

  dispose(): void {
    this._resizeObserver.disconnect();
    this.terminal.dispose();
  }
}
