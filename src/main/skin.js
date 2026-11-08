'use strict';
// Получение скина игрока для «buddy»: свой сервер скинов -> Mojang -> Ely.by -> скин по умолчанию.
const { fetchJson, fetchBuffer } = require('./util');

function fill(tpl, name, uuid) {
  return tpl.replace(/\{name\}/gi, encodeURIComponent(name)).replace(/\{uuid\}/gi, (uuid || '').replace(/-/g, ''));
}
const dataUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64');
const isPng = (b) => b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

async function fromMojang(name, uuid, ep) {
  if (!uuid) {
    // для оффлайн-аккаунта ищем скин лицензионного игрока с таким ником
    const p = await fetchJson(`${ep.mojangApi}users/profiles/minecraft/${encodeURIComponent(name)}`, { timeout: 8000 });
    uuid = p.id;
  }
  const prof = await fetchJson(`${ep.sessionServer}session/minecraft/profile/${uuid.replace(/-/g, '')}`, { timeout: 8000 });
  const tex = (prof.properties || []).find((x) => x.name === 'textures');
  if (!tex) return null;
  const t = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf8'));
  const s = t.textures && t.textures.SKIN;
  if (!s) return null;
  return { url: s.url, slim: !!(s.metadata && s.metadata.model === 'slim') };
}

// account: { type, name, uuid, skinUrl?, model? }; skins: { template, fallback }
async function resolveSkin(account, skins, ep) {
  if (!account) return { dataUrl: null, source: 'default' };
  const tries = [];
  if (skins && skins.template) tries.push(['server', async () => ({ url: fill(skins.template, account.name, account.uuid) })]);
  if (account.type === 'microsoft' && account.skinUrl) tries.push(['microsoft', async () => ({ url: account.skinUrl, slim: account.model === 'slim' })]);
  const fb = (skins && skins.fallback) || 'mojang';
  if (fb === 'ely') tries.push(['ely', async () => ({ url: ep.elySkins + encodeURIComponent(account.name) + '.png' })]);
  if (fb === 'mojang' || fb === 'ely') tries.push(['mojang', async () => fromMojang(account.name, account.type === 'microsoft' ? account.uuid : '', ep)]);
  for (const [source, get] of tries) {
    try {
      const r = await get();
      if (!r || !r.url) continue;
      const buf = await fetchBuffer(r.url, { timeout: 8000 });
      if (!isPng(buf)) continue;
      return { dataUrl: dataUrl(buf), slim: r.slim, source };
    } catch {}
  }
  return { dataUrl: null, source: 'default' };
}

module.exports = { resolveSkin, fill };
