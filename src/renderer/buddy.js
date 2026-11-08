'use strict';
// «Buddy»: трёхмерная модель игрока со скином (как на главном экране Minecraft).
// Свой минимальный WebGL-рендерер без библиотек. Мышь — повернуть, клик — помахать, голова следит за курсором.
(function () {
  const M = {
    id: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
      return o;
    },
    tr(x, y, z) { const m = M.id(); m[12] = x; m[13] = y; m[14] = z; return m; },
    rx(a) { const m = M.id(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; },
    ry(a) { const m = M.id(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; },
    rz(a) { const m = M.id(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; },
    persp(fovy, asp, n, f) {
      const t = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
      m[0] = t / asp; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = (2 * f * n) / (n - f);
      return m;
    },
  };
  const around = (px, py, pz, r) => M.mul(M.tr(px, py, pz), M.mul(r, M.tr(-px, -py, -pz))); // вращение вокруг точки

  // Приводим скин к формату 64x64 (как делает сам Minecraft) и определяем тонкие руки (Alex)
  function processSkin(img) {
    const s = img.width / 64;
    const legacy = img.height * 2 === img.width;
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.width;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    let id = ctx.getImageData(0, 0, cv.width, cv.height);
    const d = id.data, W = cv.width;
    const A = (x, y) => d[((y * s) * W + x * s) * 4 + 3];
    const slim = !legacy && A(55, 20) < 10 && A(55, 31) < 10 && A(54, 25) < 10;
    const px = (x, y) => (y * W + x) * 4;
    if (legacy) {
      const copy = (sx, sy, dx, dy, w, h) => {
        for (let i = 0; i < w * s; i++) for (let j = 0; j < h * s; j++) {
          const from = px(sx * s + i, sy * s + j), to = px((sx + dx) * s + (w * s - 1 - i), (sy + dy) * s + j);
          for (let k = 0; k < 4; k++) d[to + k] = d[from + k];
        }
      };
      [[4, 16, 16, 32, 4, 4], [8, 16, 16, 32, 4, 4], [0, 20, 24, 32, 4, 12], [4, 20, 16, 32, 4, 12], [8, 20, 8, 32, 4, 12], [12, 20, 16, 32, 4, 12],
        [44, 16, -8, 32, 4, 4], [48, 16, -8, 32, 4, 4], [40, 20, 0, 32, 4, 12], [44, 20, -8, 32, 4, 12], [48, 20, -16, 32, 4, 12], [52, 20, -8, 32, 4, 12]]
        .forEach((a) => copy(...a));
      // «шляпа» у старых скинов: если нет прозрачности — убираем область
      let transparent = false;
      for (let x = 32 * s; x < 64 * s && !transparent; x++) for (let y = 0; y < 16 * s; y++) if (d[px(x, y) + 3] < 128) { transparent = true; break; }
      if (!transparent) for (let x = 32 * s; x < 64 * s; x++) for (let y = 0; y < 16 * s; y++) d[px(x, y) + 3] = 0;
    }
    const opaque = (x0, y0, x1, y1) => {
      for (let x = x0 * s; x < x1 * s; x++) for (let y = y0 * s; y < y1 * s; y++) d[px(x, y) + 3] = 255;
    };
    opaque(0, 0, 32, 16); opaque(0, 16, 64, 32); opaque(16, 48, 48, 64);
    ctx.putImageData(id, 0, 0);
    return { canvas: cv, slim };
  }

  const SHADE = { front: 0.92, back: 0.7, right: 0.8, left: 0.8, top: 1, bottom: 0.55 };

  function boxVerts(u, v, w, h, d, inflate) {
    const hx = w / 2 + inflate, hy = h / 2 + inflate, hz = d / 2 + inflate;
    const uv = {
      front: [u + d, v + d, w, h], back: [u + d + w + d, v + d, w, h], right: [u, v + d, d, h],
      left: [u + d + w, v + d, d, h], top: [u + d, v, w, d], bottom: [u + d + w, v, w, d],
    };
    const faces = {
      front: [[-hx, hy, hz], [hx, hy, hz], [hx, -hy, hz], [-hx, -hy, hz]],
      back: [[hx, hy, -hz], [-hx, hy, -hz], [-hx, -hy, -hz], [hx, -hy, -hz]],
      right: [[-hx, hy, -hz], [-hx, hy, hz], [-hx, -hy, hz], [-hx, -hy, -hz]],
      left: [[hx, hy, hz], [hx, hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]],
      top: [[-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz]],
      bottom: [[-hx, -hy, hz], [hx, -hy, hz], [hx, -hy, -hz], [-hx, -hy, -hz]],
    };
    const out = [];
    for (const [name, c] of Object.entries(faces)) {
      const [x, y, ww, hh] = uv[name];
      const t = [[x, y], [x + ww, y], [x + ww, y + hh], [x, y + hh]];
      for (const i of [0, 1, 2, 0, 2, 3]) out.push(c[i][0], c[i][1], c[i][2], t[i][0] / 64, t[i][1] / 64, SHADE[name]);
    }
    return out;
  }

  function partsFor(slim) {
    const aw = slim ? 3 : 4;
    const ax = 4 + aw / 2;
    // name, uv, size, inflate, centre, pivot, overlay
    return [
      { n: 'head', u: 0, v: 0, w: 8, h: 8, d: 8, i: 0, c: [0, 28, 0], p: [0, 24, 0] },
      { n: 'body', u: 16, v: 16, w: 8, h: 12, d: 4, i: 0, c: [0, 18, 0], p: [0, 18, 0] },
      { n: 'rarm', u: 40, v: 16, w: aw, h: 12, d: 4, i: 0, c: [-ax, 18, 0], p: [-ax, 22, 0] },
      { n: 'larm', u: 32, v: 48, w: aw, h: 12, d: 4, i: 0, c: [ax, 18, 0], p: [ax, 22, 0] },
      { n: 'rleg', u: 0, v: 16, w: 4, h: 12, d: 4, i: 0, c: [-2, 6, 0], p: [-2, 12, 0] },
      { n: 'lleg', u: 16, v: 48, w: 4, h: 12, d: 4, i: 0, c: [2, 6, 0], p: [2, 12, 0] },
      { n: 'head', o: 1, u: 32, v: 0, w: 8, h: 8, d: 8, i: 0.5, c: [0, 28, 0], p: [0, 24, 0] },
      { n: 'body', o: 1, u: 16, v: 32, w: 8, h: 12, d: 4, i: 0.25, c: [0, 18, 0], p: [0, 18, 0] },
      { n: 'rarm', o: 1, u: 40, v: 32, w: aw, h: 12, d: 4, i: 0.25, c: [-ax, 18, 0], p: [-ax, 22, 0] },
      { n: 'larm', o: 1, u: 48, v: 48, w: aw, h: 12, d: 4, i: 0.25, c: [ax, 18, 0], p: [ax, 22, 0] },
      { n: 'rleg', o: 1, u: 0, v: 32, w: 4, h: 12, d: 4, i: 0.25, c: [-2, 6, 0], p: [-2, 12, 0] },
      { n: 'lleg', o: 1, u: 0, v: 48, w: 4, h: 12, d: 4, i: 0.25, c: [2, 6, 0], p: [2, 12, 0] },
    ];
  }

  const VS = `attribute vec3 aPos;attribute vec2 aUv;attribute float aShade;uniform mat4 uMvp;varying vec2 vUv;varying float vShade;
void main(){vUv=aUv;vShade=aShade;gl_Position=uMvp*vec4(aPos,1.0);}`;
  const FS = `precision mediump float;uniform sampler2D uTex;varying vec2 vUv;varying float vShade;
void main(){vec4 c=texture2D(uTex,vUv);if(c.a<0.04)discard;gl_FragColor=vec4(c.rgb*vShade*c.a,c.a);}`;

  class Buddy {
    constructor(canvas) {
      this.cv = canvas;
      this.gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
      this.yaw = 0.55; this.targetYaw = 0.55; this.pitch = 0.08;
      this.look = { x: 0, y: 0 }; this.drag = null; this.waveT = -10; this.t0 = performance.now();
      this.slim = false; this.ready = false; this.parts = [];
      if (!this.gl) return;
      const gl = this.gl;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
      this.pr = pr; gl.useProgram(pr);
      this.loc = { pos: gl.getAttribLocation(pr, 'aPos'), uv: gl.getAttribLocation(pr, 'aUv'), sh: gl.getAttribLocation(pr, 'aShade'), mvp: gl.getUniformLocation(pr, 'uMvp'), tex: gl.getUniformLocation(pr, 'uTex') };
      this.tex = gl.createTexture();
      this.buf = gl.createBuffer();
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this._bind();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }
    _bind() {
      const c = this.cv;
      c.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, yaw: this.yaw, moved: false }; c.setPointerCapture(e.pointerId); });
      c.addEventListener('pointermove', (e) => {
        if (!this.drag) return;
        const dx = e.clientX - this.drag.x;
        if (Math.abs(dx) > 3) this.drag.moved = true;
        this.yaw = this.drag.yaw + dx * 0.012;
      });
      const up = () => { if (this.drag && !this.drag.moved) this.waveT = (performance.now() - this.t0) / 1000; this.drag = null; };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      window.addEventListener('pointermove', (e) => {
        const r = c.getBoundingClientRect();
        const sx = r.width ? (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2) : 0;
        const sy = r.height ? (e.clientY - (r.top + r.height * 0.25)) / (window.innerHeight / 2) : 0;
        this.look.x = Math.max(-1, Math.min(1, sx)); this.look.y = Math.max(-1, Math.min(1, sy));
      });
    }
    setSkin(url) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const { canvas, slim } = processSkin(img);
            this._upload(canvas, slim);
          } catch (e) { console.error('skin', e); }
          resolve();
        };
        img.onerror = () => resolve();
        img.src = url;
      });
    }
    _upload(canvas, slim) {
      const gl = this.gl;
      if (!gl) return;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.slim = slim;
      this.parts = partsFor(slim);
      const data = [];
      this.ranges = this.parts.map((p) => {
        const first = data.length / 6;
        data.push(...boxVerts(p.u, p.v, p.w, p.h, p.d, p.i));
        return { first, count: 36 };
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      this.ready = true;
    }
    _loop(now) {
      requestAnimationFrame(this._loop);
      if (!this.ready || document.hidden) return;
      const gl = this.gl, c = this.cv;
      const dpr = Math.min(window.devicePixelRatio || 1, 2) * (this.scale || 1);
      const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const t = (now - this.t0) / 1000;
      if (!this.drag) this.yaw += (this.targetYaw - this.yaw) * 0.04;
      const wave = t - this.waveT;
      const waving = wave >= 0 && wave < 1.6;
      const swing = Math.sin(t * 1.6) * 0.07;
      const breathe = Math.sin(t * 1.6) * 0.25;
      const proj = M.persp(0.55, w / h, 10, 300);
      const view = M.mul(M.tr(0, -17, -78), M.mul(M.rx(0.1 + this.pitch * 0), M.ry(this.yaw)));
      const vp = M.mul(proj, view);
      const anim = (n) => {
        switch (n) {
          case 'head': return M.mul(M.tr(0, breathe * 0.3, 0), around(0, 24, 0, M.mul(M.ry(this.look.x * 0.7), M.rx(this.look.y * 0.35))));
          case 'rarm': return waving
            ? around(-6, 22, 0, M.mul(M.rz(-(Math.PI - 0.5 + Math.sin(wave * 14) * 0.35)), M.id()))
            : around(-6, 22, 0, M.rx(-swing - 0.02));
          case 'larm': return around(6, 22, 0, M.rx(swing + 0.02));
          case 'rleg': return around(-2, 12, 0, M.rx(swing * 0.6));
          case 'lleg': return around(2, 12, 0, M.rx(-swing * 0.6));
          default: return M.tr(0, breathe * 0.2, 0);
        }
      };
      gl.useProgram(this.pr);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.enableVertexAttribArray(this.loc.pos); gl.vertexAttribPointer(this.loc.pos, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(this.loc.uv); gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 24, 12);
      gl.enableVertexAttribArray(this.loc.sh); gl.vertexAttribPointer(this.loc.sh, 1, gl.FLOAT, false, 24, 20);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.loc.tex, 0);
      this.parts.forEach((p, i) => {
        gl.uniformMatrix4fv(this.loc.mvp, false, M.mul(vp, M.mul(anim(p.n), M.tr(p.c[0], p.c[1], p.c[2]))));
        gl.drawArrays(gl.TRIANGLES, this.ranges[i].first, this.ranges[i].count);
      });
    }
  }

  window.Buddy = Buddy;
})();
