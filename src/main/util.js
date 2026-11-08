'use strict';
// Общие утилиты без внешних зависимостей: HTTP, хеши, пул задач, JSON-хранилище, zip.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

const UA = 'HausMineLauncher/1.0';

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

function withBust(url) {
  return url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
}

async function fetchJson(url, { timeout = 15000, bust = false, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(bust ? withBust(url) : url, {
      signal: ctl.signal,
      cache: 'no-store',
      headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache', ...headers },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} (${url})`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url, { timeout = 20000, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, ...headers } });
    if (!r.ok) throw new Error(`HTTP ${r.status} (${url})`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// Скачивает во временный файл `dest + .part`, считает sha1 на лету.
// Если 30 секунд нет данных — обрывает. Возвращает { tmp, sha1, size }.
async function downloadFile(url, dest, onBytes) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const ctl = new AbortController();
  let idle;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(), 30000);
  };
  kick();
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status} (${url})`);
    const hash = crypto.createHash('sha1');
    let size = 0;
    await pipeline(
      Readable.fromWeb(r.body),
      async function* (src) {
        for await (const chunk of src) {
          kick();
          hash.update(chunk);
          size += chunk.length;
          if (onBytes) onBytes(chunk.length);
          yield chunk;
        }
      },
      fs.createWriteStream(tmp)
    );
    return { tmp, sha1: hash.digest('hex'), size };
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  } finally {
    clearTimeout(idle);
  }
}

// Скачать файл с проверкой sha1 (если известен), 3 попытки, атомарная замена.
async function downloadVerified(url, dest, { sha1, size, onBytes, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let counted = 0;
    try {
      const r = await downloadFile(url, dest, (n) => {
        counted += n;
        if (onBytes) onBytes(n);
      });
      if (sha1 && r.sha1.toLowerCase() !== String(sha1).toLowerCase()) {
        await fsp.rm(r.tmp, { force: true });
        throw new Error(`Не совпала контрольная сумма: ${url}`);
      }
      if (size && r.size !== size) {
        await fsp.rm(r.tmp, { force: true });
        throw new Error(`Не совпал размер файла: ${url}`);
      }
      await fsp.rename(r.tmp, dest);
      return r;
    } catch (e) {
      lastErr = e;
      if (onBytes && counted) onBytes(-counted); // откатываем прогресс неудачной попытки
      if (attempt < retries) await new Promise((res) => setTimeout(res, 400 * attempt));
    }
  }
  throw lastErr;
}

async function pool(items, limit, worker) {
  let i = 0;
  let failed = null;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx], idx);
      } catch (e) {
        failed = failed || e;
      }
    }
  });
  await Promise.all(runners);
  if (failed) throw failed;
}

function cmpVersion(a, b) {
  const pa = String(a || '0').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Безопасный путь внутри каталога (защита от ../ и абсолютных путей в манифесте)
function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('Некорректный путь в манифесте');
  const full = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  if (!full.startsWith(base)) throw new Error('Путь выходит за пределы папки игры: ' + rel);
  return full;
}

class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = { ...defaults };
    try {
      this.data = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {}
  }
  get(k) {
    return this.data[k];
  }
  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('JsonStore save failed', e);
    }
  }
}

async function pruneEmptyDirs(root, dir) {
  const base = path.resolve(root);
  let cur = path.resolve(dir);
  while (cur.startsWith(base + path.sep)) {
    try {
      await fsp.rmdir(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function osName() {
  return { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform] || 'linux';
}

// ---------- ZIP (без внешних библиотек) ----------
// Поддерживает методы stored/deflate, пути безопасны, права на файл сохраняются.
async function unzip(zipPath, destDir, { strip = 0, filter } = {}) {
  const buf = await fsp.readFile(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Повреждённый zip-архив');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const written = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('Повреждённый каталог zip');
    const madeBy = buf.readUInt16LE(ptr + 4);
    const method = buf.readUInt16LE(ptr + 10);
    const csize = buf.readUInt32LE(ptr + 20);
    const usize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const attr = buf.readUInt32LE(ptr + 38);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('zip64 не поддерживается');

    let rel = name.replace(/\\/g, '/');
    if (strip) rel = rel.split('/').slice(strip).join('/');
    if (!rel || rel.endsWith('/')) {
      if (rel && (!filter || filter(rel))) await fsp.mkdir(safeJoin(destDir, rel), { recursive: true });
      continue;
    }
    if (filter && !filter(rel)) continue;
    const mode = madeBy >> 8 === 3 ? (attr >>> 16) & 0o7777 : 0;
    if ((mode & 0o170000) === 0o120000) continue; // symlink
    const out = safeJoin(destDir, rel);
    const nlen = buf.readUInt16LE(localOff + 26);
    const elen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + nlen + elen;
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('Неподдерживаемый метод сжатия zip: ' + method);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, data);
    if (mode & 0o111) await fsp.chmod(out, mode & 0o777);
    written.push(rel);
  }
  return written;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '';
    p.stdout && p.stdout.on('data', (d) => (out += d));
    p.stderr && p.stderr.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} завершился с кодом ${code}\n${out.slice(-2000)}`))));
  });
}

// zip -> встроенный unzip, tar.gz -> системный tar (есть в Windows 10+, macOS, Linux)
async function extractArchive(archive, destDir, { strip = 0 } = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  if (/\.zip$/i.test(archive)) return unzip(archive, destDir, { strip });
  const args = ['-xzf', archive, '-C', destDir];
  if (strip) args.push('--strip-components=' + strip);
  await run('tar', args);
}

function mavenPath(name) {
  // group:artifact:version[:classifier][@ext]
  let ext = 'jar';
  if (name.includes('@')) {
    const [n, e] = name.split('@');
    name = n;
    ext = e;
  }
  const [g, a, v, c] = name.split(':');
  return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${c ? '-' + c : ''}.${ext}`;
}

function offlineUuid(name) {
  const b = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function totalMemMb() {
  return Math.floor(os.totalmem() / 1048576);
}

module.exports = {
  UA, sha1File, fetchJson, fetchBuffer, downloadFile, downloadVerified, pool, cmpVersion, safeJoin, JsonStore,
  pruneEmptyDirs, withBust, exists, osName, unzip, run, extractArchive, mavenPath, offlineUuid, totalMemMb,
};
