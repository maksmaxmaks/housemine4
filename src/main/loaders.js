'use strict';
// Установка загрузчиков модов: Fabric, Quilt (по JSON-профилю), Forge, NeoForge (через официальный установщик).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fetchJson, downloadVerified, exists, run } = require('./util');

async function writeProfile(mcRoot, profile) {
  const dir = path.join(mcRoot, 'versions', profile.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, profile.id + '.json'), JSON.stringify(profile, null, 2));
  return profile.id;
}

async function installFabricLike(kind, { mc, version, mcRoot, endpoints }) {
  const base = kind === 'quilt' ? endpoints.quiltMeta + 'v3/' : endpoints.fabricMeta + 'v2/';
  if (!version || version === 'latest') {
    const list = await fetchJson(`${base}versions/loader/${encodeURIComponent(mc)}`);
    const pick = list.find((x) => x.loader && x.loader.stable !== false) || list[0];
    if (!pick) throw new Error(`Для Minecraft ${mc} нет загрузчика ${kind}`);
    version = pick.loader.version;
  }
  const profile = await fetchJson(`${base}versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(version)}/profile/json`);
  const id = await writeProfile(mcRoot, profile);
  return { id, version };
}

async function installInstallerBased(kind, { mc, version, mcRoot, endpoints, javaPath, cacheDir, log }) {
  if (!version) throw new Error(`Укажите версию ${kind} в pack.config.json (loader.version)`);
  const url =
    kind === 'forge'
      ? `${endpoints.forgeMaven}net/minecraftforge/forge/${mc}-${version}/forge-${mc}-${version}-installer.jar`
      : `${endpoints.neoforgeMaven}net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
  const jar = path.join(cacheDir, `${kind}-${mc}-${version}-installer.jar`);
  if (!(await exists(jar))) await downloadVerified(url, jar, {});
  // установщику нужен launcher_profiles.json
  const prof = path.join(mcRoot, 'launcher_profiles.json');
  if (!(await exists(prof))) await fsp.writeFile(prof, JSON.stringify({ profiles: {}, version: 3 }));
  const vdir = path.join(mcRoot, 'versions');
  await fsp.mkdir(vdir, { recursive: true });
  const before = new Set(await fsp.readdir(vdir));
  log(`Запуск установщика ${kind} ${version} (это может занять несколько минут)…`);
  const out = await run(javaPath, ['-jar', jar, '--installClient', mcRoot], { cwd: mcRoot });
  log(out.slice(-1500));
  const after = (await fsp.readdir(vdir)).filter((d) => !before.has(d) && d.toLowerCase().includes(kind));
  let id = after[0];
  if (!id) {
    const all = await fsp.readdir(vdir);
    id = all.find((d) => d.toLowerCase().includes(kind) && d.includes(version));
  }
  if (!id) throw new Error(`Установщик ${kind} не создал версию — смотрите лог`);
  return { id, version };
}

// Возвращает { id, version } установленного профиля. Для vanilla — id самой версии.
async function installLoader({ type, mc, version, mcRoot, endpoints, javaPath, cacheDir, log = () => {} }) {
  switch (type) {
    case 'fabric':
    case 'quilt':
      return installFabricLike(type, { mc, version, mcRoot, endpoints });
    case 'forge':
    case 'neoforge':
      return installInstallerBased(type, { mc, version, mcRoot, endpoints, javaPath, cacheDir, log });
    case 'vanilla':
    case undefined:
    case null:
      return { id: mc, version: '' };
    default:
      throw new Error('Неизвестный загрузчик: ' + type);
  }
}

module.exports = { installLoader };
