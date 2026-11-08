'use strict';
// Заглушка для просмотра интерфейса в обычном браузере (в самом лаунчере не используется).
(function () {
  const q = new URLSearchParams(location.search);
  const scenario = q.get('s') || 'update';
  const listeners = {};
  const state = {
    name: 'ХаусМайн 4', appVersion: '1.0.0', phase: 'idle', progress: null, error: null,
    remote: { ok: true, checkedAt: Date.now() }, configured: true,
    pack: { version: '1.0.1', changelog: '**Что нового**\nДобавлены новые моды и исправлены вылеты.\nПодробности: https://example.com/changelog', required: true, minecraft: '1.20.1', loader: { type: 'fabric', version: '0.15.0' }, files: 120 },
    installedVersion: '1.0.0', updateAvailable: true,
    server: { name: 'ХаусМайн 4', address: 'play.example.com', port: 25565 },
    links: { site: 'https://example.com', discord: 'https://discord.gg/x', help: '' },
    announcement: null, launcherUpdate: null,
    accounts: [{ id: 'offline:steve_test', type: 'offline', name: 'Steve_Test', uuid: 'x' }, { id: 'ms:1', type: 'microsoft', name: 'Notch', uuid: '1' }],
    activeId: 'offline:steve_test', skin: { dataUrl: null, slim: false, source: 'default' },
    news: [
      { id: 'a', date: '2026-11-06T12:00:00Z', tag: 'Обновление', title: 'Вышла сборка 1.0.1', text: 'Добавили новые моды, исправили вылеты и улучшили производительность на слабых компьютерах. Подробности внутри.', unread: true },
      { id: 'b', date: '2026-11-03T12:00:00Z', tag: 'Событие', title: 'Ивент на выходных', text: 'В субботу в 18:00 по МСК — большая охота на дракона. Заходите всей командой! **Призы** ждут победителей.', unread: true },
      { id: 'c', date: '2026-10-28T12:00:00Z', tag: 'Сервер', title: 'Перезапуск сервера', text: 'Сегодня ночью сервер будет недоступен около 15 минут из-за технических работ.', unread: false },
      { id: 'd', date: '2026-10-20T12:00:00Z', title: 'Добро пожаловать', text: 'ХаусМайн 4 открывается!', unread: false },
    ],
    serverStatus: { online: true, players: 12, max: 50, ping: 34, version: '1.20.1', motd: 'ХаусМайн 4 — добро пожаловать!' },
    settings: { ramMb: 4096, jvmArgs: '', javaPath: '', behavior: 'hide', autoJoin: true, fullscreen: false, tray: true, autostart: false },
    limits: { maxRam: 12288, minRam: 1024 }, microsoftLogin: true, dataDir: '/tmp/hm',
  };
  if (scenario === 'noaccount') { state.accounts = []; state.activeId = null; }
  if (scenario === 'install') { state.installedVersion = null; }
  if (scenario === 'uptodate') { state.updateAvailable = false; state.installedVersion = '1.0.1'; }
  if (scenario === 'progress') { state.phase = 'updating'; state.progress = { label: 'Файлы сборки: 34/120', pct: 43 }; }
  if (scenario === 'running') { state.phase = 'running'; state.installedVersion = '1.0.1'; state.updateAvailable = false; }
  if (scenario === 'offline') { state.pack = null; state.remote = { ok: false, checkedAt: 1 }; state.news = []; state.serverStatus = { online: false }; }
  if (q.get('ann')) state.announcement = { id: 'x', text: 'Сегодня в 22:00 технические работы на сервере.', level: 'warn' };
  if (q.get('lu')) state.launcherUpdate = { version: '1.2.0', url: 'https://example.com' };
  if (q.get('err')) state.error = 'Игра завершилась с ошибкой (код 1). Откройте журнал (значок монитора).';
  const emit = (ch, d) => (listeners[ch] || []).forEach((f) => f(d));
  const logs = ['[12:00:01] Лаунчер 1.0.0 запущен', '[12:00:02] Сборка 1.0.0: скачано файлов 120, удалено 0', '[12:00:03] Запуск: java -Xmx4096M ...'];
  window.hm = {
    on(ch, cb) { (listeners[ch] = listeners[ch] || []).push(cb); return () => {}; },
    async call(action, p) {
      switch (action) {
        case 'init': return { ok: true, data: { state, logs } };
        case 'account:offline': state.accounts.push({ id: 'offline:' + p.name, type: 'offline', name: p.name, uuid: 'x' }); state.activeId = 'offline:' + p.name; emit('state', state); return { ok: true };
        case 'account:select': state.activeId = p.id; emit('state', state); return { ok: true };
        case 'settings:set': Object.assign(state.settings, p); return { ok: true };
        case 'mods:list': return { ok: true, data: [
          { path: 'mods/fabric-api.jar', name: 'Fabric API', file: 'fabric-api.jar', enabled: true, optional: false, required: true },
          { path: 'mods/sodium.jar', name: 'Sodium', file: 'sodium.jar', enabled: true, optional: true, required: false },
          { path: 'mods/iris.jar', name: 'Iris Shaders', file: 'iris.jar', enabled: false, optional: true, required: false },
          { path: 'mods/own.jar', name: 'my-minimap', file: 'own.jar', enabled: true, optional: true, custom: true },
        ] };
        case 'play': case 'update':
          state.phase = 'updating';
          for (let i = 0; i <= 10; i++) setTimeout(() => { state.progress = { label: 'Файлы сборки', pct: i * 10 }; if (i === 10) { state.phase = 'idle'; state.installedVersion = state.pack.version; state.updateAvailable = false; } emit('state', state); }, i * 250);
          return { ok: true };
        case 'diagnostics': return { ok: true, data: 'dev' };
        default: return { ok: true, data: null };
      }
    },
  };
})();
