'use strict';
// Ядро лаунчера: состояние, обновления, вход, установка и запуск. Не зависит от Electron —
// всё, что нужно от окна/ОС, приходит через `host`.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const { endpoints: mkEndpoints } = require('./config');
const { makePaths } = require('./paths');
const { fetchJson, JsonStore, cmpVersion, totalMemMb, exists } = require('./util');
const { Accounts, Secrets } = require('./accounts');
const { MicrosoftAuth } = require('./msauth');
const { Minecraft } = require('./mojang');
const { installLoader } = require('./loaders');
const { ensureJava } = require('./java');
const { syncPack, readState, writeState, listMods, toggleMod } = require('./pack');
const { resolveSkin } = require('./skin');
const { pingServer } = require('./status');

const DEFAULT_JVM = '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M';

class Launcher extends EventEmitter {
  // host: { appVersion, safeStorage?, openMicrosoftLogin(url, redirectPrefix) -> Promise<code|null>, notify(title, body) }
  constructor({ config, root, host }) {
    super();
    this.cfg = config;
    this.host = host || {};
    this.ep = mkEndpoints(config);
    this.paths = makePaths(root);
    const maxRam = Math.max(2048, Math.floor((totalMemMb() * 0.75) / 512) * 512);
    this.maxRam = maxRam;
    this.settings = new JsonStore(this.paths.settingsFile, {
      ramMb: Math.min(config.defaultRamMb || 4096, maxRam),
      jvmArgs: '', javaPath: '', behavior: 'hide', autoJoin: true, fullscreen: false,
      tray: true, autostart: false, disabledMods: [], readNews: [], dismissedAnnouncement: '', lastNotified: '',
    });
    this.accounts = new Accounts(this.paths.accountsFile, new Secrets(this.host.safeStorage));
    this.ms = new MicrosoftAuth({ clientId: config.msClientId, endpoints: this.ep });
    this.mc = new Minecraft({ paths: this.paths, endpoints: this.ep, log: (l) => this.log(l) });

    this.manifest = null;
    this.news = [];
    this.remote = { ok: false, error: null, checkedAt: 0 };
    this.installed = null; // { version, ... } из state.json
    this.phase = 'idle'; // idle | checking | updating | launching | running
    this.progress = null;
    this.skin = { dataUrl: null, slim: false, source: 'default' };
    this.serverStatus = null;
    this.lastError = null;
    this.logs = [];
    this.child = null;
    this._timers = [];
    this._emitTimer = null;
  }

  // ---------- служебное ----------
  log(line) {
    const s = String(line).replace(/\r?\n$/, '');
    for (const part of s.split(/\r?\n/)) {
      this.logs.push(part);
      this.emit('log', part);
    }
    if (this.logs.length > 3000) this.logs.splice(0, this.logs.length - 3000);
    try {
      fs.mkdirSync(this.paths.launcherDir, { recursive: true });
      fs.appendFileSync(this.paths.logFile, s + '\n');
    } catch {}
  }
  push() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.emit('state', this.getState());
    }, 60);
  }
  setPhase(phase, progress = null) {
    this.phase = phase;
    this.progress = progress;
    this.push();
  }

  // ---------- состояние для интерфейса ----------
  get server() {
    const m = (this.manifest && this.manifest.server) || {};
    return { ...this.cfg.server, ...m };
  }
  get links() {
    const m = (this.manifest && this.manifest.links) || {};
    return { ...this.cfg.links, ...m };
  }
  get skinsCfg() {
    return { ...this.cfg.skins, ...((this.manifest && this.manifest.skins) || {}) };
  }
  updateAvailable() {
    const p = this.manifest && this.manifest.pack;
    if (!p) return false;
    return !this.installed || !this.installed.version || this.installed.version !== p.version;
  }
  getState() {
    const m = this.manifest;
    const p = (m && m.pack) || null;
    const s = this.settings.data;
    const ann = m && m.announcement;
    const lu = m && m.launcher;
    const readNews = new Set(s.readNews);
    return {
      name: (m && m.name) || this.cfg.packName,
      appVersion: this.host.appVersion || '0.0.0',
      phase: this.phase,
      progress: this.progress,
      error: this.lastError,
      remote: this.remote,
      configured: !!this.cfg.manifestUrl,
      pack: p && {
        version: p.version, changelog: p.changelog || '', required: !!p.required, minecraft: p.minecraft,
        loader: p.loader || { type: 'vanilla' }, files: (p.files || []).length,
      },
      installedVersion: this.installed ? this.installed.version : null,
      updateAvailable: this.updateAvailable(),
      server: this.server,
      links: this.links,
      announcement: ann && ann.text && ann.id !== s.dismissedAnnouncement ? ann : null,
      launcherUpdate: lu && lu.version && cmpVersion(lu.version, this.host.appVersion || '0.0.0') > 0 ? lu : null,
      accounts: this.accounts.list(),
      activeId: this.accounts.activeId(),
      skin: this.skin,
      news: this.news.map((n) => ({ ...n, unread: !readNews.has(n.id) })),
      serverStatus: this.serverStatus,
      settings: { ...s, disabledMods: undefined, readNews: undefined },
      limits: { maxRam: this.maxRam, minRam: 1024 },
      microsoftLogin: !!this.cfg.microsoftLogin,
      dataDir: this.paths.root,
    };
  }

  // ---------- запуск ----------
  async init() {
    await fsp.mkdir(this.paths.launcherDir, { recursive: true });
    this.installed = await readState(this.paths);
    if (!this.installed.version) this.installed = null;
    this.log(`Лаунчер ${this.host.appVersion || ''} запущен. Данные: ${this.paths.root}`);
    // не ждём сеть: интерфейс открывается сразу
    this.refreshRemote().catch(() => {});
    this.refreshSkin().catch(() => {});
    this.refreshStatus().catch(() => {});
    const poll = Math.max(1, this.cfg.pollMinutes || 5) * 60000;
    this._timers.push(setInterval(() => this.phase === 'idle' && this.refreshRemote().catch(() => {}), poll));
    this._timers.push(setInterval(() => this.refreshStatus().catch(() => {}), 60000));
    this._timers.forEach((t) => t.unref && t.unref());
  }
  dispose() {
    this._timers.forEach(clearInterval);
    this.stopGame();
  }

  // ---------- удалённый манифест и новости ----------
  async refreshRemote() {
    if (!this.cfg.manifestUrl) {
      this.remote = { ok: false, error: 'Не задан адрес обновлений (baseUrl)', checkedAt: Date.now() };
      return this.push();
    }
    try {
      const m = await fetchJson(this.cfg.manifestUrl, { bust: true });
      if (!m || !m.pack) throw new Error('В manifest.json нет раздела pack');
      this.manifest = m;
      this.remote = { ok: true, error: null, checkedAt: Date.now() };
      await fsp.writeFile(this.paths.manifestCache, JSON.stringify(m)).catch(() => {});
      try {
        const nurl = new URL(m.newsUrl || 'news.json', this.cfg.manifestUrl).href;
        const n = await fetchJson(nurl, { bust: true });
        this.news = (n.items || []).filter((x) => x && x.id && x.title).slice(0, 50);
        await fsp.writeFile(this.paths.newsCache, JSON.stringify(this.news)).catch(() => {});
      } catch (e) {
        this.log('Новости не загружены: ' + e.message);
      }
      this._notifyIfNeeded();
    } catch (e) {
      this.remote = { ok: false, error: e.message, checkedAt: Date.now() };
      if (!this.manifest) {
        try {
          this.manifest = JSON.parse(await fsp.readFile(this.paths.manifestCache, 'utf8'));
          this.news = JSON.parse(await fsp.readFile(this.paths.newsCache, 'utf8'));
        } catch {}
      }
      this.log('Сервер обновлений недоступен: ' + e.message);
    }
    this.push();
    return this.remote;
  }
  _notifyIfNeeded() {
    const p = this.manifest.pack;
    if (!this.installed || !this.updateAvailable()) return;
    if (this.settings.get('lastNotified') === p.version) return;
    this.settings.set({ lastNotified: p.version });
    if (this.host.notify) {
      this.host.notify(
        `${this.getState().name}: доступно обновление`,
        `Версия сборки ${p.version}${p.required ? ' — обязательное обновление.' : '.'} Откройте лаунчер и нажмите «Обновить».`
      );
    }
  }

  async refreshSkin() {
    this.skin = await resolveSkin(this.accounts.active() && this.accounts.full(this.accounts.activeId()), this.skinsCfg, this.ep);
    this.push();
  }
  async refreshStatus() {
    const s = this.server;
    if (!s.address) return;
    try {
      this.serverStatus = await pingServer(s.address, Number(s.port) || 25565, 4000);
    } catch {
      this.serverStatus = { online: false };
    }
    this.push();
  }

  // ---------- аккаунты ----------
  async addOffline(name) {
    this.accounts.addOffline(name);
    await this.refreshSkin();
  }
  async addMicrosoft() {
    if (!this.host.openMicrosoftLogin) throw new Error('Вход через Microsoft недоступен');
    const code = await this.host.openMicrosoftLogin(this.ms.authUrl(), this.ms.redirect);
    if (!code) throw new Error('Вход отменён');
    const r = await this.ms.loginWithCode(code);
    this.accounts.addMicrosoft(r);
    await this.refreshSkin();
  }
  async selectAccount(id) {
    this.accounts.select(id);
    await this.refreshSkin();
  }
  async removeAccount(id) {
    this.accounts.remove(id);
    await this.refreshSkin();
  }
  async _auth() {
    const acc = this.accounts.active();
    if (!acc) throw new Error('Сначала войдите в аккаунт');
    if (acc.type === 'offline') return { name: acc.name, uuid: acc.uuid, token: '0', type: 'offline' };
    let full = this.accounts.full(acc.id);
    if (!full.mcToken || (full.mcExpires || 0) < Date.now() + 5 * 60000) {
      this.log('Обновляю сессию Microsoft…');
      try {
        const r = await this.ms.refresh(full.msRefresh);
        this.accounts.updateMicrosoft(acc.id, r);
        full = this.accounts.full(acc.id);
      } catch (e) {
        throw new Error('Сессия Microsoft истекла — войдите в аккаунт заново. ' + e.message);
      }
    }
    return { name: full.name, uuid: full.uuid, token: full.mcToken, type: 'microsoft' };
  }

  // ---------- установка ----------
  _stage(stages, i, label, frac) {
    const before = stages.slice(0, i).reduce((a, s) => a + s.w, 0);
    const total = stages.reduce((a, s) => a + s.w, 0);
    const pct = Math.min(100, ((before + stages[i].w * Math.max(0, Math.min(1, frac))) / total) * 100);
    this.setPhase('updating', { label, pct: Math.round(pct) });
  }

  async install({ verify = false } = {}) {
    const m = this.manifest;
    if (!m) throw new Error('Нет данных о сборке. Проверьте подключение к интернету.');
    const pack = m.pack;
    const mcv = pack.minecraft;
    const loader = pack.loader || { type: 'vanilla' };
    const stages = [{ w: 10 }, { w: 35 }, { w: 10 }, { w: 45 }];
    const frac = (p) => (p.total ? p.done / p.total : 1);
    const st = await readState(this.paths);

    // 1. Java
    this._stage(stages, 0, 'Подготовка Java', 0);
    let javaPath = this.settings.get('javaPath');
    if (!javaPath) {
      const major = pack.java || (await this.mc.javaMajor(mcv));
      javaPath = await ensureJava({
        major, runtimeDir: this.paths.runtime, cacheDir: this.paths.cacheDir, endpoints: this.ep,
        log: (l) => this.log(l), onProgress: (p) => this._stage(stages, 0, p.label, frac(p)),
      });
    }
    // 2. Minecraft
    await this.mc.ensureFiles(mcv, (p) => this._stage(stages, 1, p.label, frac(p)));
    // 3. загрузчик
    this._stage(stages, 2, 'Загрузчик модов', 0);
    let versionId = mcv;
    const same = st.loader && st.loader.type === loader.type && st.loader.version === (loader.version || '') && st.loader.mc === mcv;
    if (same && (await exists(path.join(this.mc.versionsDir(st.loader.id), st.loader.id + '.json')))) {
      versionId = st.loader.id;
    } else {
      const r = await installLoader({
        type: loader.type, mc: mcv, version: loader.version, mcRoot: this.paths.mc, endpoints: this.ep,
        javaPath, cacheDir: this.paths.cacheDir, log: (l) => this.log(l),
      });
      versionId = r.id;
      st.loader = { type: loader.type, version: loader.version || r.version || '', mc: mcv, id: r.id };
      await writeState(this.paths, st);
    }
    if (versionId !== mcv) await this.mc.ensureFiles(versionId, (p) => this._stage(stages, 2, p.label, frac(p)));
    // 4. файлы сборки
    const r = await syncPack({
      manifest: m, manifestUrl: this.cfg.manifestUrl, paths: this.paths, disabled: this.settings.get('disabledMods'), verify,
      onProgress: (p) => this._stage(stages, 3, p.totalFiles ? `Файлы сборки: ${p.files}/${p.totalFiles}` : 'Проверка файлов', frac(p)),
    });
    this.log(`Сборка ${pack.version}: скачано файлов ${r.downloaded}, удалено ${r.removed.length}`);
    this.installed = await readState(this.paths);
    this._stage(stages, 3, 'Готово', 1);
    return { javaPath, versionId };
  }

  async updatePack({ verify = false } = {}) {
    if (this.phase !== 'idle') return;
    this.lastError = null;
    this.setPhase('updating', { label: 'Проверка обновлений', pct: 0 });
    try {
      await this.refreshRemote();
      await this.install({ verify });
      this.setPhase('idle');
    } catch (e) {
      this._fail(e);
    }
  }
  _fail(e) {
    this.log('Ошибка: ' + (e.stack || e.message));
    this.lastError = e.message;
    this.setPhase('idle');
  }

  // ---------- запуск игры ----------
  async play() {
    if (this.phase !== 'idle') return;
    this.lastError = null;
    try {
      if (!this.accounts.active()) {
        this.lastError = 'NEED_LOGIN';
        return this.push();
      }
      this.setPhase('checking', { label: 'Проверка обновлений', pct: 0 });
      await this.refreshRemote();
      let javaPath, versionId;
      if (this.manifest) {
        ({ javaPath, versionId } = await this.install());
      } else {
        throw new Error('Нет связи с сервером обновлений, а сборка ещё не установлена.');
      }
      this.setPhase('launching', { label: 'Запуск игры', pct: 100 });
      const auth = await this._auth();
      const s = this.settings.data;
      const srv = this.server;
      const jvmArgs = [
        ...(DEFAULT_JVM + ' ' + ((this.manifest && this.manifest.jvmArgs) || '')).split(/\s+/).filter(Boolean),
        ...String(s.jvmArgs || '').split(/\s+/).filter(Boolean),
      ];
      const spec = await this.mc.buildLaunch({
        id: versionId, javaPath, auth, ram: s.ramMb, jvmArgs, fullscreen: s.fullscreen,
        server: s.autoJoin && srv.address ? { host: srv.address, port: Number(srv.port) || 25565 } : null,
        launcherName: 'HausMine', launcherVersion: this.host.appVersion,
      });
      await this._spawn(spec);
    } catch (e) {
      this._fail(e);
    }
  }

  async _spawn(spec) {
    this.log(`Запуск: ${spec.command} ${spec.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ').replace(/(--accessToken )\S+/, '$1***')}`.replace(/\S{300,}/g, (x) => x.slice(0, 80) + '…'));
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, windowsHide: true });
    this.child = child;
    let tail = [];
    const onData = (d) => {
      const text = d.toString();
      this.log(text);
      tail = tail.concat(text.split(/\r?\n/)).slice(-40);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    this.setPhase('running', { label: 'Игра запущена', pct: 100 });
    this.emit('game-start');
    await new Promise((resolve) => {
      child.on('error', (e) => {
        this.lastError = 'Не удалось запустить Java: ' + e.message;
        resolve();
      });
      child.on('close', (code, signal) => {
        this.log(`Игра завершилась (код ${code}${signal ? ', сигнал ' + signal : ''})`);
        if (code && !this._killed) this.lastError = `Игра завершилась с ошибкой (код ${code}). Откройте журнал (значок монитора).`;
        resolve();
      });
    });
    this._killed = false;
    this.child = null;
    this.setPhase('idle');
    this.emit('game-exit');
  }
  stopGame() {
    if (this.child) {
      this._killed = true;
      this.child.kill();
    }
  }

  // ---------- настройки, моды, новости ----------
  setSettings(patch) {
    const allowed = ['ramMb', 'jvmArgs', 'javaPath', 'behavior', 'autoJoin', 'fullscreen', 'tray', 'autostart'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    if ('ramMb' in clean) clean.ramMb = Math.max(1024, Math.min(this.maxRam, Math.round(+clean.ramMb / 256) * 256 || 4096));
    this.settings.set(clean);
    this.emit('settings', this.settings.data);
    this.push();
  }
  async mods() {
    return listMods(this.paths, this.manifest, this.settings.get('disabledMods'));
  }
  async setMod(rel, enabled) {
    if (this.phase === 'running') throw new Error('Закройте игру, чтобы менять моды');
    const list = new Set(this.settings.get('disabledMods'));
    if (enabled) list.delete(rel);
    else list.add(rel);
    this.settings.set({ disabledMods: [...list] });
    await toggleMod(this.paths, rel, enabled);
    return this.mods();
  }
  markNewsRead(ids) {
    const set = new Set(this.settings.get('readNews'));
    (ids || this.news.map((n) => n.id)).forEach((i) => set.add(i));
    this.settings.set({ readNews: [...set].slice(-300) });
    this.push();
  }
  dismissAnnouncement() {
    const a = this.manifest && this.manifest.announcement;
    if (a) this.settings.set({ dismissedAnnouncement: a.id });
    this.push();
  }
  diagnostics() {
    const st = this.getState();
    return [
      `Лаунчер: ${st.appVersion}`, `ОС: ${os.type()} ${os.release()} ${os.arch()}`, `ОЗУ: ${totalMemMb()} МБ`,
      `Сборка: установлена ${st.installedVersion || '—'}, на сервере ${st.pack ? st.pack.version : '—'}`,
      `Minecraft: ${st.pack ? st.pack.minecraft : '—'}, загрузчик: ${st.pack ? JSON.stringify(st.pack.loader) : '—'}`,
      `Аккаунт: ${(this.accounts.active() || {}).type || '—'}`, `Связь с сервером обновлений: ${this.remote.ok ? 'ок' : this.remote.error}`,
      `Настройки: ОЗУ ${st.settings.ramMb} МБ`, '', ...this.logs.slice(-150),
    ].join('\n');
  }
}

module.exports = { Launcher, DEFAULT_JVM };
