'use strict';
(async function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  if (!window.hm) {
    // запуск вне Electron (предпросмотр в браузере): подключаем заглушку
    await new Promise((res) => { const s = document.createElement('script'); s.src = 'dev-bridge.js'; s.onload = res; s.onerror = res; document.head.appendChild(s); });
  }
  const hm = window.hm;
  const call = async (action, payload) => {
    const r = await hm.call(action, payload);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const safe = (p) => p.catch((e) => toast(e.message || String(e), true));

  let S = null;
  let logs = [];
  let dismissedError = null;
  let loginShownFor = null;
  let modal = null;

  // ---------- масштаб сцены ----------
  const stage = $('#stage');
  function fit() {
    const k = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    stage.style.transform = `translate(${-640 * k}px, ${-360 * k}px) scale(${k})`;
    if (buddy) buddy.scale = k;
  }
  let buddy = null;
  window.addEventListener('resize', fit);

  // ---------- вспомогательное ----------
  const setHtml = (el, html) => { if (el.__h !== html) { el.__h = html; el.innerHTML = html; } };
  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.style.borderColor = bad ? 'var(--red)' : 'var(--purple)';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }
  const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }); };
  const LOADERS = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Vanilla' };
  const rich = (text) =>
    esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a class="ext" data-url="$1">$1</a>');
  const openUrl = (url) => (url ? safe(call('open', { kind: 'url', url })) : toast('Ссылка пока не настроена', true));

  // ---------- модальные окна ----------
  function openModal({ id, title, body, foot = '', wide = false, bind, update }) {
    closeModal();
    const root = $('#modal-root');
    root.innerHTML = `<div class="backdrop"><div class="modal${wide ? ' wide' : ''}" role="dialog">
      <div class="m-head"><h2>${esc(title)}</h2><button class="m-x" data-close>&#10005;</button></div>
      <div class="m-body scroll">${body}</div>${foot ? `<div class="m-foot">${foot}</div>` : ''}</div></div>`;
    const back = $('.backdrop', root);
    back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); });
    $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeModal));
    modal = { id, update, el: $('.modal', root) };
    if (bind) bind(modal.el);
  }
  function closeModal() {
    $('#modal-root').innerHTML = '';
    modal = null;
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal) closeModal(); });

  // ---------- вход ----------
  function accountList() {
    if (!S.accounts.length) return '<div class="hint">Пока нет сохранённых аккаунтов.</div>';
    return S.accounts.map((a) => `<div class="acc-item${a.id === S.activeId ? ' on' : ''}" data-id="${esc(a.id)}" role="button">
      <span class="radio"></span><span class="nm">${esc(a.name)}</span>
      <span class="badge ${a.type === 'microsoft' ? 'ms' : 'off'}">${a.type === 'microsoft' ? 'Лицензия' : 'Оффлайн'}</span>
      <button class="rm" data-rm="${esc(a.id)}" title="Удалить">&#10005;</button></div>`).join('');
  }
  function openLogin(tab = 'offline') {
    const ms = S.microsoftLogin;
    openModal({
      id: 'login', title: 'Аккаунт',
      body: `${ms ? `<div class="tabs"><button class="tab" data-tab="offline">Оффлайн</button><button class="tab" data-tab="ms">Лицензия Microsoft</button></div>` : ''}
        <div id="tab-offline">
          <p>Введите ник, под которым будете играть на сервере.</p>
          <div class="field"><input type="text" id="nick" maxlength="16" placeholder="Ваш ник" autocomplete="off" spellcheck="false"><button class="pbtn primary" id="nick-ok">Войти</button></div>
          <div class="hint">3–16 символов: латинские буквы, цифры и _</div>
        </div>
        <div id="tab-ms" hidden>
          <p>Войдите учётной записью Microsoft, на которой куплен Minecraft: Java Edition. Пароль вводится на сайте Microsoft — лаунчер его не видит и не хранит.</p>
          <button class="pbtn primary" id="ms-ok">Войти через Microsoft</button>
        </div>
        <div class="err" id="login-err"></div>
        <h3>Сохранённые аккаунты</h3><div class="acc-list" id="acc-list">${accountList()}</div>`,
      update: (el) => { const l = $('#acc-list', el); if (l) setHtml(l, accountList()); },
      bind: (el) => {
        const show = (t) => {
          $('#tab-offline', el).hidden = t !== 'offline';
          $('#tab-ms', el).hidden = t !== 'ms';
          $$('.tab', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
          if (t === 'offline') setTimeout(() => $('#nick', el).focus(), 30);
        };
        $$('.tab', el).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
        show(ms ? tab : 'offline');
        const err = (m) => { $('#login-err', el).textContent = m || ''; };
        const doOffline = async () => {
          try { await call('account:offline', { name: $('#nick', el).value }); closeModal(); } catch (e) { err(e.message); }
        };
        $('#nick-ok', el).addEventListener('click', doOffline);
        $('#nick', el).addEventListener('keydown', (e) => e.key === 'Enter' && doOffline());
        const msb = $('#ms-ok', el);
        if (msb) msb.addEventListener('click', async () => {
          msb.disabled = true; msb.textContent = 'Ждём окно входа…'; err('');
          try { await call('account:ms'); closeModal(); } catch (e) { err(e.message); msb.disabled = false; msb.textContent = 'Войти через Microsoft'; }
        });
        $('#acc-list', el).addEventListener('click', async (e) => {
          const rm = e.target.closest('[data-rm]');
          if (rm) { e.stopPropagation(); return safe(call('account:remove', { id: rm.dataset.rm })); }
          const it = e.target.closest('.acc-item');
          if (it) { await safe(call('account:select', { id: it.dataset.id })); closeModal(); }
        });
      },
    });
  }

  // ---------- настройки ----------
  function openSettings() {
    const s = S.settings;
    const tg = (id, on) => `<button class="toggle${on ? ' on' : ''}" data-tg="${id}"></button>`;
    openModal({
      id: 'settings', title: 'Настройки',
      body: `<div class="set-row"><div class="l">Оперативная память<small>Для сборки с шейдерами и большим числом модов обычно 6–8 ГБ</small></div>
          <input type="range" id="ram" min="${S.limits.minRam}" max="${S.limits.maxRam}" step="256" value="${s.ramMb}"><span class="val" id="ram-v"></span></div>
        <div class="set-row"><div class="l">Заходить на сервер автоматически<small>${esc(S.server.name || 'сервер')}${S.server.address ? ' — ' + esc(S.server.address) : ''}</small></div>${tg('autoJoin', s.autoJoin)}</div>
        <div class="set-row"><div class="l">Полноэкранный режим</div>${tg('fullscreen', s.fullscreen)}</div>
        <div class="set-row"><div class="l">Работать в фоне и сообщать об обновлениях<small>Закрытие окна сворачивает лаунчер в трей</small></div>${tg('tray', s.tray)}</div>
        <div class="set-row"><div class="l">Запускать вместе с системой</div>${tg('autostart', s.autostart)}</div>
        <div class="set-row"><div class="l">Во время игры</div>
          <select id="behavior"><option value="hide">Прятать лаунчер</option><option value="keep">Оставлять открытым</option></select></div>
        <div class="set-row"><div class="l">Путь к Java<small>Пусто — лаунчер сам скачает нужную версию</small></div><input type="text" id="java" style="width:300px" value="${esc(s.javaPath)}" placeholder="автоматически"></div>
        <div class="set-row"><div class="l">Дополнительные аргументы JVM</div><input type="text" id="jvm" style="width:300px" value="${esc(s.jvmArgs)}"></div>
        <div class="row-btns">
          <button class="pbtn" id="s-repair">Проверить файлы сборки</button>
          <button class="pbtn" id="s-game">Папка игры</button>
          <button class="pbtn" id="s-data">Папка лаунчера</button>
        </div>`,
      bind: (el) => {
        const save = (p) => safe(call('settings:set', p));
        const ram = $('#ram', el), rv = $('#ram-v', el);
        const showRam = () => { rv.textContent = (ram.value / 1024).toFixed(1).replace('.0', '') + ' ГБ'; };
        showRam();
        ram.addEventListener('input', showRam);
        ram.addEventListener('change', () => save({ ramMb: +ram.value }));
        $$('[data-tg]', el).forEach((b) => b.addEventListener('click', () => { b.classList.toggle('on'); save({ [b.dataset.tg]: b.classList.contains('on') }); }));
        const bh = $('#behavior', el); bh.value = s.behavior; bh.addEventListener('change', () => save({ behavior: bh.value }));
        $('#java', el).addEventListener('change', (e) => save({ javaPath: e.target.value.trim() }));
        $('#jvm', el).addEventListener('change', (e) => save({ jvmArgs: e.target.value.trim() }));
        $('#s-repair', el).addEventListener('click', () => { closeModal(); safe(call('repair')); toast('Проверяю файлы сборки…'); });
        $('#s-game', el).addEventListener('click', () => call('open', { kind: 'gameDir' }));
        $('#s-data', el).addEventListener('click', () => call('open', { kind: 'dataDir' }));
      },
    });
  }

  // ---------- моды ----------
  async function openMods() {
    const render = (list) => {
      const on = list.filter((m) => m.enabled).length;
      return `<p>Установлено модов: <b>${on}</b> из ${list.length}. Обязательные моды отключить нельзя — без них не получится зайти на сервер.</p>` +
        (list.length ? list.map((m) => `<div class="mod${m.enabled ? '' : ' off'}"><span class="nm" title="${esc(m.file)}">${esc(m.name)}</span>
          ${m.custom ? '<span class="tg">свой</span>' : m.required ? '<span class="tg">обязательный</span>' : ''}
          <button class="toggle${m.enabled ? ' on' : ''}" data-mod="${esc(m.path)}" ${m.optional ? '' : 'disabled'}></button></div>`).join('')
          : '<div class="empty">Моды ещё не установлены. Нажмите «Начать игру» — лаунчер скачает сборку.</div>');
    };
    let list = [];
    try { list = await call('mods:list'); } catch (e) { toast(e.message, true); }
    openModal({
      id: 'mods', title: 'Моды', wide: true, body: `<div id="mods-body">${render(list)}</div>`,
      foot: '<button class="pbtn" id="m-open">Открыть папку модов</button><button class="pbtn primary" data-close>Готово</button>',
      bind: (el) => {
        $('#m-open', el).addEventListener('click', () => call('open', { kind: 'modsDir' }));
        $('#mods-body', el).addEventListener('click', async (e) => {
          const b = e.target.closest('[data-mod]');
          if (!b || b.disabled) return;
          try { list = await call('mods:toggle', { path: b.dataset.mod, enabled: !b.classList.contains('on') }); $('#mods-body', el).innerHTML = render(list); } catch (err) { toast(err.message, true); }
        });
      },
    });
  }

  // ---------- сервер ----------
  const serverBody = () => {
    const st = S.serverStatus, sv = S.server;
    return `<div class="stat-grid">
      <div class="stat"><small>Статус</small><b style="color:${st && st.online ? 'var(--ok)' : 'var(--red2)'}">${st ? (st.online ? 'Онлайн' : 'Недоступен') : 'Проверка…'}</b></div>
      <div class="stat"><small>Игроки</small><b>${st && st.online ? st.players + ' / ' + st.max : '—'}</b></div>
      <div class="stat"><small>Отклик</small><b>${st && st.online ? st.ping + ' мс' : '—'}</b></div>
      <div class="stat"><small>Версия</small><b>${st && st.version ? esc(st.version) : '—'}</b></div></div>
      ${st && st.motd ? `<p class="sel">${esc(st.motd)}</p>` : ''}
      <p>Адрес: <b class="sel">${esc(sv.address || 'не задан')}${sv.address && sv.port && +sv.port !== 25565 ? ':' + esc(sv.port) : ''}</b></p>`;
  };
  function openServer() {
    openModal({
      id: 'server', title: S.server.name || 'Сервер', body: `<div id="srv-body">${serverBody()}</div>`,
      foot: '<button class="pbtn" id="srv-copy">Скопировать адрес</button><button class="pbtn" id="srv-refresh">Обновить</button>',
      update: (el) => setHtml($('#srv-body', el), serverBody()),
      bind: (el) => {
        $('#srv-copy', el).addEventListener('click', () => { const a = S.server; call('copy', { text: a.address + (a.port && +a.port !== 25565 ? ':' + a.port : '') }); toast('Адрес скопирован'); });
        $('#srv-refresh', el).addEventListener('click', () => safe(call('refresh')));
      },
    });
  }

  // ---------- журнал ----------
  function openLogs() {
    openModal({
      id: 'logs', title: 'Журнал', wide: true, body: '<pre class="log scroll" id="logbox"></pre>',
      foot: '<button class="pbtn" id="l-copy">Скопировать для поддержки</button><button class="pbtn" id="l-file">Показать файл</button><button class="pbtn" id="l-stop">Закрыть игру</button>',
      bind: (el) => {
        const box = $('#logbox', el);
        box.textContent = logs.join('\n');
        box.scrollTop = box.scrollHeight;
        $('#l-copy', el).addEventListener('click', async () => { call('copy', { text: await call('diagnostics') }); toast('Скопировано — отправьте это администратору'); });
        $('#l-file', el).addEventListener('click', () => call('open', { kind: 'logFile' }));
        $('#l-stop', el).addEventListener('click', () => call('stop'));
      },
    });
  }
  function appendLog(line) {
    logs.push(line);
    if (logs.length > 1500) logs.shift();
    if (modal && modal.id === 'logs') {
      const box = $('#logbox', modal.el);
      const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
      box.appendChild(document.createTextNode((box.textContent ? '\n' : '') + line));
      if (atEnd) box.scrollTop = box.scrollHeight;
    }
  }

  // ---------- помощь, новости, что нового ----------
  function openHelp() {
    openModal({
      id: 'help', title: 'Помощь',
      body: `<h3>Как начать</h3><p>Войдите в аккаунт (ник для оффлайн-игры или лицензия Microsoft) и нажмите «Начать игру». Первый запуск скачивает Java, Minecraft и сборку — это может занять несколько минут.</p>
        <h3>Игра не запускается</h3><p>Откройте «Журнал» (значок монитора), нажмите «Скопировать для поддержки» и отправьте текст администратору. В настройках можно нажать «Проверить файлы сборки» — лаунчер докачает испорченные файлы.</p>
        <h3>Мало памяти / лагает</h3><p>В «Настройках» увеличьте оперативную память (но оставьте системе хотя бы 2 ГБ).</p>`,
      foot: `${S.links.help ? '<button class="pbtn" id="h-site">Страница помощи</button>' : ''}<button class="pbtn" id="h-copy">Копировать диагностику</button>`,
      bind: (el) => {
        const hs = $('#h-site', el); if (hs) hs.addEventListener('click', () => openUrl(S.links.help));
        $('#h-copy', el).addEventListener('click', async () => { call('copy', { text: await call('diagnostics') }); toast('Диагностика скопирована'); });
      },
    });
  }
  function openNews(id) {
    const n = S.news.find((x) => x.id === id);
    if (!n) return;
    openModal({
      id: 'news', title: n.title,
      body: `${n.image ? `<img class="news-img" src="${esc(n.image)}" alt="">` : ''}<div class="ncard-meta hint">${fmtDate(n.date)}${n.tag ? ' · ' + esc(n.tag) : ''}</div>
        <div class="news-body sel" style="margin-top:10px">${rich(n.text || '')}</div>
        ${n.url ? '<div class="row-btns"><button class="pbtn primary" id="n-url">Подробнее</button></div>' : ''}`,
      bind: (el) => {
        $$('a.ext', el).forEach((a) => a.addEventListener('click', () => openUrl(a.dataset.url)));
        const u = $('#n-url', el); if (u) u.addEventListener('click', () => openUrl(n.url));
      },
    });
    if (n.unread) call('news:read', { ids: [n.id] });
  }
  function openChangelog() {
    const p = S.pack;
    openModal({
      id: 'changelog', title: 'Обновление ' + p.version,
      body: `${p.required ? '<p><b style="color:var(--red2)">Обязательное обновление.</b> Без него не получится зайти на сервер.</p>' : ''}
        <div class="news-body sel">${rich(p.changelog || 'Описание обновления не указано.')}</div>`,
      foot: S.installedVersion && S.updateAvailable ? '<button class="pbtn primary" id="c-up">Обновить сейчас</button>' : '',
      bind: (el) => { const b = $('#c-up', el); if (b) b.addEventListener('click', () => { closeModal(); safe(call('update')); }); },
    });
  }

  // ---------- отрисовка главного экрана ----------
  const busy = () => ['checking', 'updating', 'launching'].includes(S.phase);
  function playState() {
    if (S.phase === 'running') return { label: 'ИГРА ЗАПУЩЕНА', disabled: true };
    if (busy()) return { label: `${(S.progress && S.progress.label) || 'ЗАГРУЗКА'}`.toUpperCase() + (S.progress && S.phase === 'updating' ? ` ${S.progress.pct}%` : ''), disabled: true, pct: S.progress ? S.progress.pct : 0, small: true };
    if (!S.configured) return { label: 'НЕТ АДРЕСА ОБНОВЛЕНИЙ', disabled: true, small: true };
    if (!S.activeId) return { label: 'ВОЙТИ И ИГРАТЬ' };
    if (!S.pack) return { label: S.remote.ok === false && S.remote.checkedAt ? 'НЕТ СВЯЗИ' : 'ПРОВЕРКА…', disabled: true };
    if (!S.installedVersion) return { label: 'УСТАНОВИТЬ И ИГРАТЬ', attn: true };
    if (S.updateAvailable) return { label: 'ОБНОВИТЬ И ИГРАТЬ', attn: true };
    return { label: 'НАЧАТЬ ИГРУ' };
  }

  function render() {
    if (!S) return;
    document.title = S.name;
    $('#ver').textContent = `${S.name} · лаунчер ${S.appVersion}`;

    // подзаголовок
    const p = S.pack;
    let sub = '';
    if (p) sub = `<span>Сборка <b>${esc(p.version)}</b> · Minecraft ${esc(p.minecraft)} · ${esc(LOADERS[p.loader.type] || p.loader.type)}</span>`;
    else if (S.remote.checkedAt && !S.remote.ok) sub = 'Нет связи с сервером обновлений';
    else sub = 'Проверка обновлений…';
    setHtml($('#subtitle'), sub);

    // кнопка «играть»
    const ps = playState();
    const btn = $('#btn-play');
    $('#play-label').textContent = ps.label;
    $('#play-label').style.fontSize = ps.small ? '15px' : '';
    btn.disabled = !!ps.disabled;
    btn.classList.toggle('attn', !!ps.attn);
    btn.classList.toggle('busy', ps.pct != null);
    $('#play-fill').style.width = ps.pct != null ? `calc(${ps.pct}% * 0.9)` : '0';
    $('#btn-mods').disabled = S.phase === 'updating';

    // статус сервера
    const pill = $('#pill'), st = S.serverStatus;
    pill.className = st ? (st.online ? 'on' : 'off') : '';
    $('#pill-text').textContent = st
      ? st.online ? `${S.server.name || 'Сервер'}: ${st.players}/${st.max} онлайн · ${st.ping} мс` : `${S.server.name || 'Сервер'}: недоступен`
      : S.server.address ? 'Проверка сервера…' : (S.server.name || S.name);

    // баннеры
    const bn = [];
    if (S.error && S.error !== 'NEED_LOGIN' && S.error !== dismissedError) bn.push(`<div class="banner error"><span class="t">⚠ ${esc(S.error)}</span><button class="pbtn sm" data-b="dismiss-error">OK</button></div>`);
    if (S.pack && S.installedVersion && S.updateAvailable && !busy() && S.phase !== 'running')
      bn.push(`<div class="banner update"><span class="t">${S.pack.required ? 'Обязательное обновление' : 'Доступно обновление'} сборки: <b>${esc(S.pack.version)}</b></span>
        <button class="pbtn sm ghost" data-b="changelog">Что нового</button><button class="pbtn sm primary" data-b="update">Обновить</button></div>`);
    if (S.announcement) bn.push(`<div class="banner ${S.announcement.level === 'warn' ? 'warn' : ''}"><span class="t">${esc(S.announcement.text)}</span><button class="pbtn sm ghost" data-b="ann">✕</button></div>`);
    if (S.launcherUpdate) bn.push(`<div class="banner"><span class="t">Вышла новая версия лаунчера: <b>${esc(S.launcherUpdate.version)}</b></span><button class="pbtn sm" data-b="launcher">Скачать</button></div>`);
    setHtml($('#banners'), bn.join(''));

    // buddy
    const acc = S.accounts.find((a) => a.id === S.activeId);
    $('#buddy-name').textContent = acc ? acc.name : 'Гость';
    const bd = $('#acc-badge');
    bd.textContent = acc ? (acc.type === 'microsoft' ? 'Лицензия' : 'Оффлайн') : 'Не вошли';
    bd.className = 'badge ' + (acc ? (acc.type === 'microsoft' ? 'ms' : 'off') : '');
    $('#acc-change').textContent = acc ? 'Сменить' : 'Войти';
    const skinKey = (S.activeId || '') + '|' + (S.skin.dataUrl ? S.skin.dataUrl.length + S.skin.dataUrl.slice(-32) : 'default');
    if (buddy && skinKey !== render.skinKey) { render.skinKey = skinKey; buddy.setSkin(S.skin.dataUrl || window.DEFAULT_SKIN); }

    // новости
    const unread = S.news.filter((n) => n.unread).length;
    const nb = $('#news-badge'); nb.hidden = !unread; nb.textContent = unread;
    setHtml($('#news-list'), S.news.length
      ? S.news.map((n) => `<button class="ncard${n.unread ? ' unread' : ''}" data-news="${esc(n.id)}">
          <div class="meta"><span>${fmtDate(n.date)}</span>${n.tag ? `<span class="tag">${esc(n.tag)}</span>` : ''}</div>
          <div class="ttl">${esc(n.title)}</div><div class="txt">${esc((n.text || '').replace(/\*\*/g, ''))}</div></button>`).join('')
      : '<div class="empty">Новостей пока нет</div>');

    // автоматически открываем вход, если нужно
    if (S.error === 'NEED_LOGIN' && loginShownFor !== 'x') { loginShownFor = 'x'; openLogin(); }
    if (S.error !== 'NEED_LOGIN') loginShownFor = null;
    if (modal && modal.update) modal.update(modal.el);
  }

  // ---------- события ----------
  $('#btn-play').addEventListener('click', () => { if (!S.activeId) return openLogin(); safe(call('play')); });
  $('#btn-mods').addEventListener('click', openMods);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-exit').addEventListener('click', () => call('win:quit'));
  $('#w-min').addEventListener('click', () => call('win:min'));
  $('#w-close').addEventListener('click', () => call('win:close'));
  $('#acc-change').addEventListener('click', () => openLogin());
  $('#pill').addEventListener('click', openServer);
  $$('.ib').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'site') openUrl(S.links.site);
    else if (a === 'discord') openUrl(S.links.discord);
    else if (a === 'logs') openLogs();
    else if (a === 'account') openLogin();
    else if (a === 'server') openServer();
    else if (a === 'help') openHelp();
  }));
  $('#news-list').addEventListener('click', (e) => { const c = e.target.closest('[data-news]'); if (c) openNews(c.dataset.news); });
  $('#banners').addEventListener('click', (e) => {
    const b = e.target.closest('[data-b]');
    if (!b) return;
    const k = b.dataset.b;
    if (k === 'update') safe(call('update'));
    else if (k === 'changelog') openChangelog();
    else if (k === 'ann') call('announcement:dismiss');
    else if (k === 'launcher') openUrl(S.launcherUpdate.url);
    else if (k === 'dismiss-error') { dismissedError = S.error; render(); }
  });
  document.addEventListener('contextmenu', (e) => { if (!/INPUT|TEXTAREA/.test(e.target.tagName)) e.preventDefault(); });

  // ---------- запуск ----------
  fit();
  buddy = new window.Buddy($('#buddy-canvas'));
  buddy.scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  hm.on('state', (s) => { S = s; render(); });
  hm.on('log', appendLog);
  const init = await call('init');
  S = init.state;
  logs = init.logs;
  render();
  window.__hm = { get state() { return S; }, openLogin, openSettings, openMods, openServer, openLogs, openHelp, openNews, openChangelog, closeModal };
})();
