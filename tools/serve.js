#!/usr/bin/env node
'use strict';
// Локальный сервер для проверки: раздаёт publish/site на http://localhost:8080/
// Запуск лаунчера для теста:  HM_BASE_URL=http://localhost:8080/ npm start
const http = require('http');
const fs = require('fs');
const path = require('path');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'publish', 'site'));
const port = +process.argv[3] || 8080;
const types = { '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8' };
http
  .createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const full = path.resolve(dir, '.' + p);
    if (!full.startsWith(dir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Content-Length': fs.statSync(full).size });
    fs.createReadStream(full).pipe(res);
  })
  .listen(port, () => console.log(`Раздаю ${dir} на http://localhost:${port}/`));
