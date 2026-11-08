'use strict';
const crypto = require('crypto');
const { JsonStore, offlineUuid } = require('./util');

// Шифрование токенов: в Electron — safeStorage (DPAPI/Keychain), иначе простой base64.
class Secrets {
  constructor(safeStorage) {
    this.ss = safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable() ? safeStorage : null;
  }
  enc(s) {
    if (s == null || s === '') return '';
    if (this.ss) return 'e:' + this.ss.encryptString(String(s)).toString('base64');
    return 'p:' + Buffer.from(String(s)).toString('base64');
  }
  dec(s) {
    if (!s) return '';
    try {
      if (s.startsWith('e:')) return this.ss ? this.ss.decryptString(Buffer.from(s.slice(2), 'base64')) : '';
      if (s.startsWith('p:')) return Buffer.from(s.slice(2), 'base64').toString();
    } catch {}
    return '';
  }
}

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

class Accounts {
  constructor(file, secrets) {
    this.store = new JsonStore(file, { activeId: null, accounts: [] });
    this.secrets = secrets || new Secrets(null);
  }
  _pub(a) {
    return { id: a.id, type: a.type, name: a.name, uuid: a.uuid };
  }
  list() {
    return this.store.get('accounts').map((a) => this._pub(a));
  }
  activeId() {
    const id = this.store.get('activeId');
    return this.store.get('accounts').some((a) => a.id === id) ? id : null;
  }
  active() {
    const id = this.activeId();
    const a = this.store.get('accounts').find((x) => x.id === id);
    return a ? this._pub(a) : null;
  }
  addOffline(name) {
    name = String(name || '').trim();
    if (!NAME_RE.test(name)) {
      throw new Error('Ник: 3–16 символов, только латиница, цифры и _');
    }
    const id = 'offline:' + name.toLowerCase();
    const accounts = this.store.get('accounts').filter((a) => a.id !== id);
    accounts.push({ id, type: 'offline', name, uuid: offlineUuid(name) });
    this.store.set({ accounts, activeId: id });
    return id;
  }
  addMicrosoft({ name, uuid, mcToken, mcExpires, msRefresh, skinUrl, model }) {
    const id = 'ms:' + uuid;
    const accounts = this.store.get('accounts').filter((a) => a.id !== id);
    accounts.push({
      id, type: 'microsoft', name, uuid,
      mcToken: this.secrets.enc(mcToken), mcExpires, msRefresh: this.secrets.enc(msRefresh), skinUrl, model,
    });
    this.store.set({ accounts, activeId: id });
    return id;
  }
  select(id) {
    if (!this.store.get('accounts').some((a) => a.id === id)) throw new Error('Аккаунт не найден');
    this.store.set({ activeId: id });
  }
  remove(id) {
    const accounts = this.store.get('accounts').filter((a) => a.id !== id);
    const activeId = this.store.get('activeId') === id ? (accounts[0] ? accounts[0].id : null) : this.store.get('activeId');
    this.store.set({ accounts, activeId });
  }
  // полная запись с расшифрованными токенами (только для main-процесса)
  full(id) {
    const a = this.store.get('accounts').find((x) => x.id === id);
    if (!a) return null;
    return { ...a, mcToken: this.secrets.dec(a.mcToken), msRefresh: this.secrets.dec(a.msRefresh) };
  }
  updateMicrosoft(id, patch) {
    const accounts = this.store.get('accounts').map((a) => {
      if (a.id !== id) return a;
      const n = { ...a };
      if (patch.name) n.name = patch.name;
      if (patch.mcToken) n.mcToken = this.secrets.enc(patch.mcToken);
      if (patch.mcExpires) n.mcExpires = patch.mcExpires;
      if (patch.msRefresh) n.msRefresh = this.secrets.enc(patch.msRefresh);
      if (patch.skinUrl !== undefined) n.skinUrl = patch.skinUrl;
      if (patch.model !== undefined) n.model = patch.model;
      return n;
    });
    this.store.set({ accounts });
  }
  randomToken() {
    return crypto.randomBytes(16).toString('hex');
  }
}

module.exports = { Accounts, Secrets, NAME_RE };
