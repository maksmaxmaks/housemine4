'use strict';
// Установка и запуск Minecraft без сторонних библиотек:
// версии, библиотеки, natives, ассеты, сборка аргументов запуска.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fetchJson, downloadVerified, pool, exists, osName, unzip, mavenPath, sha1File } = require('./util');

const ARCH = { x64: 'x86_64', ia32: 'x86', arm64: 'arm64' }[process.arch] || 'x86_64';

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== osName()) return false;
    if (rule.os.arch && rule.os.arch !== ARCH) return false;
  }
  if (rule.features) {
    for (const [k, v] of Object.entries(rule.features)) if (!!features[k] !== !!v) return false;
  }
  return true;
}
function rulesAllow(rules, features = {}) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const r of rules) if (ruleMatches(r, features)) allowed = r.action === 'allow';
  return allowed;
}

const libKey = (name) => name.split(':').slice(0, 2).join(':') + (name.split(':')[3] ? ':' + name.split(':')[3] : '');

function mergeVersions(parent, child) {
  const out = { ...parent, ...child };
  const seen = new Set();
  out.libraries = [...(child.libraries || []), ...(parent.libraries || [])].filter((l) => {
    const k = libKey(l.name);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (parent.arguments || child.arguments) {
    out.arguments = {
      game: [...((parent.arguments || {}).game || []), ...((child.arguments || {}).game || [])],
      jvm: [...((parent.arguments || {}).jvm || []), ...((child.arguments || {}).jvm || [])],
    };
  }
  out.minecraftArguments = child.minecraftArguments || parent.minecraftArguments;
  out._rootId = parent._rootId || parent.id;
  out.id = child.id;
  return out;
}

class Minecraft {
  constructor({ paths, endpoints, log = () => {} }) {
    this.p = paths;
    this.ep = endpoints;
    this.log = log;
    this._manifest = null;
  }
  versionsDir(id) {
    return path.join(this.p.mc, 'versions', id);
  }
  async manifest() {
    if (!this._manifest) this._manifest = await fetchJson(this.ep.versionManifest);
    return this._manifest;
  }
  async loadVersionJson(id) {
    const local = path.join(this.versionsDir(id), id + '.json');
    if (await exists(local)) return JSON.parse(await fsp.readFile(local, 'utf8'));
    const m = await this.manifest();
    const entry = m.versions.find((v) => v.id === id);
    if (!entry) throw new Error(`Версия Minecraft ${id} не найдена`);
    await downloadVerified(entry.url, local, { sha1: entry.sha1 });
    return JSON.parse(await fsp.readFile(local, 'utf8'));
  }
  async resolve(id) {
    const j = await this.loadVersionJson(id);
    if (j.inheritsFrom) return mergeVersions(await this.resolve(j.inheritsFrom), j);
    return { ...j, _rootId: j.id };
  }
  async javaMajor(id) {
    const r = await this.resolve(id);
    if (r.javaVersion && r.javaVersion.majorVersion) return r.javaVersion.majorVersion;
    const m = /^1\.(\d+)(?:\.(\d+))?/.exec(r._rootId || id);
    if (!m) return 21;
    const minor = +m[1], patch = +(m[2] || 0);
    if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
    if (minor >= 17) return 17;
    return 8;
  }

  // Скачать всё необходимое для запуска версии `id` (клиент, библиотеки, ассеты, логконфиг).
  async ensureFiles(id, onProgress = () => {}) {
    const v = await this.resolve(id);
    const jobs = [];
    const features = {};

    const rootId = v._rootId;
    if (v.downloads && v.downloads.client) {
      jobs.push({ url: v.downloads.client.url, dest: path.join(this.versionsDir(rootId), rootId + '.jar'), sha1: v.downloads.client.sha1, size: v.downloads.client.size });
    }
    const libs = this.libraryList(v, features);
    for (const l of libs) jobs.push(l);

    if (v.logging && v.logging.client && v.logging.client.file) {
      const f = v.logging.client.file;
      jobs.push({ url: f.url, dest: path.join(this.p.mc, 'assets', 'log_configs', f.id), sha1: f.sha1, size: f.size });
    }
    await this._downloadJobs(jobs, 'Библиотеки Minecraft', onProgress, 8);

    if (v.assetIndex) await this.ensureAssets(v, onProgress);
    return v;
  }

  libraryList(v, features) {
    const out = [];
    for (const lib of v.libraries || []) {
      if (!rulesAllow(lib.rules, features)) continue;
      const entries = [];
      if (lib.natives && lib.natives[osName()]) {
        const cls = lib.natives[osName()].replace('${arch}', process.arch === 'ia32' ? '32' : '64');
        const a = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[cls];
        if (a) entries.push({ ...a, native: true, exclude: (lib.extract && lib.extract.exclude) || [], name: lib.name });
      }
      if (lib.downloads && lib.downloads.artifact) entries.push({ ...lib.downloads.artifact, name: lib.name });
      else if (!lib.natives && !lib.downloads) {
        const p = mavenPath(lib.name);
        entries.push({ path: p, url: (lib.url || this.ep.libraries) + p, sha1: lib.sha1, size: lib.size, name: lib.name });
      }
      for (const e of entries) {
        out.push({ url: e.url, dest: path.join(this.p.mc, 'libraries', e.path), sha1: e.sha1, size: e.size, native: !!e.native, exclude: e.exclude, name: e.name, rel: e.path });
      }
    }
    return out;
  }

  async _downloadJobs(jobs, label, onProgress, conc = 8) {
    const todo = [];
    for (const j of jobs) {
      let ok = false;
      try {
        const st = await fsp.stat(j.dest);
        ok = j.size ? st.size === j.size : st.size > 0;
        if (ok && j.sha1 && !j.size) ok = (await sha1File(j.dest)) === j.sha1;
      } catch {}
      if (!ok) todo.push(j);
    }
    let done = 0;
    onProgress({ label, done, total: todo.length });
    await pool(todo, conc, async (j) => {
      await downloadVerified(j.url, j.dest, { sha1: j.sha1, size: j.size });
      onProgress({ label, done: ++done, total: todo.length });
    });
  }

  async ensureAssets(v, onProgress) {
    const idx = v.assetIndex;
    const idxFile = path.join(this.p.mc, 'assets', 'indexes', idx.id + '.json');
    await downloadIfBad(idx.url, idxFile, idx.sha1, idx.size);
    const data = JSON.parse(await fsp.readFile(idxFile, 'utf8'));
    const jobs = Object.values(data.objects).map((o) => ({
      url: this.ep.resources + o.hash.slice(0, 2) + '/' + o.hash,
      dest: path.join(this.p.mc, 'assets', 'objects', o.hash.slice(0, 2), o.hash),
      sha1: o.hash, size: o.size,
    }));
    await this._downloadJobs(jobs, 'Ресурсы Minecraft', onProgress, 16);
    if (data.virtual || data.map_to_resources) {
      const base = data.virtual ? path.join(this.p.mc, 'assets', 'virtual', 'legacy') : path.join(this.p.instance, 'resources');
      for (const [name, o] of Object.entries(data.objects)) {
        const dest = path.join(base, name);
        if (await exists(dest)) continue;
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(path.join(this.p.mc, 'assets', 'objects', o.hash.slice(0, 2), o.hash), dest);
      }
    }
  }

  async extractNatives(v, id) {
    const dir = path.join(this.versionsDir(id), 'natives');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    for (const l of this.libraryList(v, {})) {
      if (!l.native) continue;
      const ex = l.exclude || [];
      await unzip(l.dest, dir, { filter: (rel) => !ex.some((e) => rel.startsWith(e)) });
    }
    return dir;
  }

  // Собрать команду запуска. opts: { id, javaPath, auth:{name,uuid,token,type}, ram, jvmArgs[], server:{host,port}|null,
  //   resolution:{width,height}|null, fullscreen, gameDir, launcherName, launcherVersion }
  async buildLaunch(opts) {
    const v = await this.resolve(opts.id);
    const natives = await this.extractNatives(v, opts.id);
    const libs = this.libraryList(v, {}).filter((l) => !l.native);
    const cp = libs.map((l) => l.dest);
    const rootId = v._rootId;
    cp.push(path.join(this.versionsDir(rootId), rootId + '.jar'));
    const sep = path.delimiter;
    const gameDir = opts.gameDir || this.p.instance;
    await fsp.mkdir(gameDir, { recursive: true });

    const hasQuickPlay = JSON.stringify(v.arguments || {}).includes('quickPlayMultiplayer');
    const features = {
      has_custom_resolution: !!opts.resolution,
      is_demo_user: false,
      has_quick_plays_support: hasQuickPlay,
      is_quick_play_multiplayer: !!(opts.server && hasQuickPlay),
      is_quick_play_singleplayer: false,
      is_quick_play_realms: false,
    };
    const vars = {
      auth_player_name: opts.auth.name,
      auth_uuid: opts.auth.uuid.replace(/-/g, ''),
      auth_access_token: opts.auth.token,
      auth_session: opts.auth.token,
      auth_xuid: '0',
      clientid: '',
      user_type: opts.auth.type === 'microsoft' ? 'msa' : 'legacy',
      user_properties: '{}',
      version_name: opts.id,
      version_type: v.type || 'release',
      game_directory: gameDir,
      assets_root: path.join(this.p.mc, 'assets'),
      game_assets: path.join(this.p.mc, 'assets', 'virtual', 'legacy'),
      assets_index_name: v.assets || (v.assetIndex && v.assetIndex.id) || rootId,
      natives_directory: natives,
      library_directory: path.join(this.p.mc, 'libraries'),
      classpath_separator: sep,
      classpath: cp.join(sep),
      launcher_name: opts.launcherName || 'HausMine',
      launcher_version: opts.launcherVersion || '1.0',
      resolution_width: opts.resolution ? String(opts.resolution.width) : '',
      resolution_height: opts.resolution ? String(opts.resolution.height) : '',
      quickPlayMultiplayer: opts.server ? `${opts.server.host}:${opts.server.port || 25565}` : '',
      quickPlayPath: path.join(gameDir, 'quickPlay', 'log.json'),
      quickPlaySingleplayer: '',
      quickPlayRealms: '',
    };
    if (hasQuickPlay) await fsp.mkdir(path.dirname(vars.quickPlayPath), { recursive: true });
    const subst = (s) => s.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    const expand = (list) => {
      const res = [];
      for (const a of list || []) {
        if (typeof a === 'string') res.push(subst(a));
        else if (rulesAllow(a.rules, features)) for (const x of [].concat(a.value)) res.push(subst(x));
      }
      return res;
    };

    let jvm, game;
    if (v.arguments) {
      jvm = expand(v.arguments.jvm);
      game = expand(v.arguments.game);
    } else {
      jvm = ['-Djava.library.path=' + natives, '-cp', vars.classpath];
      game = (v.minecraftArguments || '').split(' ').filter(Boolean).map(subst);
    }
    if (!jvm.includes('-cp') && !jvm.includes('-classpath')) jvm.push('-cp', vars.classpath);
    if (v.logging && v.logging.client && v.logging.client.argument) {
      const f = path.join(this.p.mc, 'assets', 'log_configs', v.logging.client.file.id);
      jvm.push(v.logging.client.argument.replace('${path}', f));
    }
    if (opts.server && !hasQuickPlay) game.push('--server', opts.server.host, '--port', String(opts.server.port || 25565));
    if (opts.fullscreen) game.push('--fullscreen');

    const ram = Math.max(512, opts.ram || 2048);
    const args = [`-Xms${Math.min(ram, 1024)}M`, `-Xmx${ram}M`, ...(opts.jvmArgs || []), ...jvm, v.mainClass, ...game];
    return { command: opts.javaPath, args, cwd: gameDir, version: v };
  }
}

async function downloadIfBad(url, dest, sha1, size) {
  try {
    const st = await fsp.stat(dest);
    if (!size || st.size === size) return;
  } catch {}
  await downloadVerified(url, dest, { sha1, size });
}

module.exports = { Minecraft, rulesAllow, mergeVersions };
