'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmpdir = (n) => fs.mkdtempSync(path.join(os.tmpdir(), 'hm-' + n + '-'));

// Мини-сервер, имитирующий Mojang / Fabric / Adoptium / Microsoft / сайт с обновлениями
async function startMock() {
  const routes = new Map();
  let siteDir = null;
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    mock.hits.push(p);
    if (siteDir && p.startsWith('/site/')) {
      const f = path.join(siteDir, p.slice(6));
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'Content-Type': f.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
        return res.end(fs.readFileSync(f));
      }
    }
    const r = routes.get(p);
    if (!r) {
      res.writeHead(404);
      return res.end('nf');
    }
    const handler = typeof r === 'function' ? r(req) : r;
    res.writeHead(handler.status || 200, { 'Content-Type': handler.type || 'application/octet-stream' });
    res.end(handler.body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port;
  const mock = {
    url, hits: [],
    json(p, obj, extra = {}) { routes.set(p, { body: JSON.stringify(obj), type: 'application/json', ...extra }); },
    file(p, buf) { routes.set(p, { body: buf }); return { sha1: sha1(buf), size: buf.length }; },
    raw(p, handler) { routes.set(p, handler); },
    setSite(d) { siteDir = d; },
    close() { return new Promise((r) => srv.close(r)); },
  };
  return mock;
}

function makeZip(dir, files) {
  // files: { 'a/b.txt': 'content' } -> zip bytes (через системную утилиту zip)
  const src = tmpdir('zipsrc');
  for (const [n, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, n)), { recursive: true });
    fs.writeFileSync(path.join(src, n), c);
  }
  const out = path.join(dir, 'x.zip');
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-qr', out, '.'], { cwd: src });
  return fs.readFileSync(out);
}

module.exports = { startMock, sha1, tmpdir, makeZip };
