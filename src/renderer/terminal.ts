class TerminalWrapper {
  private container: HTMLElement;
  private terminal: Terminal;
  private fitAddon: FitAddon.FitAddon;
  private _resizeObserver: ResizeObserver;
  private onInputCallback: ((sessionId: string, data: string) => void) | null = null;
  private onResizeCallback: ((sessionId: string, cols: number, rows: number) => void) | null = null;

  activeSessionId: string | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

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
      if (this.onInputCallback && this.activeSessionId) {
        this.onInputCallback(this.activeSessionId, data);
      }
    });

    this._resizeObserver = new ResizeObserver(() => this.fit());
    this._resizeObserver.observe(container);

    // File drop: write file paths into the terminal.
    // Listen on document because xterm.js creates internal layers that swallow events.
    document.addEventListener('dragover', (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    document.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      if (!this.onInputCallback || !this.activeSessionId) return;
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const paths = Array.from(files)
        .map(f => (window as any).api.getPathForFile(f) as string)
        .filter(Boolean);
      if (paths.length > 0) {
        this.onInputCallback(this.activeSessionId, paths.join(' '));
      }
    });
  }

  fit(): void {
    try {
      this.fitAddon.fit();
      if (this.onResizeCallback && this.activeSessionId) {
        this.onResizeCallback(this.activeSessionId, this.terminal.cols, this.terminal.rows);
      }
    } catch {
      // Container may not be visible yet
    }
  }

  onResize(callback: (sessionId: string, cols: number, rows: number) => void): void {
    this.onResizeCallback = callback;
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  onInput(callback: (sessionId: string, data: string) => void): void {
    this.onInputCallback = callback;
  }

  switchTo(sessionId: string, buffer: string): void {
    this.activeSessionId = sessionId;
    this.terminal.clear();
    this.terminal.reset();
    if (buffer) {
      this.terminal.write(buffer);
    }
    this.terminal.focus();
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
