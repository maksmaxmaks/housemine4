'use strict';
// Синхронизация сборки с манифестом: докачивает изменённое, удаляет лишнее, не трогает файлы игрока.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { sha1File, downloadVerified, pool, safeJoin, exists, pruneEmptyDirs } = require('./util');

async function readState(paths) {
  try {
    return JSON.parse(await fsp.readFile(paths.stateFile, 'utf8'));
  } catch {
    return { version: null, files: {}, loader: null };
  }
}
async function writeState(paths, state) {
  await fsp.mkdir(path.dirname(paths.stateFile), { recursive: true });
  const tmp = paths.stateFile + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, paths.stateFile);
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
function fileUrl(f, manifestUrl) {
  return new URL(f.url || 'files/' + encodePath(f.path), manifestUrl).href;
}

async function syncPack({ manifest, manifestUrl, paths, disabled = [], verify = false, onProgress = () => {} }) {
  const pack = manifest.pack || {};
  const files = pack.files || [];
  const root = paths.instance;
  await fsp.mkdir(root, { recursive: true });
  const state = await readState(paths);
  state.files = state.files || {};
  const dis = new Set(disabled);
  const wanted = new Set(files.map((f) => f.path));

  const plan = [];
  let totalBytes = 0;
  for (const f of files) {
    if (!/^[^\0]+$/.test(f.path) || !f.sha1) throw new Error('Некорректная запись в манифесте: ' + JSON.stringify(f.path));
    const base = safeJoin(root, f.path);
    const isDisabled = !!f.optional && dis.has(f.path);
    const target = isDisabled ? base + '.disabled' : base;
    const alt = isDisabled ? base : base + '.disabled';
    // игрок переключил опциональный мод — просто переименовываем
    if (f.optional && !(await exists(target)) && (await exists(alt))) await fsp.rename(alt, target);
    const have = await exists(target);
    const once = f.overwrite === false;
    let need = false;
    if (!have) need = once ? !state.files[f.path] : true;
    else if (!once) {
      const st = await fsp.stat(target);
      if (f.size && st.size !== f.size) need = true;
      else if (verify || !state.files[f.path] || state.files[f.path].sha1 !== f.sha1) need = (await sha1File(target)) !== f.sha1;
    }
    if (need) {
      plan.push({ f, target });
      totalBytes += f.size || 0;
    } else if (have) {
      state.files[f.path] = { sha1: f.sha1, once };
    }
  }

  let doneBytes = 0;
  let doneFiles = 0;
  const report = () => onProgress({ label: 'Файлы сборки', done: Math.max(0, doneBytes), total: totalBytes, files: doneFiles, totalFiles: plan.length });
  report();
  await pool(plan, 6, async ({ f, target }) => {
    await downloadVerified(fileUrl(f, manifestUrl), target, {
      sha1: f.sha1,
      size: f.size || undefined,
      onBytes: (n) => {
        doneBytes += n;
        report();
      },
    });
    state.files[f.path] = { sha1: f.sha1, once: f.overwrite === false };
    doneFiles++;
    report();
  });

  // удаляем то, что раньше ставил лаунчер, а теперь убрано из сборки
  const removed = [];
  for (const p of Object.keys(state.files)) {
    if (wanted.has(p)) continue;
    const rec = state.files[p];
    delete state.files[p];
    if (rec && rec.once) continue; // файлы «только при первой установке» принадлежат игроку
    for (const suffix of ['', '.disabled']) {
      const full = safeJoin(root, p) + suffix;
      if (await exists(full)) {
        await fsp.rm(full, { force: true });
        removed.push(p);
        await pruneEmptyDirs(root, path.dirname(full));
      }
    }
  }

  state.version = pack.version;
  await writeState(paths, state);
  return { downloaded: plan.length, removed };
}

// Список модов для окна «Моды»
async function listMods(paths, manifest, disabled) {
  const dir = path.join(paths.instance, 'mods');
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {}
  const meta = new Map(((manifest && manifest.pack && manifest.pack.files) || []).map((f) => [f.path, f]));
  const dis = new Set(disabled || []);
  const out = [];
  const seen = new Set();
  for (const n of names) {
    if (!/\.jar(\.disabled)?$/.test(n)) continue;
    const base = n.replace(/\.disabled$/, '');
    const rel = 'mods/' + base;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const m = meta.get(rel);
    out.push({
      path: rel,
      name: (m && m.name) || base.replace(/\.jar$/, ''),
      file: base,
      enabled: !n.endsWith('.disabled'),
      optional: !m || !!m.optional, // свои моды игрока тоже можно выключать
      custom: !m,
      required: !!m && !m.optional,
      size: m && m.size,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return out;
}

async function toggleMod(paths, rel, enabled) {
  const base = safeJoin(paths.instance, rel);
  const from = enabled ? base + '.disabled' : base;
  const to = enabled ? base : base + '.disabled';
  if (await exists(from)) await fsp.rename(from, to);
  return enabled;
}

module.exports = { syncPack, readState, writeState, listMods, toggleMod, fileUrl };
