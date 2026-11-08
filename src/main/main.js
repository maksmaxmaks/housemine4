'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, Notification, nativeImage, safeStorage, clipboard } = require('electron');
const { loadConfig } = require('./config');
const { Launcher } = require('./launcher');

const APP_DIR = path.join(__dirname, '..', '..');
const config = loadConfig(APP_DIR);
const ICON = path.join(__dirname, '..', 'renderer', 'assets', 'app-icon.png');

// все данные — в %APPDATA%\.hausmine4 (или аналог на других ОС)
const dataRoot = path.join(app.getPath('appData'), config.gameFolderName);
app.setPath('userData', path.join(dataRoot, 'electron'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let quitting = false;
let launcher = null;
const startHidden = process.argv.includes('--hidden');

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send('hm:' + channel, data);
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 720, useContentSize: true, resizable: false, maximizable: false, frame: false,
    show: false, backgroundColor: '#120a22', title: config.packName, icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (quitting) return;
    if (launcher.settings.get('tray')) {
      e.preventDefault();
      win.hide();
    } else {
      quitting = true;
    }
  });
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 24, height: 24 }));
    tray.setToolTip(config.packName);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Открыть ' + config.packName, click: showWindow },
        { type: 'separator' },
        { label: 'Выход', click: quit },
      ])
    );
    tray.on('click', showWindow);
  } catch (e) {
    console.error('tray', e);
  }
}

function quit() {
  quitting = true;
  app.quit();
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href);
  } catch {}
}

function openMicrosoftLogin(url, redirect) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 520, height: 700, parent: win, modal: true, autoHideMenuBar: true, title: 'Вход через Microsoft', icon: ICON,
      webPreferences: { partition: 'ms-login-' + Date.now(), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve(code);
      if (!w.isDestroyed()) w.close();
    };
    const check = (u) => {
      if (!u.startsWith(redirect)) return false;
      const q = new URL(u).searchParams;
      finish(q.get('code'));
      return true;
    };
    w.webContents.on('will-redirect', (e, u) => check(u) && e.preventDefault());
    w.webContents.on('will-navigate', (e, u) => check(u) && e.preventDefault());
    w.webContents.on('did-navigate', (_e, u) => check(u));
    w.on('closed', () => finish(null));
    w.loadURL(url);
  });
}

async function handle(action, p) {
  switch (action) {
    case 'init': return { state: launcher.getState(), logs: launcher.logs.slice(-500) };
    case 'play': launcher.play(); return null;
    case 'update': launcher.updatePack(); return null;
    case 'repair': launcher.updatePack({ verify: true }); return null;
    case 'stop': launcher.stopGame(); return null;
    case 'refresh': await launcher.refreshRemote(); launcher.refreshStatus().catch(() => {}); return null;
    case 'account:offline': await launcher.addOffline(p.name); return null;
    case 'account:ms': await launcher.addMicrosoft(); return null;
    case 'account:select': await launcher.selectAccount(p.id); return null;
    case 'account:remove': await launcher.removeAccount(p.id); return null;
    case 'settings:set': launcher.setSettings(p); return null;
    case 'news:read': launcher.markNewsRead(p && p.ids); return null;
    case 'announcement:dismiss': launcher.dismissAnnouncement(); return null;
    case 'mods:list': return launcher.mods();
    case 'mods:toggle': return launcher.setMod(p.path, !!p.enabled);
    case 'logs:get': return launcher.logs.slice(-1500);
    case 'diagnostics': return launcher.diagnostics();
    case 'copy': clipboard.writeText(String(p.text || '')); return null;
    case 'open': {
      const L = launcher.paths;
      if (p.kind === 'url') openExternal(p.url);
      else if (p.kind === 'gameDir') shell.openPath(L.instance);
      else if (p.kind === 'modsDir') shell.openPath(path.join(L.instance, 'mods'));
      else if (p.kind === 'dataDir') shell.openPath(L.root);
      else if (p.kind === 'logFile') shell.showItemInFolder(L.logFile);
      return null;
    }
    case 'win:min': win.minimize(); return null;
    case 'win:close': win.close(); return null;
    case 'win:quit': quit(); return null;
    default: throw new Error('Неизвестное действие: ' + action);
  }
}

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  launcher = new Launcher({
    config,
    root: dataRoot,
    host: {
      appVersion: app.getVersion(),
      safeStorage,
      openMicrosoftLogin,
      notify: (title, body) => {
        if (!Notification.isSupported()) return;
        const n = new Notification({ title, body, icon: ICON });
        n.on('click', showWindow);
        n.show();
      },
    },
  });
  ipcMain.handle('hm', async (_e, action, payload) => {
    try {
      return { ok: true, data: await handle(action, payload || {}) };
    } catch (e) {
      launcher.log('IPC ' + action + ': ' + e.message);
      return { ok: false, error: e.message };
    }
  });
  launcher.on('state', (s) => send('state', s));
  launcher.on('log', (l) => send('log', l));
  launcher.on('game-start', () => {
    if (launcher.settings.get('behavior') === 'hide' && win) win.hide();
  });
  launcher.on('game-exit', () => showWindow());
  launcher.on('settings', (s) => app.setLoginItemSettings({ openAtLogin: !!s.autostart, args: ['--hidden'] }));

  createWindow();
  createTray(); // значок нужен всегда, чтобы можно было вернуть скрытое окно
  await launcher.init();
});

app.on('before-quit', () => {
  quitting = true;
  if (launcher) launcher.dispose();
});
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
