'use strict';
// Проверка электронной «обвязки» (main.js) с поддельным модулем electron: IPC-команды, окна, трей.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { tmpdir } = require('./helpers');

test('main.js: IPC-команды работают, окно и трей создаются', async () => {
  const tmp = tmpdir('main');
  const calls = { windows: 0, trays: 0, sent: [], handlers: {}, appOn: {}, openedExternal: [], loginItem: null };
  class Win {
    constructor() { calls.windows++; this.webContents = { setWindowOpenHandler() {}, on() {}, send: (ch, d) => calls.sent.push(ch) }; }
    loadFile() {} loadURL() {} once() {} on() {} show() {} hide() {} focus() {} close() {} minimize() {} restore() {}
    isMinimized() { return false; } isDestroyed() { return false; }
  }
  const electron = {
    app: {
      getPath: () => tmp, setPath() {}, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
      on: (e, f) => { calls.appOn[e] = f; }, getVersion: () => '1.0.0', quit() {}, setLoginItemSettings: (o) => { calls.loginItem = o; },
    },
    BrowserWindow: Win,
    ipcMain: { handle: (ch, fn) => { calls.handlers[ch] = fn; } },
    Tray: class { constructor() { calls.trays++; } setToolTip() {} setContextMenu() {} on() {} },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (t) => t },
    Notification: class { static isSupported() { return true; } on() {} show() {} },
    nativeImage: { createFromPath: () => ({ resize() { return this; } }) },
    safeStorage: { isEncryptionAvailable: () => false },
    clipboard: { writeText(t) { calls.clip = t; } },
    shell: { openExternal: (u) => calls.openedExternal.push(u), openPath() {}, showItemInFolder() {} },
  };
  const orig = Module._load;
  Module._load = function (req, ...r) { return req === 'electron' ? electron : orig.call(this, req, ...r); };
  process.env.HM_BASE_URL = 'http://127.0.0.1:1/';
  require('../src/main/main.js');
  await new Promise((r) => setTimeout(r, 300));
  Module._load = orig;

  assert.equal(calls.windows, 1);
  assert.equal(calls.trays, 1);
  const ipc = (a, p) => calls.handlers.hm({}, a, p);

  const init = await ipc('init');
  assert.equal(init.ok, true);
  assert.equal(init.data.state.name, 'ХаусМайн 4');
  assert.equal(init.data.state.activeId, null);

  assert.equal((await ipc('account:offline', { name: 'Игрок' })).ok, false);
  assert.equal((await ipc('account:offline', { name: 'Player_1' })).ok, true);
  assert.equal((await ipc('init')).data.state.accounts[0].name, 'Player_1');

  assert.equal((await ipc('settings:set', { ramMb: 2100, autostart: true })).ok, true);
  assert.equal(calls.loginItem.openAtLogin, true);
  assert.equal((await ipc('init')).data.state.settings.ramMb, 2048);

  assert.deepEqual((await ipc('mods:list')).data, []);
  await ipc('open', { kind: 'url', url: 'https://example.com/x' });
  await ipc('open', { kind: 'url', url: 'file:///etc/passwd' });
  await ipc('open', { kind: 'url', url: 'javascript:alert(1)' });
  assert.deepEqual(calls.openedExternal, ['https://example.com/x']);
  assert.match((await ipc('diagnostics')).data, /Лаунчер: 1\.0\.0/);
  assert.equal((await ipc('nope')).ok, false);

  // «играть» без связи с сервером обновлений: понятная ошибка, а не падение
  await ipc('play');
  await new Promise((r) => setTimeout(r, 600));
  const st = (await ipc('init')).data.state;
  assert.match(st.error, /Нет связи/);
  assert.equal(st.phase, 'idle');

  calls.appOn['before-quit'] && calls.appOn['before-quit']();
});
