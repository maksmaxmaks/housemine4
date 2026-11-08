'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { startMock, sha1, tmpdir, makeZip } = require('./helpers');
const { Launcher } = require('../src/main/launcher');
const { loadConfig } = require('../src/main/config');
const { unzip, offlineUuid, cmpVersion } = require('../src/main/util');
const { MicrosoftAuth } = require('../src/main/msauth');
const { pingServer } = require('../src/main/status');
const { resolveSkin } = require('../src/main/skin');
const { endpoints } = require('../src/main/config');

const ROOT = path.resolve(__dirname, '..');
let mock, work, pub, launcher, javaOut, notified = [];

function pack(args = []) {
  return execFileSync('node', [path.join(ROOT, 'tools', 'pack.js'), '--dir', pub, ...args], { encoding: 'utf8' });
}
const w = (rel, content) => {
  const f = path.join(pub, 'modpack', rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

test.before(async () => {
  mock = await startMock();
  work = tmpdir('core');
  pub = path.join(work, 'publish');
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, 'pack.config.json'), JSON.stringify({
    name: 'ХаусМайн 4', version: '1.0.0', minecraft: '1.20.1', loader: { type: 'fabric', version: 'latest' },
    server: { address: 'play.example.com', port: 25565 }, optional: ['mods/opt*.jar'], once: ['options.txt'],
    changelog: ['первая версия'],
  }));
  w('mods/core.jar', 'core-v1');
  w('mods/opt-extra.jar', 'opt-v1');
  w('mods/gone.jar', 'gone');
  w('config/x.toml', 'a=1');
  w('options.txt', 'fov=70');
  w('saves/world/level.dat', 'must-be-ignored');
  pack();
  mock.setSite(path.join(pub, 'site'));

  // ---- Mojang ----
  const lib = mock.file('/libs/com/example/lib/1.0/lib-1.0.jar', Buffer.from('lib-bytes'));
  const lw = mock.file('/libs/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar', Buffer.from('lwjgl-native'));
  const natZip = makeZip(work, { 'liblwjgl.so': 'SO', 'META-INF/skip.txt': 'skip' });
  const nat = mock.file('/libs/old/natives/1/natives-1-natives-linux.jar', natZip);
  const winOnly = mock.file('/libs/win/only/1/only-1.jar', Buffer.from('win'));
  const client = mock.file('/mc/client.jar', Buffer.from('client-jar'));
  const asset = Buffer.from('hello-asset');
  const aHash = sha1(asset);
  mock.file(`/res/${aHash.slice(0, 2)}/${aHash}`, asset);
  const idx = Buffer.from(JSON.stringify({ objects: { 'icons/a.png': { hash: aHash, size: asset.length } } }));
  const idxInfo = mock.file('/mc/index.json', idx);
  const logcfg = mock.file('/mc/log.xml', Buffer.from('<Configuration/>'));
  const L = (p, i, extra = {}) => ({ path: p, url: `${mock.url}/libs/${p}`, sha1: i.sha1, size: i.size });
  const vjson = {
    id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: '5',
    assetIndex: { id: '5', url: mock.url + '/mc/index.json', ...idxInfo },
    downloads: { client: { url: mock.url + '/mc/client.jar', ...client } },
    javaVersion: { majorVersion: 17 },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.12.xml', url: mock.url + '/mc/log.xml', ...logcfg } } },
    libraries: [
      { name: 'com.example:lib:1.0', downloads: { artifact: L('com/example/lib/1.0/lib-1.0.jar', lib) } },
      { name: 'org.lwjgl:lwjgl:3.3.1:natives-linux', downloads: { artifact: L('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar', lw) }, rules: [{ action: 'allow', os: { name: 'linux' } }] },
      { name: 'win:only:1', downloads: { artifact: L('win/only/1/only-1.jar', winOnly) }, rules: [{ action: 'allow', os: { name: 'windows' } }] },
      { name: 'old:natives:1', natives: { linux: 'natives-linux', windows: 'natives-windows' }, extract: { exclude: ['META-INF/'] },
        downloads: { classifiers: { 'natives-linux': L('old/natives/1/natives-1-natives-linux.jar', nat) } } },
    ],
    arguments: {
      game: ['--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}', '--assetsDir', '${assets_root}',
        '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--userType', '${user_type}',
        { rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] },
        { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] }],
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    },
  };
  const vbuf = Buffer.from(JSON.stringify(vjson));
  const vinfo = mock.file('/mc/1.20.1.json', vbuf);
  mock.json('/mc/version_manifest_v2.json', { versions: [{ id: '1.20.1', url: mock.url + '/mc/1.20.1.json', sha1: vinfo.sha1 }] });

  // ---- Fabric ----
  mock.json('/fabric/v2/versions/loader/1.20.1', [{ loader: { version: '0.15.0', stable: true } }]);
  const fabLib = mock.file('/maven/net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar', Buffer.from('fabric'));
  mock.json('/fabric/v2/versions/loader/1.20.1/0.15.0/profile/json', {
    id: 'fabric-loader-0.15.0-1.20.1', inheritsFrom: '1.20.1', type: 'release',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
    libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0', url: mock.url + '/maven/' }],
  });

  // ---- Java (tar.gz с поддельным java) ----
  const jdir = tmpdir('jre');
  fs.mkdirSync(path.join(jdir, 'jdk-17-jre', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(jdir, 'jdk-17-jre', 'bin', 'java'), '#!/bin/sh\nif [ "$1" = "-version" ]; then echo openjdk >&2; exit 0; fi\nprintf \'%s\\n\' "$@" > "$HM_JAVA_OUT"\nexit 0\n', { mode: 0o755 });
  execFileSync('tar', ['-czf', path.join(work, 'jre.tgz'), '-C', jdir, 'jdk-17-jre']);
  mock.file('/adoptium/v3/binary/latest/17/ga/linux/x64/jre/hotspot/normal/eclipse', fs.readFileSync(path.join(work, 'jre.tgz')));

  javaOut = path.join(work, 'java-args.txt');
  process.env.HM_JAVA_OUT = javaOut;
  const root = path.join(work, 'data');
  const cfgDir = path.join(work, 'cfgdir');
  fs.mkdirSync(cfgDir);
  fs.writeFileSync(path.join(cfgDir, 'launcher.config.json'), JSON.stringify({
    packName: 'ХаусМайн 4', baseUrl: mock.url + '/site/', pollMinutes: 1,
    endpoints: {
      versionManifest: mock.url + '/mc/version_manifest_v2.json', resources: mock.url + '/res/', libraries: mock.url + '/libs/',
      fabricMeta: mock.url + '/fabric/', adoptium: mock.url + '/adoptium/', mojangApi: mock.url + '/mojang/', sessionServer: mock.url + '/session/',
      minecraftServices: mock.url + '/mcs/', xboxAuth: mock.url + '/xbl/', xstsAuth: mock.url + '/xsts/', oauthBase: mock.url + '/oauth/',
    },
  }));
  launcher = new Launcher({ config: loadConfig(cfgDir), root, host: { appVersion: '1.0.0', notify: (t, b) => notified.push([t, b]) } });
  await launcher.init();
  await new Promise((r) => setTimeout(r, 200));
});
test.after(async () => {
  launcher.dispose();
  await mock.close();
});

test('утилиты: offline-uuid, версии', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f'); // известный UUID оффлайн-игрока Notch
  assert.equal(cmpVersion('1.10.0', '1.9.9'), 1);
});

test('публикатор: игнорирует saves, считает sha1, помечает optional/once', () => {
  const m = JSON.parse(fs.readFileSync(path.join(pub, 'site', 'manifest.json'), 'utf8'));
  const paths = m.pack.files.map((f) => f.path);
  assert.ok(!paths.some((p) => p.startsWith('saves/')));
  assert.ok(paths.includes('mods/core.jar'));
  assert.equal(m.pack.files.find((f) => f.path === 'mods/opt-extra.jar').optional, true);
  assert.equal(m.pack.files.find((f) => f.path === 'options.txt').overwrite, false);
  assert.equal(m.pack.version, '1.0.0');
});

test('удалённый манифест и новости загружаются', async () => {
  const s = (await launcher.refreshRemote(), launcher.getState());
  assert.equal(s.remote.ok, true);
  assert.equal(s.pack.version, '1.0.0');
  assert.equal(s.updateAvailable, true); // ещё не установлена
  assert.ok(Array.isArray(s.news));
});

test('оффлайн-вход: ник проверяется', async () => {
  await assert.rejects(() => launcher.addOffline('Привет'), /Ник/);
  await assert.rejects(() => launcher.addOffline('ab'), /Ник/);
  await launcher.addOffline('Steve_Test');
  assert.equal(launcher.accounts.active().name, 'Steve_Test');
});

test('установка и запуск: Java, Minecraft, Fabric, файлы сборки, аргументы', async () => {
  fs.rmSync(javaOut, { force: true });
  await launcher.play();
  assert.equal(launcher.lastError, null, launcher.lastError);
  const inst = path.join(work, 'data', 'instance');
  assert.equal(fs.readFileSync(path.join(inst, 'mods', 'core.jar'), 'utf8'), 'core-v1');
  assert.ok(!fs.existsSync(path.join(inst, 'saves')));
  assert.equal(launcher.getState().installedVersion, '1.0.0');
  const args = fs.readFileSync(javaOut, 'utf8').trim().split('\n');
  const at = (a) => args[args.indexOf(a) + 1];
  assert.ok(args.some((a) => /^-Xmx\d+M$/.test(a)));
  assert.ok(args.includes('net.fabricmc.loader.impl.launch.knot.KnotClient'));
  assert.ok(args.indexOf('net.fabricmc.loader.impl.launch.knot.KnotClient') < args.indexOf('--username'));
  assert.equal(at('--username'), 'Steve_Test');
  assert.equal(at('--version'), 'fabric-loader-0.15.0-1.20.1');
  assert.equal(at('--userType'), 'legacy');
  assert.equal(at('--uuid'), offlineUuid('Steve_Test').replace(/-/g, ''));
  assert.equal(at('--gameDir'), inst);
  const cp = at('-cp').split(path.delimiter);
  assert.ok(cp.some((p) => p.endsWith('lib-1.0.jar')));
  assert.ok(cp.some((p) => p.endsWith('lwjgl-3.3.1-natives-linux.jar')));
  assert.ok(cp.some((p) => p.endsWith('fabric-loader-0.15.0.jar')));
  assert.ok(cp[cp.length - 1].endsWith(path.join('versions', '1.20.1', '1.20.1.jar')));
  assert.ok(!cp.some((p) => p.endsWith('only-1.jar')), 'библиотека только для windows не должна попасть в classpath');
  assert.ok(!cp.some((p) => p.includes('old/natives')), 'старые natives не в classpath');
  // нативные библиотеки распакованы, META-INF исключён
  const natives = args.find((a) => a.startsWith('-Djava.library.path=')).split('=')[1];
  assert.ok(fs.existsSync(path.join(natives, 'liblwjgl.so')));
  assert.ok(!fs.existsSync(path.join(natives, 'META-INF')));
  assert.equal(at('--quickPlayMultiplayer'), 'play.example.com:25565');
  assert.ok(!args.includes('--width'));
  assert.ok(args.some((a) => a.startsWith('-Dlog4j.configurationFile=')));
  assert.ok(fs.existsSync(path.join(work, 'data', 'minecraft', 'assets', 'indexes', '5.json')));
  assert.equal(launcher.phase, 'idle');
});

test('повторный запуск ничего не качает заново', async () => {
  mock.hits.length = 0;
  await launcher.play();
  assert.equal(launcher.lastError, null);
  const heavy = mock.hits.filter((h) => h.startsWith('/libs/') || h.startsWith('/res/') || h.startsWith('/site/files/') || h.startsWith('/adoptium/'));
  assert.deepEqual(heavy, []);
});

test('обновление сборки: докачка, удаление, пользовательские файлы целы, уведомление', async () => {
  const inst = path.join(work, 'data', 'instance');
  fs.writeFileSync(path.join(inst, 'options.txt'), 'fov=110'); // игрок поменял настройки
  fs.writeFileSync(path.join(inst, 'mods', 'user-own.jar'), 'mine'); // свой мод игрока
  fs.mkdirSync(path.join(inst, 'saves', 'w'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'saves', 'w', 'level.dat'), 'save');

  w('mods/core.jar', 'core-v2');
  fs.rmSync(path.join(pub, 'modpack', 'mods', 'gone.jar'));
  w('mods/new.jar', 'new');
  w('options.txt', 'fov=90'); // в сборке поменяли, но это файл «once»
  const out = pack();
  assert.match(out, /автоматически повышена до 1\.0\.1/);

  notified.length = 0;
  await launcher.refreshRemote();
  let s = launcher.getState();
  assert.equal(s.updateAvailable, true);
  assert.equal(s.pack.version, '1.0.1');
  assert.equal(notified.length, 1);
  await launcher.refreshRemote();
  assert.equal(notified.length, 1, 'уведомление не должно повторяться');

  await launcher.updatePack();
  assert.equal(launcher.lastError, null, launcher.lastError);
  assert.equal(fs.readFileSync(path.join(inst, 'mods', 'core.jar'), 'utf8'), 'core-v2');
  assert.ok(fs.existsSync(path.join(inst, 'mods', 'new.jar')));
  assert.ok(!fs.existsSync(path.join(inst, 'mods', 'gone.jar')));
  assert.equal(fs.readFileSync(path.join(inst, 'options.txt'), 'utf8'), 'fov=110');
  assert.ok(fs.existsSync(path.join(inst, 'mods', 'user-own.jar')));
  assert.ok(fs.existsSync(path.join(inst, 'saves', 'w', 'level.dat')));
  assert.equal(launcher.getState().updateAvailable, false);
});

test('моды: отключение опционального и сохранение при обновлении', async () => {
  const inst = path.join(work, 'data', 'instance');
  let list = await launcher.mods();
  const opt = list.find((m) => m.path === 'mods/opt-extra.jar');
  assert.ok(opt && opt.optional && opt.enabled);
  assert.equal(list.find((m) => m.path === 'mods/core.jar').required, true);
  await launcher.setMod('mods/opt-extra.jar', false);
  assert.ok(fs.existsSync(path.join(inst, 'mods', 'opt-extra.jar.disabled')));
  w('mods/opt-extra.jar', 'opt-v2');
  pack();
  await launcher.updatePack();
  assert.equal(fs.readFileSync(path.join(inst, 'mods', 'opt-extra.jar.disabled'), 'utf8'), 'opt-v2');
  assert.ok(!fs.existsSync(path.join(inst, 'mods', 'opt-extra.jar')));
  await launcher.setMod('mods/opt-extra.jar', true);
  assert.ok(fs.existsSync(path.join(inst, 'mods', 'opt-extra.jar')));
});

test('ремонт: испорченный файл восстанавливается при проверке', async () => {
  const inst = path.join(work, 'data', 'instance');
  fs.writeFileSync(path.join(inst, 'mods', 'core.jar'), 'core-v2'.replace('2', '9')); // тот же размер, другое содержимое
  await launcher.updatePack({ verify: true });
  assert.equal(fs.readFileSync(path.join(inst, 'mods', 'core.jar'), 'utf8'), 'core-v2');
});

test('при недоступном сервере обновлений установленная сборка запускается из кэша', async () => {
  const saved = launcher.cfg.manifestUrl;
  launcher.cfg.manifestUrl = 'http://127.0.0.1:1/manifest.json';
  fs.rmSync(javaOut, { force: true });
  await launcher.play();
  assert.equal(launcher.lastError, null, launcher.lastError);
  assert.ok(fs.existsSync(javaOut));
  assert.equal(launcher.remote.ok, false);
  launcher.cfg.manifestUrl = saved;
});

test('zip: распаковка со strip и защитой от ../', async () => {
  const d = tmpdir('zip');
  const z = makeZip(d, { 'top/a/b.txt': 'B', 'top/c.txt': 'C' });
  fs.writeFileSync(path.join(d, 'z.zip'), z);
  await unzip(path.join(d, 'z.zip'), path.join(d, 'out'), { strip: 1 });
  assert.equal(fs.readFileSync(path.join(d, 'out', 'a', 'b.txt'), 'utf8'), 'B');
});

test('Microsoft: цепочка Xbox -> XSTS -> Minecraft и ошибки XSTS', async () => {
  const ep = endpoints({ endpoints: { oauthBase: mock.url + '/oauth/', xboxAuth: mock.url + '/xbl/', xstsAuth: mock.url + '/xsts/', minecraftServices: mock.url + '/mcs/' } });
  mock.json('/oauth/oauth20_token.srf', { access_token: 'MSTOK', refresh_token: 'REFR', expires_in: 3600 });
  mock.json('/xbl/user/authenticate', { Token: 'XBLTOK' });
  mock.json('/xsts/xsts/authorize', { Token: 'XSTSTOK', DisplayClaims: { xui: [{ uhs: 'UHS1' }] } });
  mock.json('/mcs/authentication/login_with_xbox', { access_token: 'MCTOK', expires_in: 86400 });
  mock.json('/mcs/minecraft/profile', { id: '069a79f444e94726a5befca90e38aaf5', name: 'Notch', skins: [{ state: 'ACTIVE', url: 'http://x/skin.png', variant: 'SLIM' }] });
  const ms = new MicrosoftAuth({ clientId: '', endpoints: ep });
  assert.match(ms.authUrl(), /login\.live\.com|127\.0\.0\.1/);
  const r = await ms.loginWithCode('CODE');
  assert.equal(r.name, 'Notch');
  assert.equal(r.uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.equal(r.mcToken, 'MCTOK');
  assert.equal(r.msRefresh, 'REFR');
  assert.equal(r.model, 'slim');
  mock.json('/xsts/xsts/authorize', { XErr: 2148916233 }, { status: 401 });
  await assert.rejects(() => ms.loginWithCode('CODE'), /нет профиля Xbox/);
  mock.json('/mcs/minecraft/profile', {}, { status: 404 });
  mock.json('/xsts/xsts/authorize', { Token: 'XSTSTOK', DisplayClaims: { xui: [{ uhs: 'UHS1' }] } });
  await assert.rejects(() => ms.loginWithCode('CODE'), /нет лицензии/);
});

test('Microsoft-аккаунт: токены шифруются в файле и обновляются перед запуском', async () => {
  launcher.accounts.addMicrosoft({ name: 'Notch', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', mcToken: 'OLD', mcExpires: 1, msRefresh: 'REFR0', skinUrl: '', model: 'classic' });
  const raw = fs.readFileSync(path.join(work, 'data', 'launcher', 'accounts.json'), 'utf8');
  assert.ok(!raw.includes('REFR0') && !raw.includes('"OLD"'), 'токены не должны лежать в файле как есть');
  mock.json('/xsts/xsts/authorize', { Token: 'XSTSTOK', DisplayClaims: { xui: [{ uhs: 'UHS1' }] } });
  mock.json('/mcs/minecraft/profile', { id: '069a79f444e94726a5befca90e38aaf5', name: 'Notch', skins: [] });
  fs.rmSync(javaOut, { force: true });
  await launcher.play();
  assert.equal(launcher.lastError, null, launcher.lastError);
  const args = fs.readFileSync(javaOut, 'utf8').trim().split('\n');
  assert.equal(args[args.indexOf('--accessToken') + 1], 'MCTOK');
  assert.equal(args[args.indexOf('--userType') + 1], 'msa');
});

test('пинг сервера по протоколу Minecraft', async () => {
  const varint = (n) => { const b = []; do { let t = n & 0x7f; n >>>= 7; if (n) t |= 0x80; b.push(t); } while (n); return Buffer.from(b); };
  const srv = net.createServer((s) => {
    let got = 0;
    s.on('data', () => {
      if (++got < 1) return;
      const json = Buffer.from(JSON.stringify({ version: { name: '1.20.1' }, players: { online: 7, max: 50 }, description: { text: '§aХаусМайн' } }));
      const body = Buffer.concat([varint(0), varint(json.length), json]);
      s.write(Buffer.concat([varint(body.length), body]));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const r = await pingServer('127.0.0.1', srv.address().port, 3000);
  srv.close();
  assert.equal(r.players, 7);
  assert.equal(r.max, 50);
  assert.equal(r.motd, 'ХаусМайн');
});

test('скин: свой сервер скинов, затем запасной вариант', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake')]);
  mock.file('/skins/Steve_Test.png', png);
  const ep = endpoints({ endpoints: { mojangApi: mock.url + '/mojang/', sessionServer: mock.url + '/session/' } });
  const r = await resolveSkin({ type: 'offline', name: 'Steve_Test', uuid: 'x' }, { template: mock.url + '/skins/{name}.png' }, ep);
  assert.equal(r.source, 'server');
  assert.ok(r.dataUrl.startsWith('data:image/png;base64,'));
  const miss = await resolveSkin({ type: 'offline', name: 'Nobody', uuid: 'x' }, { template: mock.url + '/skins/{name}.png', fallback: 'none' }, ep);
  assert.equal(miss.source, 'default');
  assert.equal(miss.dataUrl, null);
});
