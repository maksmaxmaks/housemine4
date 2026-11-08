'use strict';
// Автоматическая загрузка Java (Eclipse Temurin JRE) под нужную версию Minecraft.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { downloadVerified, extractArchive, exists, run } = require('./util');

const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

async function findJava(dir, depth = 5) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const bin = entries.find((e) => e.isDirectory() && e.name === 'bin');
  if (bin && (await exists(path.join(dir, 'bin', EXE)))) return path.join(dir, 'bin', EXE);
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = await findJava(path.join(dir, e.name), depth - 1);
      if (r) return r;
    }
  }
  return null;
}

async function ensureJava({ major, runtimeDir, cacheDir, endpoints, onProgress = () => {}, log = () => {} }) {
  const target = path.join(runtimeDir, 'java-' + major);
  const have = await findJava(target);
  if (have) return have;

  const osn = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
  const arch = process.arch === 'arm64' && process.platform !== 'win32' ? 'aarch64' : 'x64';
  const url = `${endpoints.adoptium}v3/binary/latest/${major}/ga/${osn}/${arch}/jre/hotspot/normal/eclipse`;
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const archive = path.join(cacheDir, `java-${major}.${ext}`);
  log(`Скачиваю Java ${major}…`);
  let got = 0;
  onProgress({ label: `Java ${major}`, done: 0, total: 1 });
  await downloadVerified(url, archive, { onBytes: (n) => { got += n; } });
  const tmp = target + '.tmp';
  await fsp.rm(tmp, { recursive: true, force: true });
  await extractArchive(archive, tmp);
  const exe = await findJava(tmp);
  if (!exe) throw new Error('В скачанной Java не найден исполняемый файл');
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rename(tmp, target);
  await fsp.rm(archive, { force: true });
  const final = await findJava(target);
  if (process.platform !== 'win32') await fsp.chmod(final, 0o755).catch(() => {});
  await run(final, ['-version']); // проверка, что запускается
  onProgress({ label: `Java ${major}`, done: 1, total: 1 });
  return final;
}

module.exports = { ensureJava, findJava };
