/* XquiX Video Analysis — detection core (Phase E test build).
   One implementation for training (Node) and for the Studio (browser), so the classifier is trained on
   exactly the features the browser computes.

   detect(img, H, spec, model, opts) -> { players:[{id, head:[u,v], capPx, waterline:[u,v], detectConf,
                                                    team:'light'|'dark'|'unknown', teamConf, role}], ball }
     img   : { data: RGBA (or RGB with opts.channels=3), width, height }
     H     : world -> image 3x3 (from VAG.fit(refs).H), world = measurement frame of va-geometry.js
     model : exported gradient-boosted trees (va-model.json); null -> candidates only (training)
   Never invents: players come only from image evidence; team 'unknown' when the colour is ambiguous;
   no ball when no ball-like blob is found. Cap numbers are not read at all. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.VADetect = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HEAD_M = 0.22;                 // cap + head width on the water, metres
  const SIGMAS = [3, 4, 5.5, 7, 9.5, 12.5];
  const MAX_PLAYERS = 14;              // 6 + 6 + goalkeeper, + 1 margin (measured: caps false alarms, keeps recall)

  // ---------- small linear algebra ----------
  function inv3(M) {
    const [a, b, c] = M[0], [d, e, f] = M[1], [g, h, i] = M[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
            [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
            [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
  }
  const ap = (M, x, y) => { const s = M[2][0] * x + M[2][1] * y + M[2][2]; return [(M[0][0] * x + M[0][1] * y + M[0][2]) / s, (M[1][0] * x + M[1][1] * y + M[1][2]) / s]; };

  // ---------- colour ----------
  // OpenCV-compatible 8-bit CIELAB (D65): L*255/100, a+128, b+128.
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const fl = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function toLab(img, ch) {
    const n = img.width * img.height, L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    const hue = new Uint8Array(n), sat = new Uint8Array(n), val = new Uint8Array(n), d = img.data;
    for (let p = 0, q = 0; p < n; p++, q += ch) {
      const r8 = d[q], g8 = d[q + 1], b8 = d[q + 2], r = LIN[r8], g = LIN[g8], b = LIN[b8];
      const X = (0.412453 * r + 0.357580 * g + 0.180423 * b) / 0.950456, Y = 0.212671 * r + 0.715160 * g + 0.072169 * b,
            Z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / 1.088754;
      const fy = fl(Y);
      L[p] = (Y > 0.008856 ? 116 * fy - 16 : 903.3 * Y) * 2.55; A[p] = 500 * (fl(X) - fy) + 128; B[p] = 200 * (fy - fl(Z)) + 128;
      // OpenCV-style 8-bit HSV (H 0..180)
      const mx = Math.max(r8, g8, b8), mn = Math.min(r8, g8, b8), df = mx - mn; let h = 0;
      if (df) { if (mx === r8) h = 60 * (g8 - b8) / df; else if (mx === g8) h = 120 + 60 * (b8 - r8) / df; else h = 240 + 60 * (r8 - g8) / df; if (h < 0) h += 360; }
      hue[p] = Math.round(h / 2); sat[p] = mx ? Math.round(255 * df / mx) : 0; val[p] = mx;
    }
    return { L, A, B, hue, sat, val };
  }

  // ---------- filters ----------
  function boxBlur1(src, dst, w, h, r, horiz) {
    const inv = 1 / (2 * r + 1);
    if (horiz) for (let y = 0; y < h; y++) {
      const o = y * w; let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[o + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) { dst[o + x] = acc * inv; acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
    } else for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) { dst[y * w + x] = acc * inv; acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x]; }
    }
  }
  // Gaussian approximated by three box passes (Kovesi's sizes).
  function gauss(src, w, h, s) {
    const n = 3, wIdeal = Math.sqrt(12 * s * s / n + 1); let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const m = Math.round((12 * s * s - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    let a = Float32Array.from(src), b = new Float32Array(src.length);
    for (let i = 0; i < n; i++) { const r = ((i < m ? wl : wl + 2) - 1) / 2; boxBlur1(a, b, w, h, r, true); boxBlur1(b, a, w, h, r, false); }
    return a;
  }
  function maxFilter(src, w, h, r) {           // square (2r+1) max, separable
    const t = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) { let m = -Infinity; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (src[o + k] > m) m = src[o + k]; t[o + x] = m; } }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { let m = -Infinity; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (t[k * w + x] > m) m = t[k * w + x]; out[y * w + x] = m; }
    return out;
  }
  // Water background: per channel, 4x block mean then a 13x13 median (≈ 51 px), bilinear back up.
  function background(ch, w, h) {
    const f = 4, sw = Math.ceil(w / f), sh = Math.ceil(h / f), small = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let s = 0, c = 0;
      for (let yy = y * f; yy < Math.min(h, y * f + f); yy++) for (let xx = x * f; xx < Math.min(w, x * f + f); xx++) { s += ch[yy * w + xx]; c++; }
      small[y * sw + x] = s / c;
    }
    // 13x13 median with a sliding 256-bin histogram (values rounded to integers)
    const r = 6, med = new Float32Array(sw * sh), q = new Uint8Array(sw * sh), hist = new Int32Array(256);
    for (let k = 0; k < sw * sh; k++) q[k] = Math.max(0, Math.min(255, Math.round(small[k])));
    for (let y = 0; y < sh; y++) {
      hist.fill(0); let cnt = 0;
      const ya = Math.max(0, y - r), yb = Math.min(sh - 1, y + r);
      for (let yy = ya; yy <= yb; yy++) for (let xx = 0; xx <= Math.min(sw - 1, r); xx++) { hist[q[yy * sw + xx]]++; cnt++; }
      for (let x = 0; x < sw; x++) {
        if (x > 0) {
          const xo = x - r - 1, xi = x + r;
          if (xo >= 0) for (let yy = ya; yy <= yb; yy++) { hist[q[yy * sw + xo]]--; cnt--; }
          if (xi < sw) for (let yy = ya; yy <= yb; yy++) { hist[q[yy * sw + xi]]++; cnt++; }
        }
        let acc = 0, v = 0; const half = cnt >> 1;
        for (; v < 256; v++) { acc += hist[v]; if (acc > half) break; }
        med[y * sw + x] = v;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        out[y * w + x] = (med[y0 * sw + x0] * (1 - tx) + med[y0 * sw + x1] * tx) * (1 - ty) + (med[y1 * sw + x0] * (1 - tx) + med[y1 * sw + x1] * tx) * ty;
      }
    }
    return out;
  }

  // ---------- geometry maps ----------
  // Expected head diameter in px (lateral scale) and the pool mask, on an 8-px grid, bilinear.
  function geometryMaps(H, w, h, spec) {
    const Hi = inv3(H), st = 8, gw = Math.ceil(w / st) + 1, gh = Math.ceil(h / st) + 1;
    const dg = new Float32Array(gw * gh), inPool = new Uint8Array(gw * gh);
    const halfW = spec.width / 2;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const x = i * st, y = j * st, p0 = ap(Hi, x, y), p1 = ap(Hi, x + 1, y), p2 = ap(Hi, x, y + 1);
      const m = Math.min(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), Math.hypot(p2[0] - p0[0], p2[1] - p0[1]));
      dg[j * gw + i] = m > 0 && isFinite(m) ? HEAD_M / m : 0;
      inPool[j * gw + i] = (isFinite(p0[0]) && p0[0] > -0.3 && p0[0] < 16.5 && Math.abs(p0[1]) < halfW - 0.2) ? 1 : 0;
    }
    const dexp = new Float32Array(w * h), pool = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = y / st, j0 = Math.floor(fy), ty = fy - j0;
      for (let x = 0; x < w; x++) {
        const fx = x / st, i0 = Math.floor(fx), tx = fx - i0, k = j0 * gw + i0;
        dexp[y * w + x] = (dg[k] * (1 - tx) + dg[k + 1] * tx) * (1 - ty) + (dg[k + gw] * (1 - tx) + dg[k + gw + 1] * tx) * ty;
        pool[y * w + x] = inPool[Math.round(fy) * gw + Math.round(fx)];
      }
    }
    return { dexp, pool, Hi };
  }

  // ---------- candidates ----------
  function prepare(img, H, spec, opts) {
    opts = opts || {};
    const w = img.width, h = img.height, ch = opts.channels || 4;
    const lab = toLab(img, ch);
    const bg = { L: background(lab.L, w, h), A: background(lab.A, w, h), B: background(lab.B, w, h) };
    const G = geometryMaps(H, w, h, spec);
    const D = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) if (G.pool[p]) {
      const da = lab.A[p] - bg.A[p], db = lab.B[p] - bg.B[p];
      D[p] = Math.sqrt(da * da + db * db) + 0.35 * Math.abs(lab.L[p] - bg.L[p]);
    }
    for (const o of (opts.exclude || [])) for (let y = Math.max(0, o[1]); y < Math.min(h, o[3]); y++) for (let x = Math.max(0, o[0]); x < Math.min(w, o[2]); x++) D[y * w + x] = 0;
    // scale-normalised LoG at the scale nearest the expected head size
    const resp = new Float32Array(w * h), best = new Float32Array(w * h).fill(1e9);
    const sigExp = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) sigExp[p] = Math.min(SIGMAS[SIGMAS.length - 1], Math.max(SIGMAS[0], G.dexp[p] / (2 * Math.SQRT2)));
    for (const s of SIGMAS) {
      const g = gauss(D, w, h, s);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const p = y * w + x, dd = Math.abs(Math.log(sigExp[p] / s));
        if (dd < best[p]) { best[p] = dd; resp[p] = -s * s * (g[p - 1] + g[p + 1] + g[p - w] + g[p + w] - 4 * g[p]); }
      }
    }
    return { w, h, lab, bg, G, D, resp };
  }

  function candidates(P, H, spec) {
    const { w, h, resp, G } = P, mx = maxFilter(resp, w, h, 10), c = [];
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { const p = y * w + x; if (G.pool[p] && resp[p] > 0 && resp[p] >= mx[p]) c.push([resp[p], x, y]); }
    c.sort((a, b) => b[0] - a[0]);
    const out = [], halfW = spec.width / 2;
    for (const [r, x, y] of c.slice(0, 600)) {
      if (out.length >= 400) break;
      const d = G.dexp[y * w + x]; if (!(d > 4)) continue;
      if (out.some(o => Math.hypot(x - o.cap[0], y - o.cap[1]) < 0.9 * d)) continue;
      const wp = ap(G.Hi, x, y + 0.8 * d);
      if (Math.abs(wp[1]) > halfW - 0.7 || wp[0] < -0.2 || wp[0] > 16) continue;   // ropes, behind the goal line, far half
      out.push({ cap: [x, y], d, resp: r });
    }
    return out;
  }

  // ---------- features ----------
  function sampleArea(get, w, h, x0, y0, x1, y1, ow, oh, out, off, scale) {
    const sx = (x1 - x0) / ow, sy = (y1 - y0) / oh;
    for (let j = 0; j < oh; j++) for (let i = 0; i < ow; i++) {
      const ax = x0 + i * sx, bx = ax + sx, ay = y0 + j * sy, by = ay + sy; let s = 0, c = 0;
      for (let yy = Math.floor(ay); yy < Math.max(Math.floor(ay) + 1, Math.ceil(by)); yy++) for (let xx = Math.floor(ax); xx < Math.max(Math.floor(ax) + 1, Math.ceil(bx)); xx++) {
        s += get(Math.min(w - 1, Math.max(0, xx)), Math.min(h - 1, Math.max(0, yy))); c++;
      }
      out[off + j * ow + i] = s / c * scale;
    }
  }
  function hog(g, gw, gh) {                 // 8 orientations, 6x6 cells, 2x2 blocks, L2-Hys
    const cw = 6, nx = gw / cw, ny = gh / cw, nb = 8, cells = new Float32Array(nx * ny * nb);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const gx = g[y * gw + Math.min(gw - 1, x + 1)] - g[y * gw + Math.max(0, x - 1)], gy = g[Math.min(gh - 1, y + 1) * gw + x] - g[Math.max(0, y - 1) * gw + x];
      const mag = Math.hypot(gx, gy); if (!mag) continue;
      let a = Math.atan2(gy, gx) * 180 / Math.PI; if (a < 0) a += 180; if (a >= 180) a -= 180;
      const f = a / (180 / nb) - 0.5, b0 = Math.floor(f), t = f - b0, c = (Math.floor(y / cw) * nx + Math.floor(x / cw)) * nb;
      cells[c + ((b0 + nb) % nb)] += mag * (1 - t); cells[c + ((b0 + 1) % nb)] += mag * t;
    }
    const out = [];
    for (let by = 0; by < ny - 1; by++) for (let bx = 0; bx < nx - 1; bx++) {
      const v = [];
      for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) for (let k = 0; k < nb; k++) v.push(cells[((by + dy) * nx + bx + dx) * nb + k]);
      let n = Math.sqrt(v.reduce((s, q) => s + q * q, 0) + 1e-6); for (let k = 0; k < v.length; k++) v[k] = Math.min(0.2, v[k] / n);
      n = Math.sqrt(v.reduce((s, q) => s + q * q, 0) + 1e-6); for (const q of v) out.push(q / n);
    }
    return out;
  }
  const NFEAT = 12 * 18 * 3 + 3 * 5 * 32;
  function features(P, x, y, d) {
    const { w, h, lab, bg } = P, W = 1.2 * d, Ht = 1.6 * d, x0 = x - W, x1 = x + W, y0 = y - 0.8 * Ht, y1 = y + 1.6 * Ht;
    const f = new Float32Array(NFEAT);
    const chans = [[lab.L, bg.L], [lab.A, bg.A], [lab.B, bg.B]];
    chans.forEach(([c, b], k) => sampleArea((xx, yy) => c[yy * w + xx] - b[yy * w + xx], w, h, x0, y0, x1, y1, 12, 18, f, k * 216, 1 / 20));
    const g = new Float32Array(24 * 36); sampleArea((xx, yy) => lab.L[yy * w + xx], w, h, x0, y0, x1, y1, 24, 36, g, 0, 1);
    f.set(hog(g, 24, 36), 648);
    return f;
  }

  // ---------- classifier (sklearn HistGradientBoosting, exported) ----------
  function predict(model, f) {
    let s = model.baseline;
    for (const t of model.trees) {
      let n = 0;
      for (;;) {
        const nd = t[n];                     // [feature, threshold, left, right, isLeaf, value, missingLeft]
        if (nd[4]) { s += nd[5]; break; }
        const v = f[nd[0]];
        n = (v !== v) ? (nd[6] ? nd[2] : nd[3]) : (v <= nd[1] ? nd[2] : nd[3]);
      }
    }
    return 1 / (1 + Math.exp(-s));
  }

  // ---------- team, goalkeeper, ball ----------
  function capColour(P, x, y, d) {
    const { w, h, lab, bg } = P, r = Math.max(3, 0.45 * d), cy = y - 0.15 * d, sel = [], all = [];
    for (let yy = Math.max(0, Math.floor(cy - r)); yy <= Math.min(h - 1, Math.floor(cy + r)); yy++) for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(w - 1, Math.floor(x + r)); xx++) {
      if ((xx - x) ** 2 + (yy - cy) ** 2 > r * r) continue;
      const p = yy * w + xx, c = [lab.L[p], lab.A[p], lab.B[p]]; all.push(c);
      const dev = Math.hypot(lab.A[p] - bg.A[p], lab.B[p] - bg.B[p]) + 0.35 * Math.abs(lab.L[p] - bg.L[p]);
      const hh = lab.hue[p], ss = lab.sat[p], skin = hh >= 3 && hh <= 24 && ss >= 40;
      if (dev > 15 && !skin) sel.push(c);
    }
    const use = sel.length >= 4 ? sel : all, med = k => { const v = use.map(c => c[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
    return use.length ? [med(0), med(1), med(2)] : null;
  }
  function teams(cols) {
    const idx = cols.map((c, i) => c ? i : -1).filter(i => i >= 0), out = cols.map(() => ({ team: 'unknown', teamConf: null }));
    if (idx.length < 2) return out;
    let c0 = cols[idx.reduce((a, b) => cols[b][0] > cols[a][0] ? b : a)].slice(), c1 = cols[idx.reduce((a, b) => cols[b][0] < cols[a][0] ? b : a)].slice();
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    for (let it = 0; it < 20; it++) {
      const s = [[0, 0, 0, 0], [0, 0, 0, 0]];
      for (const i of idx) { const k = dist(cols[i], c0) <= dist(cols[i], c1) ? 0 : 1; for (let j = 0; j < 3; j++) s[k][j] += cols[i][j]; s[k][3]++; }
      if (!s[0][3] || !s[1][3]) break;
      c0 = s[0].slice(0, 3).map(v => v / s[0][3]); c1 = s[1].slice(0, 3).map(v => v / s[1][3]);
    }
    const lightIs0 = c0[0] >= c1[0];
    for (const i of idx) {
      const a = dist(cols[i], c0), b = dist(cols[i], c1), near0 = a <= b, margin = (near0 ? b : a) / Math.max(1e-6, near0 ? a : b);
      const team = (near0 === lightIs0) ? 'light' : 'dark';
      out[i] = margin >= 1.5 ? { team, teamConf: Math.min(1, (margin - 1) / 2) } : { team: 'unknown', teamConf: Math.min(1, (margin - 1) / 2) };
    }
    return out;
  }
  function findBall(P, spec) {
    const { w, h, lab, G } = P, m = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) { const hh = lab.hue[p]; m[p] = (hh >= 10 && hh <= 36 && lab.sat[p] >= 60 && lab.val[p] >= 100) ? 1 : 0; }
    // 3x3 opening
    const er = new Uint8Array(w * h), op = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { let v = 1; for (let dy = -1; dy <= 1 && v; dy++) for (let dx = -1; dx <= 1; dx++) if (!m[(y + dy) * w + x + dx]) { v = 0; break; } er[y * w + x] = v; }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { let v = 0; for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1; dx++) if (er[(y + dy) * w + x + dx]) { v = 1; break; } op[y * w + x] = v; }
    const lbl = new Int32Array(w * h), best = []; let n = 0; const stack = [];
    for (let s = 0; s < w * h; s++) if (op[s] && !lbl[s]) {
      n++; lbl[s] = n; stack.push(s); let a = 0, sx = 0, sy = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, per = 0, satSum = 0;
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p / w) | 0; a++; sx += x; sy += y; satSum += lab.sat[p];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        let edge = false;
        for (const q of [p - 1, p + 1, p - w, p + w]) { if (q < 0 || q >= w * h || !op[q]) { edge = true; continue; } if (!lbl[q]) { lbl[q] = n; stack.push(q); } }
        if (edge) per++;
      }
      const cx = sx / a, cy = sy / a, d = G.dexp[Math.round(cy) * w + Math.round(cx)]; if (!(d > 0)) continue;
      const exp = Math.PI * d * d / 4, bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (a < 0.3 * exp || a > 3 * exp || Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) > 1.6 || a / (bw * bh) < 0.55) continue;
      const wp = ap(G.Hi, cx, cy + 1.5 * d);
      if (Math.abs(wp[1]) > spec.width / 2 - 0.5 || wp[0] < -0.3) continue;
      const round = 4 * Math.PI * a / Math.max(1, per * per);
      best.push({ score: Math.min(1, round) + satSum / a / 255, px: [cx, cy] });
    }
    best.sort((p, q) => q.score - p.score);
    return best.length ? { px: best[0].px, conf: Math.min(1, best[0].score / 2) } : null;
  }

  // ---------- the whole reading ----------
  function detect(img, H, spec, model, opts) {
    opts = opts || {};
    spec = Object.assign({ length: 25, width: 20, goalWidth: 3 }, spec || {});
    const t0 = Date.now(), P = prepare(img, H, spec, opts), cand = candidates(P, H, spec);
    if (!model) return { P, candidates: cand };
    const scored = cand.map(c => Object.assign(c, { prob: predict(model, features(P, c.cap[0], c.cap[1], c.d)) }))
      .filter(c => c.prob >= (opts.threshold ?? 0.5)).sort((a, b) => b.prob - a.prob);
    const keep = [];
    for (const c of scored) { if (keep.length >= MAX_PLAYERS) break; if (keep.every(o => Math.hypot(c.cap[0] - o.cap[0], c.cap[1] - o.cap[1]) > 0.9 * c.d)) keep.push(c); }
    // goalkeeper by position (nearest the goal centre within 2.5 m); never by cap colour
    let gk = -1, bestR = Infinity;
    keep.forEach((c, i) => { const wp = ap(P.G.Hi, c.cap[0], c.cap[1] + 0.8 * c.d), r = Math.hypot(wp[0], wp[1]); if (wp[0] < 2.5 && Math.abs(wp[1]) < 2.5 && r < bestR) { bestR = r; gk = i; } });
    const cols = keep.map((c, i) => i === gk ? null : capColour(P, c.cap[0], c.cap[1], c.d)), tm = teams(cols);
    const players = keep.map((c, i) => ({
      id: 'd' + (i + 1), head: [c.cap[0], c.cap[1]], capPx: +c.d.toFixed(1), waterline: [c.cap[0], +(c.cap[1] + 0.9 * c.d).toFixed(1)],
      detectConf: +c.prob.toFixed(2), team: i === gk ? 'unknown' : tm[i].team, teamConf: i === gk ? null : (tm[i].teamConf == null ? null : +tm[i].teamConf.toFixed(2)),
      role: i === gk ? 'goalkeeper' : 'field'
    }));
    const ball = findBall(P, spec);
    return { players, ball, ms: Date.now() - t0, candidates: cand.length };
  }

  return { detect, prepare, candidates, features, predict, NFEAT, MAX_PLAYERS, inv3, ap };
});
