'use strict';
// Вход через Microsoft -> Xbox Live -> XSTS -> Minecraft Services.
// Окно входа открывает Electron (main.js), здесь только сетевая часть.
const { UA } = require('./util');

const LEGACY_ID = '00000000402b5328'; // идентификатор официального лаунчера Minecraft
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf';

const XERR = {
  2148916233: 'У этой учётной записи Microsoft нет профиля Xbox. Создайте его на xbox.com и повторите вход.',
  2148916235: 'Xbox Live недоступен в вашей стране.',
  2148916236: 'Для этой учётной записи нужна проверка возраста (Xbox).',
  2148916237: 'Для этой учётной записи нужна проверка возраста (Xbox).',
  2148916238: 'Детская учётная запись: добавьте её в семью Microsoft и разрешите онлайн-игру.',
};

class MicrosoftAuth {
  constructor({ clientId, endpoints }) {
    this.clientId = clientId || LEGACY_ID;
    this.ep = endpoints;
    this.legacy = this.clientId === LEGACY_ID;
    this.oauth = endpoints.oauthBase || (this.legacy ? 'https://login.live.com/' : 'https://login.microsoftonline.com/consumers/oauth2/v2.0/');
  }
  get scope() {
    return this.legacy ? 'service::user.auth.xboxlive.com::MBI_SSL' : 'XboxLive.signin offline_access';
  }
  get redirect() {
    return REDIRECT;
  }
  authUrl() {
    const base = this.legacy ? this.oauth + 'oauth20_authorize.srf' : this.oauth + 'authorize';
    const q = new URLSearchParams({
      client_id: this.clientId, response_type: 'code', redirect_uri: REDIRECT, scope: this.scope, prompt: 'select_account',
    });
    return base + '?' + q;
  }
  async _post(url, body, json = true, headers = {}) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA, Accept: 'application/json',
        'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', ...headers,
      },
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {}
    return { ok: r.ok, status: r.status, data };
  }
  async _token(params) {
    const url = this.legacy ? this.oauth + 'oauth20_token.srf' : this.oauth + 'token';
    const r = await this._post(url, { client_id: this.clientId, redirect_uri: REDIRECT, scope: this.scope, ...params }, false);
    if (!r.ok || !r.data || !r.data.access_token) throw new Error('Microsoft отклонил вход. Попробуйте ещё раз.');
    return r.data;
  }
  async loginWithCode(code) {
    return this._chain(await this._token({ grant_type: 'authorization_code', code }));
  }
  async refresh(refreshToken) {
    return this._chain(await this._token({ grant_type: 'refresh_token', refresh_token: refreshToken }));
  }
  async _chain(ms) {
    const xbl = await this._post(this.ep.xboxAuth + 'user/authenticate', {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + ms.access_token },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    });
    if (!xbl.ok) throw new Error('Не удалось войти в Xbox Live (код ' + xbl.status + ').');
    const xsts = await this._post(this.ep.xstsAuth + 'xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.data.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
    });
    if (!xsts.ok) {
      const msg = xsts.data && XERR[xsts.data.XErr];
      throw new Error(msg || 'Xbox не разрешил вход (код ' + xsts.status + ').');
    }
    const uhs = xsts.data.DisplayClaims.xui[0].uhs;
    const mc = await this._post(this.ep.minecraftServices + 'authentication/login_with_xbox', {
      identityToken: `XBL3.0 x=${uhs};${xsts.data.Token}`,
    });
    if (!mc.ok || !mc.data.access_token) throw new Error('Minecraft не принял вход через Xbox (код ' + mc.status + ').');
    const prof = await fetch(this.ep.minecraftServices + 'minecraft/profile', {
      headers: { Authorization: 'Bearer ' + mc.data.access_token, 'User-Agent': UA },
    });
    if (prof.status === 404) throw new Error('На этой учётной записи нет лицензии Minecraft: Java Edition.');
    if (!prof.ok) throw new Error('Не удалось получить профиль Minecraft (код ' + prof.status + ').');
    const p = await prof.json();
    const skin = (p.skins || []).find((s) => s.state === 'ACTIVE') || (p.skins || [])[0];
    return {
      name: p.name,
      uuid: p.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
      mcToken: mc.data.access_token,
      mcExpires: Date.now() + (mc.data.expires_in || 86400) * 1000,
      msRefresh: ms.refresh_token,
      skinUrl: skin ? skin.url : '',
      model: skin && skin.variant === 'SLIM' ? 'slim' : 'classic',
    };
  }
}

module.exports = { MicrosoftAuth, REDIRECT, LEGACY_ID };
