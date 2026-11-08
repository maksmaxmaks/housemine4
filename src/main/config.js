'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  packName: 'ХаусМайн 4',
  baseUrl: '',
  server: { name: '', address: '', port: 25565 },
  links: { site: '', discord: '', help: '' },
  skins: { template: '', fallback: 'mojang' },
  pollMinutes: 5,
  defaultRamMb: 4096,
  microsoftLogin: true,
  msClientId: '00000000402b5328',
  gameFolderName: '.hausmine4',
  endpoints: {},
};

function loadConfig(appDir) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(appDir, 'launcher.config.json'), 'utf8'));
  } catch (e) {
    console.error('launcher.config.json не прочитан:', e.message);
  }
  const cfg = { ...DEFAULTS, ...file };
  cfg.server = { ...DEFAULTS.server, ...(file.server || {}) };
  cfg.links = { ...DEFAULTS.links, ...(file.links || {}) };
  cfg.skins = { ...DEFAULTS.skins, ...(file.skins || {}) };
  // переменные окружения нужны для тестов и отладки
  if (process.env.HM_BASE_URL) cfg.baseUrl = process.env.HM_BASE_URL;
  if (process.env.HM_ENDPOINTS) {
    try {
      cfg.endpoints = { ...cfg.endpoints, ...JSON.parse(process.env.HM_ENDPOINTS) };
    } catch {}
  }
  if (cfg.baseUrl && !cfg.baseUrl.endsWith('/')) cfg.baseUrl += '/';
  cfg.manifestUrl = cfg.baseUrl ? new URL('manifest.json', cfg.baseUrl).href : '';
  return cfg;
}

const DEFAULT_ENDPOINTS = {
  versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  resources: 'https://resources.download.minecraft.net/',
  libraries: 'https://libraries.minecraft.net/',
  fabricMeta: 'https://meta.fabricmc.net/',
  quiltMeta: 'https://meta.quiltmc.org/',
  forgeMaven: 'https://maven.minecraftforge.net/',
  neoforgeMaven: 'https://maven.neoforged.net/releases/',
  adoptium: 'https://api.adoptium.net/',
  mojangApi: 'https://api.mojang.com/',
  sessionServer: 'https://sessionserver.mojang.com/',
  minecraftServices: 'https://api.minecraftservices.com/',
  xboxAuth: 'https://user.auth.xboxlive.com/',
  xstsAuth: 'https://xsts.auth.xboxlive.com/',
  elySkins: 'http://skinsystem.ely.by/skins/',
};

function endpoints(cfg) {
  return { ...DEFAULT_ENDPOINTS, ...(cfg.endpoints || {}) };
}

module.exports = { loadConfig, endpoints, DEFAULT_ENDPOINTS };
