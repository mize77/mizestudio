/* XquiX Video Analysis — automatic field (Phase E lab), v3. Finds the lane lines and reads the field marks from the
   color PATTERN (MIZE, 2026-09-24): 0-2 m is always RED (the rules); 2-6 m is one float color (yellow in most pools,
   white at the Olympics) with a short marker at 5 m; from 6 m another color (green, dark, blue). Each known scheme is
   tried; a new pool color is one entry in SCHEMES. The far lane line needs 0 / 2 / 6 m (5 m if visible), the near
   lane line its 5 m and 6 m (2 m if visible). The field width is not measurable from ropes: 20 m unless the coach
   says otherwise. auto(img, opts) -> { refs, scheme, why:null } or { refs:null, why:'one sentence for the coach' }.
   Pure JS, no DOM: browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.VAField = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CR_TRUE = (5 * 4) / (3 * 6);   // cross-ratio of 0, 2, 5, 6 m: the same under any camera
  const NAMES = { R: 'red', Y: 'yellow', G: 'green', B: 'blue', W: 'white', K: 'dark' };
  // 2-6 m color and the colors that may follow from 6 m
  const SCHEMES = [{ x: 'Y', z: ['G', 'K', 'B'] }, { x: 'W', z: ['B', 'K', 'G'] }];

  // ---------- pixels ----------
  function prep(img, ch) {
    const w = img.width, h = img.height, n = w * h, d = img.data;
    const H = new Uint8Array(n), S = new Uint8Array(n), V = new Uint8Array(n), R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n);
    for (let p = 0, q = 0; p < n; p++, q += ch) {
      const r = d[q], g = d[q + 1], b = d[q + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
      let hh = 0;
      if (df) { if (mx === r) hh = 60 * (g - b) / df; else if (mx === g) hh = 120 + 60 * (b - r) / df; else hh = 240 + 60 * (r - g) / df; if (hh < 0) hh += 360; }
      H[p] = Math.round(hh / 2); S[p] = mx ? Math.round(255 * df / mx) : 0; V[p] = mx; R[p] = r; G[p] = g; B[p] = b;
    }
    // local water background: 4x block mean, 9x9 box, nearest back up (~36 px neighbourhood)
    const f = 4, sw = Math.ceil(w / f), sh = Math.ceil(h / f), sm = [new Float32Array(sw * sh), new Float32Array(sw * sh), new Float32Array(sw * sh)];
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let a = 0, bb = 0, c = 0, k = 0;
      for (let yy = y * f; yy < Math.min(h, y * f + f); yy++) for (let xx = x * f; xx < Math.min(w, x * f + f); xx++) { const p = yy * w + xx; a += R[p]; bb += G[p]; c += B[p]; k++; }
      sm[0][y * sw + x] = a / k; sm[1][y * sw + x] = bb / k; sm[2][y * sw + x] = c / k;
    }
    const bl = sm.map(ch2 => { const o = new Float32Array(sw * sh), r = 4;
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { let s = 0, k = 0; for (let yy = Math.max(0, y - r); yy <= Math.min(sh - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(sw - 1, x + r); xx++) { s += ch2[yy * sw + xx]; k++; } o[y * sw + x] = s / k; }
      return o; });
    const D = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, k = Math.min(sh - 1, (y / f) | 0) * sw + Math.min(sw - 1, (x / f) | 0);
      D[p] = Math.min(255, Math.hypot(R[p] - bl[0][k], G[p] - bl[1][k], B[p] - bl[2][k]));
    }
    return { H, S, V, D, w, h };
  }
  function filt(src, w, h, r, isMax) {
    const t = new Uint8Array(src.length), o = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) { const b = y * w; for (let x = 0; x < w; x++) { let m = isMax ? 0 : 1; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const v = src[b + k]; if (isMax ? v > m : v < m) m = v; } t[b + x] = m; } }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { let m = isMax ? 0 : 1; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { const v = t[k * w + x]; if (isMax ? v > m : v < m) m = v; } o[y * w + x] = m; }
    return o;
  }
  // thin structures that differ from the water (floats of any color), not broad areas (deck, players, overlays)
  function filt(src, w, h, r, isMax) {
    const t = new Uint8Array(src.length), o = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) { const b = y * w; for (let x = 0; x < w; x++) { let m = isMax ? 0 : 1; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const v = src[b + k]; if (isMax ? v > m : v < m) m = v; } t[b + x] = m; } }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { let m = isMax ? 0 : 1; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { const v = t[k * w + x]; if (isMax ? v > m : v < m) m = v; } o[y * w + x] = m; }
    return o;
  }
  // thin structures that differ from the water (floats of any color), not broad areas (deck, players, overlays)
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function ransacLines(flat, nLines, iters, tol, minIn, minExtent) {
    const Rn = rng(7); let n = flat.length / 2;
    let idx = []; for (let i = 0; i < n; i++) idx.push(i);
    if (n > 30000) { for (let i = n - 1; i > 0; i--) { const j = Math.floor(Rn() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } idx = idx.slice(0, 30000); }
    let X = idx.map(i => flat[2 * i]), Y = idx.map(i => flat[2 * i + 1]); const out = [];
    for (let l = 0; l < nLines * 3 && out.length < nLines; l++) {
      n = X.length; if (n < minIn) break;
      let best = null;
      for (let it = 0; it < iters; it++) {
        const i = Math.floor(Rn() * n), j = Math.floor(Rn() * n); const dx = X[j] - X[i], dy = Y[j] - Y[i], L = Math.hypot(dx, dy);
        if (L < 60) continue;
        const nx = -dy / L, ny = dx / L; let c = 0;
        for (let k = 0; k < n; k++) if (Math.abs((X[k] - X[i]) * nx + (Y[k] - Y[i]) * ny) < tol) c++;
        if (!best || c > best.c) best = { c, i, nx, ny };
      }
      if (!best || best.c < minIn) break;
      const inl = [], rest = [[], []];
      for (let k = 0; k < n; k++) { if (Math.abs((X[k] - X[best.i]) * best.nx + (Y[k] - Y[best.i]) * best.ny) < tol) inl.push(k); else { rest[0].push(X[k]); rest[1].push(Y[k]); } }
      let cx = 0, cy = 0; for (const k of inl) { cx += X[k]; cy += Y[k]; } cx /= inl.length; cy /= inl.length;
      let sxx = 0, sxy = 0, syy = 0; for (const k of inl) { const a = X[k] - cx, b = Y[k] - cy; sxx += a * a; sxy += a * b; syy += b * b; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), d = [Math.cos(th), Math.sin(th)];
      let tmin = Infinity, tmax = -Infinity; for (const k of inl) { const t = (X[k] - cx) * d[0] + (Y[k] - cy) * d[1]; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
      X = rest[0]; Y = rest[1];
      if (tmax - tmin < minExtent) continue;               // too short to be a lane line
      out.push({ c: [cx, cy], d, tmin, tmax, n: inl.length });
    }
    return out;
  }

  // thin structures of one float color (rope floats), not broad areas (deck paint, cones, caps, walls)
  function thinPoints(C, X) {
    const { H, S, V, D, w, h } = C, n = w * h, m = new Uint8Array(n);
    for (let p = 0; p < n; p++) m[p] = X === 'Y' ? (H[p] >= 15 && H[p] <= 40 && S[p] >= 60 && V[p] >= 110 ? 1 : 0)
                                      : (S[p] < 50 && V[p] >= 150 && D[p] >= 38 ? 1 : 0);
    const broad = filt(filt(filt(m, w, h, 6, false), w, h, 6, true), w, h, 4, true);
    const pts = [];
    for (let p = 0; p < n; p++) if (m[p] && !broad[p]) pts.push(p % w, (p / w) | 0);
    return pts;
  }
  function classOf(C, p, relaxed) {
    const hh = C.H[p], ss = C.S[p], vv = C.V[p], dd = C.D[p];
    if (relaxed ? (ss >= 25 && vv >= 50 && (hh <= 15 || hh >= 140)) : (ss >= 45 && vv >= 60 && (hh <= 12 || hh >= 150))) return 'R';
    if (ss >= 50 && vv >= 100 && hh >= 15 && hh <= 40) return 'Y';
    if (ss >= 40 && vv >= 40 && hh >= 41 && hh <= 90) return 'G';
    if (ss >= 110 && vv < 210 && hh >= 95 && hh <= 135 && dd >= 45) return 'B';   // blue floats: more saturated and darker than the water around them
    if (ss < 50 && vv >= 150 && dd >= 28) return 'W';
    if (vv < 70 && dd >= 30) return 'K';
    return null;
  }
  function classify(C, u, v, nrm, relaxed, allow) {
    const { w, h } = C;
    if (!(u >= 0 && u < w && v >= 0 && v < h)) return 'x';
    const cnt = { R: 0, Y: 0, G: 0, B: 0, W: 0, K: 0 };
    for (let s = -3; s <= 3; s++) {
      const x = Math.round(u + nrm[0] * s), y = Math.round(v + nrm[1] * s);
      if (!(x >= 0 && x < w && y >= 0 && y < h)) continue;
      const c = classOf(C, y * w + x, relaxed); if (c && (!allow || allow.includes(c))) cnt[c] += c === 'K' ? 0.5 : 1;
    }
    let k = 'o', m = -1; for (const c in cnt) if (cnt[c] > m) { m = cnt[c]; k = c; }
    return m >= 1.5 ? k : 'o';
  }
  function readRope(C, ln, relaxed, allow) {
    const nrm = [-ln.d[1], ln.d[0]], seq = [], ts = [];
    for (let t = ln.tmin - 400; t < ln.tmax + 400; t += 1) { ts.push(t); seq.push(classify(C, ln.c[0] + ln.d[0] * t, ln.c[1] + ln.d[1] * t, nrm, relaxed, allow)); }
    const R = []; let s = 0;
    for (let i = 1; i <= seq.length; i++) if (i === seq.length || seq[i] !== seq[s]) { R.push([seq[s], ts[s], ts[i - 1]]); s = i; }
    const out = [];
    for (const r of R) {
      if (r[0] === 'o' && r[2] - r[1] < 18 && !(out.length && out[out.length - 1][0] === 'x')) continue;
      if (out.length && out[out.length - 1][0] === r[0]) out[out.length - 1][2] = r[2]; else out.push(r.slice());
    }
    return out;
  }
  function fit1d(pairs) {   // t(X) = (aX + b) / (cX + 1), least squares
    const A = pairs.map(([X, t]) => [X, 1, -X * t]), y = pairs.map(([, t]) => t);
    const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Aty = [0, 0, 0];
    A.forEach((r, i) => { for (let a = 0; a < 3; a++) { Aty[a] += r[a] * y[i]; for (let b = 0; b < 3; b++) AtA[a][b] += r[a] * r[b]; } });
    const s = solve3(AtA, Aty); return X => (s[0] * X + s[1]) / (s[2] * X + 1);
  }
  function solve3(M, b) {
    const A = M.map((r, i) => r.concat([b[i]]));
    for (let i = 0; i < 3; i++) { let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k; [A[i], A[p]] = [A[p], A[i]];
      for (let k = 0; k < 3; k++) if (k !== i) { const f = A[k][i] / A[i][i]; for (let j = i; j < 4; j++) A[k][j] -= f * A[i][j]; } }
    return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
  }
  // the 2-6 m span of color X: grow from its longest run over gaps (glare, the 5 m marker, float gaps) that are short
  // against the span so far; stop at the frame edge or at a real section of a 6 m color
  function spanOf(R, X, Z) {
    let i0 = -1; R.forEach((r, i) => { if (r[0] === X && (i0 < 0 || r[2] - r[1] > R[i0][2] - R[i0][1])) i0 = i; });
    if (i0 < 0) return null;
    let a = R[i0][1], b = R[i0][2];
    const stop = r => r[0] === 'x' || (Z.includes(r[0]) && r[2] - r[1] > 10);
    for (const dir of [1, -1]) {
      let j = i0 + dir;
      for (;;) {
        let k = j; while (k >= 0 && k < R.length && R[k][0] !== X && !stop(R[k])) k += dir;
        if (k < 0 || k >= R.length || R[k][0] !== X) break;
        const gap = dir > 0 ? R[k][1] - b : a - R[k][2], len = R[k][2] - R[k][1];
        if (gap > 0.45 * ((b - a) + len)) break;
        if (dir > 0) b = R[k][2]; else a = R[k][1];
        j = k + dir;
      }
    }
    return { a, b };
  }
  /* Parse one lane line (runs R strict, Rr with a relaxed red) for the pattern red | X (5 m marker) | Z.
     Every X section is tried, not only the longest (a white goal area or boom can be longer than the 2-6 m section);
     the parse with the most pattern evidence wins. A line cut by the frame edge yields 5 m and 6 m only. */
  function spansOf(R, X, Z) {
    const out = [], stop = r => r[0] === 'x' || (Z.includes(r[0]) && r[2] - r[1] > 10) || (r[0] === 'R' && r[2] - r[1] > 25);
    R.forEach((r0, i0) => {
      if (r0[0] !== X || r0[2] - r0[1] < 6) return;
      let a = r0[1], b = r0[2];
      for (const dir of [1, -1]) {
        let j = i0 + dir;
        for (;;) {
          let k = j; while (k >= 0 && k < R.length && R[k][0] !== X && !stop(R[k])) k += dir;
          if (k < 0 || k >= R.length || R[k][0] !== X) break;
          const gap = dir > 0 ? R[k][1] - b : a - R[k][2], len = R[k][2] - R[k][1];
          if (gap > 0.45 * ((b - a) + len)) break;
          if (dir > 0) b = R[k][2]; else a = R[k][1];
          j = k + dir;
        }
      }
      if (!out.some(s2 => Math.abs(s2.a - a) < 3 && Math.abs(s2.b - b) < 3)) out.push({ a, b });
    });
    return out;
  }
  function marks(R, Rr, X, Z) {
    Rr = Rr || R;
    let best = null;
    for (const { a, b } of spansOf(R, X, Z)) {
      const L = b - a; if (L < 40) continue;
      const inner = R.filter(r => r[0] !== X && r[0] !== 'o' && r[0] !== 'x' && r[2] - r[1] >= 3 && r[1] > a + 0.05 * L && r[2] < b - 0.05 * L);
      const xs = R.filter(r => r[0] === 'x');
      const borderLo = xs.some(r => r[2] <= a + 2 && a - r[2] < 0.12 * L + 15), borderHi = xs.some(r => r[1] >= b - 2 && r[1] - b < 0.12 * L + 15);
      const redLo = Rr.filter(r => r[0] === 'R' && r[2] - r[1] >= 3 && r[2] <= a + 3 && a - r[2] < 0.25 * L), redHi = Rr.filter(r => r[0] === 'R' && r[2] - r[1] >= 3 && r[1] >= b - 3 && r[1] - b < 0.25 * L);
      const zLo = R.filter(r => Z.includes(r[0]) && r[2] - r[1] >= 8 && r[2] <= a + 3 && a - r[2] < 0.25 * L), zHi = R.filter(r => Z.includes(r[0]) && r[2] - r[1] >= 8 && r[1] >= b - 3 && r[1] - b < 0.25 * L);
      let five = null, fiveR = null;
      let orient = (redLo.length ? 1 : 0) - (redHi.length ? 1 : 0) + (zHi.length ? 1 : 0) - (zLo.length ? 1 : 0);
      if (inner.length) { fiveR = inner.reduce((p, q) => (q[2] - q[1] > p[2] - p[1] ? q : p)); five = (fiveR[1] + fiveR[2]) / 2; orient += (five - a) > (b - five) ? 1 : -1; }
      let cand;
      if (borderLo !== borderHi && (borderLo ? !redLo.length : !redHi.length)) {       // cut by the frame edge
        const six = borderLo ? b : a, zAt = borderLo ? zHi : zLo;
        if (inner.length) { const r = inner.reduce((p, q) => (Math.abs((q[1] + q[2]) / 2 - six) < Math.abs((p[1] + p[2]) / 2 - six) ? q : p)); five = (r[1] + r[2]) / 2; }
        // 6 m is where X ends; a visible change to the 6 m color makes it certain
        cand = { two: null, six, five, zero: null, cut: true, ev: 1 + (zAt.length ? 1 : 0) + (five != null ? 1 : 0) + L / 400 };
      } else {
        if (orient === 0) continue;
        const two = orient > 0 ? a : b, six = orient > 0 ? b : a, toward0 = two === a ? -1 : 1;
        if (!(toward0 < 0 ? redLo : redHi).length) continue;                             // 2 m must be a red -> X change
        if (five != null && Math.abs(five - six) > Math.abs(five - two)) five = null;       // 5 m sits nearer 6 m
        const zAtSix = (toward0 < 0 ? zHi : zLo).length > 0;
        // 0 m: grow the red section from 2 m over float gaps (short against the expected red length) to its end
        const pairs = [[2, two], [6, six]].concat(five != null ? [[5, five]] : []);
        const pred0 = pairs.length >= 3 ? fit1d(pairs)(0) : two + toward0 * Math.abs(six - two) * 0.5, d0 = Math.abs(pred0 - two);
        const grow = RS => { const reds = RS.filter(r => r[0] === 'R' && r[2] - r[1] >= 3 && (toward0 < 0 ? r[2] <= two + 3 : r[1] >= two - 3))
            .sort((p, q) => toward0 < 0 ? q[2] - p[2] : p[1] - q[1]);
          let end = two, got = 0;
          for (const r of reds) { const near = toward0 < 0 ? r[2] : r[1], far2 = toward0 < 0 ? r[1] : r[2];
            if (Math.abs(near - end) > 0.35 * d0 || Math.abs(far2 - two) > 2.2 * d0) break; end = far2; got += r[2] - r[1]; }
          return Math.abs(end - two) >= 0.5 * d0 && got >= 0.25 * Math.abs(end - two) ? end : null; };
        const zero = grow(R) ?? grow(Rr);
        cand = { two, six, five, zero, ev: 2 + (zAtSix ? 1 : 0) + (five != null ? 1 : 0) + (zero != null ? 1 : 0) + L / 400 };
      }
      if (!best || cand.ev > best.ev) best = cand;
    }
    return best;
  }
  function ropes(C, scheme) {
    const pts = thinPoints(C, scheme.x), lines = ransacLines(pts, 4, 1500, 3, 60, 0), out = [];
    for (const ln of lines) {
      const allow = ['R', scheme.x].concat(scheme.z);   // read the line only in this scheme's colors
      const m = marks(readRope(C, ln, false, allow), readRope(C, ln, true, allow), scheme.x, scheme.z); if (!m) continue;
      if (m.cut && m.five == null) continue;               // a cut lane line needs both its 5 m and 6 m
      const P = t => (t == null ? null : [ln.c[0] + ln.d[0] * t, ln.c[1] + ln.d[1] * t]);
      const mk = { 0: P(m.zero), 2: P(m.two), 5: P(m.five), 6: P(m.six) }, n = Object.values(mk).filter(Boolean).length;
      let cr = null, ok = true;
      if (n === 4) { cr = ((m.five - m.zero) * (m.six - m.two)) / ((m.five - m.two) * (m.six - m.zero)); ok = Math.abs(cr / CR_TRUE - 1) < 0.08; }
      out.push({ line: ln, marks: mk, n, cr, crOK: ok, cut: !!m.cut, score: m.ev + (ok && n === 4 ? 2 - 20 * Math.abs(cr / CR_TRUE - 1) : 0) - (ok ? 0 : 4) + Math.min(1, ln.n / 800) });
    }
    return out.sort((p, q) => q.score - p.score);
  }
  /* The standard-color reader (red / yellow / green, va-field-std.js) is proven on the test frames: it runs first. The
     pattern reader below takes over only when it finds nothing, and then only with a complete far lane line (0, 2, 5,
     6 m passing the cross-ratio test) and a goal where the field puts it. */
  const STD = (typeof module === 'object' && module.exports) ? (() => { try { return require('./va-field-std.js'); } catch (e) { return null; } })() : (typeof self !== 'undefined' ? self.VAFieldStd : null);
  function auto(img, opts) {
    opts = opts || {};
    const std = STD || (typeof self !== 'undefined' && self.VAFieldStd);
    let first = null;
    if (std) { first = std.auto(img, opts); if (first.refs) return Object.assign(first, { scheme: { x: 'yellow' }, reader: 'standard' }); }
    const r = autoPattern(img, opts);
    if (r.refs) return Object.assign(r, { reader: 'pattern' });
    return first && !/No lane line/.test(first.why) ? first : r;   // the more specific reason for the coach
  }
  function autoPattern(img, opts) {
    opts = opts || {};
    const width = opts.width || 20, hw = width / 2, t0 = Date.now();
    const C = prep(img, opts.channels || 4);
    let best = null, firstWhy = null, seen = null;
    for (const scheme of SCHEMES) {
      const R = ropes(C, scheme);
      const far = R.filter(r => r.marks[0] && r.crOK && r.n === 4);
      if (!far.length) continue;
      seen = seen || scheme;
      const meanV = r => { const v = Object.values(r.marks).filter(Boolean).map(p => p[1]); return v.reduce((a, b) => a + b, 0) / v.length; };
      for (const f of far.slice(0, 3)) {
        const fl = f.line, nrm = [-fl.d[1], fl.d[0]];
        const distF = p => Math.abs((p[0] - fl.c[0]) * nrm[0] + (p[1] - fl.c[1]) * nrm[1]);
        const near = R.filter(r => r !== f && [2, 5, 6].filter(X => r.marks[X]).length >= 2 && Object.values(r.marks).filter(Boolean).every(p => distF(p) > 40) && meanV(r) > meanV(f));
        for (const n of near) {
          const refs = [];
          for (const X of [0, 2, 5, 6]) if (f.marks[X]) refs.push({ key: 'r' + X, side: 'far', X, Y: hw, u: f.marks[X][0], v: f.marks[X][1] });
          for (const X of [2, 5, 6]) if (n.marks[X]) refs.push({ key: 'r' + X, side: 'near', X, Y: -hw, u: n.marks[X][0], v: n.marks[X][1] });
          const H = fitH(refs); if (!H || !plausible(H, refs, C)) continue;
          const resid = Math.max(...refs.map(q => { const s2 = H[2][0] * q.X + H[2][1] * q.Y + H[2][2]; return Math.hypot((H[0][0] * q.X + H[0][1] * q.Y + H[0][2]) / s2 - q.u, (H[1][0] * q.X + H[1][1] * q.Y + H[1][2]) / s2 - q.v); }));
          if (resid > 0.02 * C.w) continue;
          const goal = goalEvidence(H, C); if (goal < 0.5) continue;       // no goal where this field puts it
          const score = 3 * f.score + n.score - resid / (0.01 * C.w) + goal;   // the far lane line carries the pattern: its evidence weighs most
          if (!best || score > best.score) best = { score, refs, resid, goal, scheme };
        }
      }
    }
    const res = { ms: Date.now() - t0 };
    if (!best) {
      if (!seen) return Object.assign(res, { refs: null, why: 'No lane line with its marks was found from the goal line to 6 m (red to 2 m, then one color to 6 m).' });
      return Object.assign(res, { refs: null, scheme: { x: NAMES[seen.x] }, why: `The near lane line’s 5 m or 6 m section was not found (in this pool: the 5 m marker and the end of the ${NAMES[seen.x]} section).` });
    }
    return Object.assign(res, { refs: best.refs, resid: best.resid, goal: best.goal, scheme: { x: NAMES[best.scheme.x] }, why: null });
  }
  // DLT (normalised) + pixel refinement
  function fitH(refs) {
    const n = refs.length; if (n < 4) return null;
    const mx = refs.reduce((s2, q) => s2 + q.X, 0) / n, my = refs.reduce((s2, q) => s2 + q.Y, 0) / n, mu = refs.reduce((s2, q) => s2 + q.u, 0) / n, mv = refs.reduce((s2, q) => s2 + q.v, 0) / n;
    const sw = Math.SQRT2 / (refs.reduce((s2, q) => s2 + Math.hypot(q.X - mx, q.Y - my), 0) / n), si = Math.SQRT2 / (refs.reduce((s2, q) => s2 + Math.hypot(q.u - mu, q.v - mv), 0) / n);
    // 8x8 least squares with h33 = 1 in normalised coordinates
    const A = [], b = [];
    for (const q of refs) { const X = (q.X - mx) * sw, Y = (q.Y - my) * sw, u = (q.u - mu) * si, v = (q.v - mv) * si;
      A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); b.push(u); A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(v); }
    const AtA = [], Atb = [];
    for (let i = 0; i < 8; i++) { AtA.push(new Array(8).fill(0)); Atb.push(0); for (let r = 0; r < A.length; r++) { Atb[i] += A[r][i] * b[r]; for (let j = 0; j < 8; j++) AtA[i][j] += A[r][i] * A[r][j]; } }
    const h = solveN(AtA, Atb); if (!h) return null;
    const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
    const Ti = [[1 / si, 0, mu], [0, 1 / si, mv], [0, 0, 1]], S2 = [[sw, 0, -sw * mx], [0, sw, -sw * my], [0, 0, 1]];
    const mm = (P2, Q) => P2.map((row, i) => [0, 1, 2].map(j => row[0] * Q[0][j] + row[1] * Q[1][j] + row[2] * Q[2][j]));
    const H = mm(mm(Ti, Hn), S2);
    return refineH(H, refs);
  }
  /* A field that can be real: the camera sees the water plane from one side (all references in front of it), the
     goal (0, +-1.5) lies in or near the frame, and the far side projects above the near side at the goal line. */
  /* The requirement "goal fully visible" gives a check that ropes alone cannot: where this calibration puts the goal
     posts, the image must show two light, upright bars from the water to about 0.9 m up. Returns 0..1 (share of the
     expected post pixels that are light and unsaturated, the better post of the two weighted with the worse). */
  function goalEvidence(H, C) {
    const pr = (X, Y) => { const s2 = H[2][0] * X + H[2][1] * Y + H[2][2]; return [(H[0][0] * X + H[0][1] * Y + H[0][2]) / s2, (H[1][0] * X + H[1][1] * Y + H[1][2]) / s2]; };
    const one = Y => {
      const b = pr(0, Y), l = pr(0, Y + 0.5), px = Math.hypot(l[0] - b[0], l[1] - b[1]) * 2;   // px per metre across
      const top = 0.9 * px; if (!(top > 4) || b[0] < 0 || b[0] >= C.w || b[1] < 0 || b[1] >= C.h) return 0;
      let hit = 0, n = 0;
      for (let k = 2; k <= top; k += 1) {
        const y = Math.round(b[1] - k); if (y < 0) break; n++;
        let got = false;
        for (let dx = -5; dx <= 5 && !got; dx++) { const x = Math.round(b[0] + dx); if (x < 0 || x >= C.w) continue; const p = y * C.w + x; if (C.V[p] >= 150 && C.S[p] <= 80) got = true; }
        if (got) hit++;
      }
      return n ? hit / n : 0;
    };
    const a1 = one(-1.5), a2 = one(1.5);
    return 0.5 * Math.max(a1, a2) + 0.5 * Math.min(a1, a2);
  }
  function plausible(H, refs, C) {
    const pr = (X, Y) => { const s2 = H[2][0] * X + H[2][1] * Y + H[2][2]; return { s: s2, p: [(H[0][0] * X + H[0][1] * Y + H[0][2]) / s2, (H[1][0] * X + H[1][1] * Y + H[1][2]) / s2] }; };
    const sg = Math.sign(pr(refs[0].X, refs[0].Y).s);
    const test = [[0, -10], [0, 10], [6, -10], [6, 10], [0, 0], [3, 0]];
    if (!test.every(([X, Y]) => Math.sign(pr(X, Y).s) === sg)) return false;          // the field crosses the horizon
    const g = pr(0, 0).p; if (!(g[0] > -0.3 * C.w && g[0] < 1.3 * C.w && g[1] > -0.3 * C.h && g[1] < 1.3 * C.h)) return false;
    return true;
  }

  /* Refine a world->image homography by minimising the reprojection error in pixels (Levenberg-Marquardt on the 8
     free entries, h33 = 1). The algebraic DLT alone is poorly conditioned when the references lie on two ropes. */
  function refineH(H0, refs, iters) {
    let h = [H0[0][0], H0[0][1], H0[0][2], H0[1][0], H0[1][1], H0[1][2], H0[2][0], H0[2][1]].map(v => v / H0[2][2]);
    const res = hh => { const r = []; for (const q of refs) { const s = hh[6] * q.X + hh[7] * q.Y + 1; r.push((hh[0] * q.X + hh[1] * q.Y + hh[2]) / s - q.u, (hh[3] * q.X + hh[4] * q.Y + hh[5]) / s - q.v); } return r; };
    let lam = 1e-3, r = res(h), cost = r.reduce((a, b) => a + b * b, 0);
    for (let it = 0; it < (iters || 60); it++) {
      const J = []; const eps = h.map(v => Math.max(1e-8, Math.abs(v) * 1e-6));
      for (let k = 0; k < 8; k++) { const hp = h.slice(); hp[k] += eps[k]; const rp = res(hp); J.push(rp.map((v, i) => (v - r[i]) / eps[k])); }
      const A = []; const g = [];
      for (let a = 0; a < 8; a++) { A.push([]); let s = 0; for (let i = 0; i < r.length; i++) s += J[a][i] * r[i]; g.push(-s); for (let b = 0; b < 8; b++) { let t = 0; for (let i = 0; i < r.length; i++) t += J[a][i] * J[b][i]; A[a].push(t); } }
      let improved = false;
      for (let tries = 0; tries < 8 && !improved; tries++) {
        const M = A.map((row, a) => row.map((v, b) => v + (a === b ? lam * (A[a][a] || 1) : 0)));
        const d = solveN(M, g); if (!d) { lam *= 10; continue; }
        const hn = h.map((v, k) => v + d[k]), rn = res(hn), cn = rn.reduce((a, b) => a + b * b, 0);
        if (cn < cost) { const big = cost - cn > 1e-9 * cost; h = hn; r = rn; cost = cn; lam = Math.max(1e-9, lam / 10); if (!big) return pack(h); improved = true; }
        else lam *= 10;
      }
      if (!improved) break;
    }
    return pack(h);
    function pack(v) { return [[v[0], v[1], v[2]], [v[3], v[4], v[5]], [v[6], v[7], 1]]; }
  }
  function solveN(M, b) {
    const n = b.length, A = M.map((r, i) => r.concat([b[i]]));
    for (let i = 0; i < n; i++) { let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k; if (Math.abs(A[p][i]) < 1e-300) return null; [A[i], A[p]] = [A[p], A[i]];
      for (let k = 0; k < n; k++) if (k !== i) { const f = A[k][i] / A[i][i]; for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j]; } }
    return A.map((r, i) => r[n] / r[i]);
  }
  return { auto, autoPattern, ropes, refineH, fitH, prep, goalEvidence, SCHEMES, CR_TRUE };
});
