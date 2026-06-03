import { app, BrowserWindow, Menu, ipcMain, dialog, shell, globalShortcut, IpcMainInvokeEvent, IpcMainEvent } from 'electron';
import os from 'os';
import fs from 'fs';
import path from 'path';
import SessionManager from './src/session-manager';
import NotificationService from './src/notification';

const STATE_FILE = 'session-state.json';

app.name = 'Claude Session Manager';

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
  });

  const appName = 'Claude Session Manager';
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `About ${appName}` },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${appName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${appName}` },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  const win = mainWindow;

  sessionManager = new SessionManager(app.getPath('userData'));
  const notificationService = new NotificationService(sessionManager, win);

  sessionManager.on('output', (sessionId: string, data: string) => {
    if (!win.isDestroyed()) win.webContents.send('session:output', sessionId, data);
  });

  sessionManager.on('state-change', (sessionId: string, state: string) => {
    if (!win.isDestroyed()) win.webContents.send('session:state', sessionId, state);
  });

  sessionManager.on('exit', (sessionId: string, exitCode: number) => {
    if (!win.isDestroyed()) win.webContents.send('session:exit', sessionId, exitCode);
  });

  // Keyboard shortcuts. Handled here (not the renderer) so xterm.js can't swallow them.
  // - Cmd+N (macOS) / Ctrl+N (Linux/Windows): new session
  // - Cmd+Up/Down (macOS) / Ctrl+Shift+Up/Down (Linux/Windows): switch session
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;

    if ((input.meta || input.control) && input.key === 'n') {
      win.webContents.send('new-session');
      return;
    }

    const navModifier = input.meta || (input.control && input.shift);
    if (navModifier && (input.key === 'ArrowUp' || input.key === 'ArrowDown')) {
      win.webContents.send('nav-session', input.key === 'ArrowDown' ? 'next' : 'prev');
    }

    // Cmd+D: split right. Cmd+Shift+D: split down.
    if ((input.meta || input.control) && input.key === 'd') {
      const direction = input.shift ? 'horizontal' : 'vertical';
      win.webContents.send('split-session', direction);
    }
  });

  ipcMain.handle('session:create', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Choose working directory for Claude session',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const cwd = path.resolve(result.filePaths[0]);
    const home = os.homedir();
    const riskyPaths = ['/', '/tmp', '/var', '/etc', '/usr', '/System', '/Applications', home];
    if (riskyPaths.includes(cwd)) {
      dialog.showErrorBox(
        'Invalid directory',
        `"${cwd}" is too broad to use as a working directory. Please choose a specific project folder.`,
      );
      return null;
    }

    const session = sessionManager!.createSession(cwd);
    return { id: session.id, name: session.name, cwd: session.cwd, status: session.status };
  });

  ipcMain.on('session:active', (_event: IpcMainEvent, sessionId: string) => {
    notificationService.setActiveSession(sessionId, win.isFocused());
  });

  win.on('focus', () => {
    notificationService.setWindowFocused(true);
  });

  win.on('blur', () => {
    notificationService.setWindowFocused(false);
  });

  ipcMain.on('session:input', (_event: IpcMainEvent, sessionId: string, data: string) => {
    sessionManager?.write(sessionId, data);
  });

  ipcMain.on('session:resize', (_event: IpcMainEvent, sessionId: string, cols: number, rows: number) => {
    sessionManager?.resize(sessionId, cols, rows);
  });

  ipcMain.handle('session:kill', (_event: IpcMainInvokeEvent, sessionId: string) => {
    sessionManager?.killSession(sessionId);
  });

  ipcMain.handle('session:list', () => {
    return sessionManager!.getSessions().map(s => ({
      id: s.id, name: s.name, cwd: s.cwd, status: s.status,
    }));
  });

  ipcMain.handle('session:buffer', (_event: IpcMainInvokeEvent, sessionId: string) => {
    return sessionManager!.getBuffer(sessionId);
  });

  ipcMain.handle('open-url', (_event: IpcMainInvokeEvent, url: string) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle('session:correct-state', (_event: IpcMainInvokeEvent, sessionId: string, correctState: string) => {
    sessionManager!.correctState(sessionId, correctState as any);
  });

  ipcMain.handle('session:log-path', () => {
    return sessionManager!.getTransitionLogPath();
  });

  // Create session at a specific cwd (no directory picker)
  ipcMain.handle('session:create-at', (_event: IpcMainInvokeEvent, cwd: string, options?: { continue?: boolean }) => {
    if (!fs.existsSync(cwd)) return null;
    const session = sessionManager!.createSession(cwd, options);
    return { id: session.id, name: session.name, cwd: session.cwd, status: session.status };
  });

  // State persistence
  const statePath = path.join(app.getPath('userData'), STATE_FILE);

  ipcMain.handle('state:save', (_event: IpcMainInvokeEvent, state: string) => {
    fs.writeFileSync(statePath, state, 'utf-8');
  });

  ipcMain.handle('state:load', async () => {
    if (!fs.existsSync(statePath)) return null;

    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Restore Sessions', 'Start Fresh'],
      defaultId: 0,
      cancelId: 1,
      title: 'Restore Previous Sessions',
      message: 'A previous session layout was found.',
      detail: 'Would you like to restore your previous sessions and groups?',
    });

    if (response !== 0) {
      fs.unlinkSync(statePath);
      return null;
    }

    try {
      return fs.readFileSync(statePath, 'utf-8');
    } catch {
      return null;
    }
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock?.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  }
  createWindow();
});

app.on('before-quit', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:before-quit');
  }
});

app.on('window-all-closed', () => {
  if (sessionManager) sessionManager.killAll();
  app.quit();
});
