'use strict';
// Пинг сервера по протоколу Minecraft Server List Ping.
const net = require('net');

function varint(n) {
  const b = [];
  do {
    let t = n & 0x7f;
    n >>>= 7;
    if (n) t |= 0x80;
    b.push(t);
  } while (n);
  return Buffer.from(b);
}
const pack = (buf) => Buffer.concat([varint(buf.length), buf]);
function readVarint(buf, off = 0) {
  let r = 0, shift = 0, i = off;
  for (;;) {
    if (i >= buf.length) return null;
    const b = buf[i++];
    r |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 35) throw new Error('bad varint');
  }
  return { value: r, size: i - off };
}

function pingServer(host, port = 25565, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const fail = (e) => {
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(timeout, () => fail(new Error('timeout')));
    sock.on('error', fail);
    sock.on('connect', () => {
      const h = Buffer.from(host, 'utf8');
      const port2 = Buffer.alloc(2);
      port2.writeUInt16BE(port);
      sock.write(pack(Buffer.concat([varint(0), varint(767), varint(h.length), h, port2, varint(1)])));
      sock.write(pack(varint(0)));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const len = readVarint(buf);
      if (!len || buf.length < len.size + len.value) return;
      const body = buf.subarray(len.size, len.size + len.value);
      const id = readVarint(body);
      const sl = readVarint(body, id.size);
      const json = body.toString('utf8', id.size + sl.size, id.size + sl.size + sl.value);
      sock.destroy();
      try {
        const j = JSON.parse(json);
        let motd = j.description;
        if (motd && typeof motd === 'object') motd = (motd.text || '') + (motd.extra ? motd.extra.map((x) => x.text || '').join('') : '');
        resolve({
          online: true,
          players: (j.players && j.players.online) || 0,
          max: (j.players && j.players.max) || 0,
          version: j.version && j.version.name,
          motd: String(motd || '').replace(/§./g, ''),
          ping: Date.now() - started,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

module.exports = { pingServer };
