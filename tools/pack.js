#!/usr/bin/env node
'use strict';
// Публикатор сборки: папка publish/modpack  ->  publish/site (manifest.json + files/ + news.json).
// Содержимое publish/site выкладывается на любой хостинг; игроки получают обновление автоматически.
//   npm run pack                      — собрать (версия поднимется сама, если файлы изменились)
//   npm run pack -- --bump minor      — принудительно поднять версию (patch | minor | major)
//   npm run pack -- --version 2.0.0   — задать версию вручную
//   npm run pack -- --keep-version    — не менять версию автоматически
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? def : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const PUB = path.resolve(opt('dir', path.join(ROOT, 'publish')));
const CONFIG = path.join(PUB, 'pack.config.json');
const SRC = path.join(PUB, 'modpack');
const OUT = path.resolve(opt('out', path.join(PUB, 'site')));

const DEFAULT_IGNORE = [
  'saves/**', 'logs/**', 'crash-reports/**', 'screenshots/**', '.git/**', '.hausmine/**', 'backups/**', 'resourcepacks/*.tmp',
  '*.log', '*.part', 'hs_err_pid*', 'usercache.json', 'usernamecache.json', '.DS_Store', 'Thumbs.db', '.gitkeep', 'desktop.ini',
  'launcher_profiles.json', 'realms_persistence.json', 'versions/**', 'libraries/**', 'assets/**', 'runtime/**',
];

function globToRe(g) {
  const anywhere = !g.includes('/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp((anywhere ? '(?:^|/)' : '^') + re + '$', 'i');
}
const matcher = (list) => {
  const res = (list || []).map(globToRe);
  return (p) => res.some((r) => r.test(p));
};

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
function sha1(file) {
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
function bump(v, kind) {
  const [a, b, c] = String(v || '1.0.0').split('.').map((x) => parseInt(x, 10) || 0);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}
const fail = (m) => {
  console.error('\n✖ ' + m + '\n');
  process.exit(1);
};

function main() {
  if (!fs.existsSync(CONFIG)) fail('Не найден ' + CONFIG);
  if (!fs.existsSync(SRC)) fail('Не найдена папка со сборкой: ' + SRC);
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!cfg.minecraft) fail('В pack.config.json укажите "minecraft" (например "1.20.1")');

  const ignore = matcher([...DEFAULT_IGNORE, ...(cfg.ignore || [])]);
  const optional = matcher(cfg.optional);
  const once = matcher(cfg.once);
  const names = cfg.names || {};
  const baseUrl = opt('base-url', cfg.fileBaseUrl || '');

  const list = walk(SRC).filter((p) => !ignore(p)).sort();
  const files = list.map((rel) => {
    const full = path.join(SRC, rel);
    const f = { path: rel, sha1: sha1(full), size: fs.statSync(full).size };
    if (baseUrl) f.url = baseUrl.replace(/\/?$/, '/') + encodePath(rel);
    if (optional(rel)) f.optional = true;
    if (once(rel)) f.overwrite = false;
    if (names[rel]) f.name = names[rel];
    return f;
  });

  // версия
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  } catch {}
  const digest = (fl, extra) => crypto.createHash('sha1').update(JSON.stringify([fl.map((f) => [f.path, f.sha1, !!f.optional, f.overwrite]), extra])).digest('hex');
  const sig = digest(files, [cfg.minecraft, cfg.loader]);
  let version = cfg.version || '1.0.0';
  const forced = opt('version', null);
  const b = opt('bump', null);
  if (forced && forced !== true) version = forced;
  else if (b) version = bump(version, b === true ? 'patch' : b);
  else if (!opt('keep-version', false) && prev && prev.pack && prev.pack.sig !== sig && prev.pack.version === version) {
    version = bump(version, 'patch');
    console.log(`• Файлы сборки изменились — версия автоматически повышена до ${version}`);
  } else if (prev && prev.pack && prev.pack.sig !== sig) {
    console.log('! Файлы изменились, но версия осталась прежней — игроки не получат обновление.');
  }
  if (version !== cfg.version) {
    cfg.version = version;
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  }

  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    name: cfg.name || undefined,
    pack: {
      version,
      changelog: Array.isArray(cfg.changelog) ? cfg.changelog.join('\n') : cfg.changelog || '',
      required: !!cfg.required,
      minecraft: cfg.minecraft,
      loader: cfg.loader || { type: 'vanilla' },
      java: cfg.java || undefined,
      sig,
      files,
    },
    server: cfg.server,
    links: cfg.links,
    skins: cfg.skins,
    announcement: cfg.announcement && cfg.announcement.text ? cfg.announcement : undefined,
    launcher: cfg.launcher && cfg.launcher.version ? cfg.launcher : undefined,
    jvmArgs: cfg.jvmArgs || undefined,
    newsUrl: 'news.json',
  };

  // копируем файлы
  fs.mkdirSync(path.join(OUT, 'files'), { recursive: true });
  let copied = 0;
  for (const f of files) {
    const from = path.join(SRC, f.path);
    const to = path.join(OUT, 'files', f.path);
    let same = false;
    try {
      const st = fs.statSync(to);
      same = st.size === f.size && sha1(to) === f.sha1;
    } catch {}
    if (!same) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied++;
    }
  }
  // чистим то, чего больше нет в сборке
  const keep = new Set(files.map((f) => f.path));
  for (const rel of walk(path.join(OUT, 'files'))) if (!keep.has(rel)) fs.rmSync(path.join(OUT, 'files', rel));
  (function prune(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { prune(path.join(d, e.name)); try { fs.rmdirSync(path.join(d, e.name)); } catch {} }
  })(path.join(OUT, 'files'));

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const newsSrc = path.join(PUB, 'news.json');
  fs.copyFileSync(fs.existsSync(newsSrc) ? newsSrc : path.join(__dirname, 'news.empty.json'), path.join(OUT, 'news.json'));

  const mb = (files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(1);
  console.log(`\n✔ Готово: сборка ${version}, Minecraft ${cfg.minecraft}, ${(cfg.loader || {}).type || 'vanilla'} ${(cfg.loader || {}).version || ''}`);
  console.log(`  файлов: ${files.length} (${mb} МБ), обновлено в папке сайта: ${copied}`);
  console.log(`  Выложите содержимое папки на хостинг:\n  ${OUT}\n`);
}
main();
