import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import path from 'path';
import * as pty from 'node-pty';
import StateDetector, { SessionState } from './state-detector';
import TransitionLogger from './transition-logger';

function resolveShellPath(): string {
  try {
    return execSync('zsh -ilc "echo $PATH"', { encoding: 'utf-8' }).trim();
  } catch {
    return process.env.PATH || '';
  }
}

const shellPath = resolveShellPath();

export interface Session {
  id: string;
  name: string;
  cwd: string;
  ptyProcess: pty.IPty;
  status: SessionState;
  buffer: string;
  stateDetector: StateDetector;
}

let nextId = 1;

class SessionManager extends EventEmitter {
  sessions: Map<string, Session> = new Map();
  private transitionLogger: TransitionLogger;

  constructor(userDataPath: string) {
    super();
    this.transitionLogger = new TransitionLogger(userDataPath);
  }

  createSession(cwd: string, options?: { continue?: boolean }): Session {
    const id = String(nextId++);
    const name = path.basename(cwd);

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PATH: shellPath,
      TERM: 'xterm-256color',
    };

    const args: string[] = [];
    if (options?.continue) {
      args.push('--continue');
    }

    const ptyProcess = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
    });

    const stateDetector = new StateDetector(
      (newState: SessionState) => {
        if (newState !== session.status) {
          session.status = newState;
          this.emit('state-change', id, newState);
        }
      },
      (detail) => {
        // Log all non-working transitions
        this.transitionLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: id,
          sessionName: session.name,
          from: detail.from,
          to: detail.to,
          linesExamined: detail.linesExamined,
          matchedPattern: detail.matchedPattern,
          trigger: detail.trigger,
        });
      },
    );

    const session: Session = {
      id,
      name,
      cwd,
      ptyProcess,
      status: 'idle',
      buffer: '',
      stateDetector,
    };

    ptyProcess.onData((data: string) => {
      session.buffer += data;
      // Cap buffer at 1MB to prevent memory issues
      if (session.buffer.length > 1024 * 1024) {
        session.buffer = session.buffer.slice(-512 * 1024);
      }
      this.emit('output', id, data);
      session.stateDetector.feed(data);
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = 'done';
      this.emit('state-change', id, 'done');
      this.emit('exit', id, exitCode);
    });

    this.sessions.set(id, session);
    return session;
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (session && session.status !== 'done') {
      // Newlines = user submitted a command. Any keypress while in needs-input
      // = user answered a permission prompt (y, n, Tab, digit — no newline).
      // Filter out CSI control sequences (mouse clicks, focus events) that xterm
      // sends on terminal interaction — these aren't real prompt responses.
      const hasNewline = data.includes('\r') || data.includes('\n');
      const isPromptResponse = session.status === 'needs-input'
        && !data.startsWith('\x1b[')
        && data !== '';
      if (hasNewline || isPromptResponse) {
        session.stateDetector.markUserInput();
      }
      session.ptyProcess.write(data);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session && session.status !== 'done') session.ptyProcess.resize(cols, rows);
  }

  getBuffer(id: string): string {
    const session = this.sessions.get(id);
    return session ? session.buffer : '';
  }

  getSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  getPids(): number[] {
    return Array.from(this.sessions.values()).map(s => s.ptyProcess.pid);
  }

  correctState(id: string, correctState: SessionState): void {
    const session = this.sessions.get(id);
    if (!session) return;

    const wrongState = session.status;
    this.transitionLogger.logCorrection(id, session.name, wrongState, correctState);

    session.status = correctState;
    this.emit('state-change', id, correctState);
  }

  getTransitionLogPath(): string {
    return this.transitionLogger.getLogPath();
  }

  killSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.stateDetector.dispose();
      session.ptyProcess.kill();
      this.sessions.delete(id);
    }
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      session.stateDetector.dispose();
      session.ptyProcess.kill();
    }
    this.sessions.clear();
  }
}

export default SessionManager;
