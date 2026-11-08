'use strict';
const path = require('path');

// Все данные лаунчера лежат в одной папке (в Windows: %APPDATA%\.hausmine4)
function makePaths(root) {
  const j = (...p) => path.join(root, ...p);
  return {
    root,
    launcherDir: j('launcher'),
    settingsFile: j('launcher', 'settings.json'),
    accountsFile: j('launcher', 'accounts.json'),
    manifestCache: j('launcher', 'manifest-cache.json'),
    newsCache: j('launcher', 'news-cache.json'),
    logFile: j('launcher', 'launcher.log'),
    cacheDir: j('cache'),
    mc: j('minecraft'), // libraries / assets / versions (общие для всех версий)
    instance: j('instance'), // игровая папка сборки: mods, config, saves ...
    stateFile: j('instance', '.hausmine', 'state.json'),
    runtime: j('runtime'), // скачанные Java
  };
}
module.exports = { makePaths };
