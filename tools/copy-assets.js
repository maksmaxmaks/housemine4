'use strict';
// postinstall: копирует пиксельный шрифт (Pixelify Sans, кириллица) из node_modules в интерфейс лаунчера.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'node_modules', '@fontsource', 'pixelify-sans', 'files');
const dst = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'fonts');
try {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    if (/-(latin|cyrillic)-(400|700)-normal\.woff2$/.test(f)) {
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
      n++;
    }
  }
  console.log(`[assets] шрифтов скопировано: ${n}`);
} catch (e) {
  console.warn('[assets] шрифт не скопирован (будет запасной):', e.message);
}
