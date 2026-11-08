#!/usr/bin/env node
'use strict';
// Управление новостями лаунчера (publish/news.json).
//   npm run news -- add "Заголовок" "Текст новости" [--tag Обновление] [--url https://...] [--image https://...]
//   npm run news -- list
//   npm run news -- remove <id>
// После изменений запустите `npm run pack` (или просто скопируйте news.json на хостинг).
const fs = require('fs');
const path = require('path');
const FILE = path.resolve(__dirname, '..', 'publish', 'news.json');
const SITE = path.resolve(__dirname, '..', 'publish', 'site', 'news.json');
const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => {
  const i = rest.indexOf('--' + n);
  return i < 0 ? undefined : rest[i + 1];
};
const pos = rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
let data = { items: [] };
try {
  data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {}
data.items = data.items || [];
const save = () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  if (fs.existsSync(path.dirname(SITE))) fs.writeFileSync(SITE, JSON.stringify(data, null, 2) + '\n');
};
if (cmd === 'add') {
  const [title, text] = pos;
  if (!title) {
    console.error('Использование: npm run news -- add "Заголовок" "Текст" [--tag Обновление]');
    process.exit(1);
  }
  const item = { id: 'n' + Date.now().toString(36), date: new Date().toISOString(), title, text: text || '' };
  for (const k of ['tag', 'url', 'image']) if (flag(k)) item[k] = flag(k);
  data.items.unshift(item);
  save();
  console.log('✔ Новость добавлена, id = ' + item.id + (fs.existsSync(SITE) ? ' (publish/site/news.json обновлён — загрузите его на хостинг)' : ''));
} else if (cmd === 'remove') {
  const before = data.items.length;
  data.items = data.items.filter((n) => n.id !== pos[0]);
  save();
  console.log(before === data.items.length ? 'Новость не найдена' : '✔ Удалено');
} else if (cmd === 'list') {
  for (const n of data.items) console.log(`${n.id}  ${n.date.slice(0, 10)}  ${n.title}`);
} else {
  console.log('Команды: add | list | remove');
}
