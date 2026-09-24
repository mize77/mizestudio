/* XquiX Video Analysis — automatic field, STANDARD colors (Phase E lab; loaded by va-field.js, tried first). Finds the lane ropes by their float colors and reads the
   field marks from the color changes (MIZE's scheme, 2026-09-24): 0-2 m red, 2-6 m yellow with a short red run at 5 m,
   green (or dark) beyond 6 m. Needs the far rope's 0 / 2 / 6 m (5 m if visible) and the near rope's 5 m and 6 m
   (2 m too if visible). The field width is not measurable from ropes: 20 m unless the coach says otherwise.
   auto(img, opts) -> { refs:[{key, side, X, Y, u, v}], why:null } or { refs:null, why:'one sentence for the coach' }.
   Pure JS, no DOM: runs in the browser and in Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.VAFieldStd = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CR_TRUE = (5 * 4) / (3 * 6);   // cross-ratio of 0, 2, 5, 6 m: the same under any camera

  // OpenCV-style 8-bit HSV (H 0..180)
  function hsv(img, ch) {
    const n = img.width * img.height, H = new Uint8Array(n), S = new Uint8Array(n), V = new Uint8Array(n), d = img.data;
    for (let p = 0, q = 0; p < n; p++, q += ch) {
      const r = d[q], g = d[q + 1], b = d[q + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
      let h = 0;
      if (df) { if (mx === r) h = 60 * (g - b) / df; else if (mx === g) h = 120 + 60 * (b - r) / df; else h = 240 + 60 * (r - g) / df; if (h < 0) h += 360; }
      H[p] = Math.round(h / 2); S[p] = mx ? Math.round(255 * df / mx) : 0; V[p] = mx;
    }
    return { H, S, V, w: img.width, h: img.height };
  }
  // separable square min / max filters (morphology)
  function filt(src, w, h, r, isMax) {
    const t = new Uint8Array(src.length), o = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) { const b = y * w; for (let x = 0; x < w; x++) { let m = isMax ? 0 : 1; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const v = src[b + k]; if (isMax ? v > m : v < m) m = v; } t[b + x] = m; } }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { let m = isMax ? 0 : 1; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { const v = t[k * w + x]; if (isMax ? v > m : v < m) m = v; } o[y * w + x] = m; }
    return o;
  }
  // thin yellow structures (rope floats), not broad yellow areas (deck paint, cones, caps)
  function thinYellow(C) {
    const { H, S, V, w, h } = C, n = w * h, m = new Uint8Array(n);
    for (let p = 0; p < n; p++) m[p] = (H[p] >= 15 && H[p] <= 40 && S[p] >= 60 && V[p] >= 110) ? 1 : 0;
    const broad = filt(filt(filt(m, w, h, 6, false), w, h, 6, true), w, h, 4, true);   // opening, then grow
    const pts = [];
    for (let p = 0; p < n; p++) if (m[p] && !broad[p]) pts.push(p % w, (p / w) | 0);
    return pts;
  }
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function ransacLines(flat, nLines, iters, tol, minIn) {
    const R = rng(7); let n = flat.length / 2;
    // subsample to at most 20000 points
    let idx = []; for (let i = 0; i < n; i++) idx.push(i);
    if (n > 20000) { for (let i = n - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } idx = idx.slice(0, 20000); }
    let X = idx.map(i => flat[2 * i]), Y = idx.map(i => flat[2 * i + 1]); const out = [];
    for (let l = 0; l < nLines; l++) {
      n = X.length; if (n < minIn) break;
      let best = null;
      for (let it = 0; it < iters; it++) {
        const i = Math.floor(R() * n), j = Math.floor(R() * n); const dx = X[j] - X[i], dy = Y[j] - Y[i], L = Math.hypot(dx, dy);
        if (L < 30) continue;
        const nx = -dy / L, ny = dx / L; let c = 0;
        for (let k = 0; k < n; k++) if (Math.abs((X[k] - X[i]) * nx + (Y[k] - Y[i]) * ny) < tol) c++;
        if (!best || c > best.c) best = { c, i, nx, ny };
      }
      if (!best || best.c < minIn) break;
      const inl = [], rest = [[], []];
      for (let k = 0; k < n; k++) { if (Math.abs((X[k] - X[best.i]) * best.nx + (Y[k] - Y[best.i]) * best.ny) < tol) inl.push(k); else { rest[0].push(X[k]); rest[1].push(Y[k]); } }
      // PCA refine
      let cx = 0, cy = 0; for (const k of inl) { cx += X[k]; cy += Y[k]; } cx /= inl.length; cy /= inl.length;
      let sxx = 0, sxy = 0, syy = 0; for (const k of inl) { const a = X[k] - cx, b = Y[k] - cy; sxx += a * a; sxy += a * b; syy += b * b; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), d = [Math.cos(th), Math.sin(th)];
      let tmin = Infinity, tmax = -Infinity; for (const k of inl) { const t = (X[k] - cx) * d[0] + (Y[k] - cy) * d[1]; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
      out.push({ c: [cx, cy], d, tmin, tmax, n: inl.length });
      X = rest[0]; Y = rest[1];
    }
    return out;
  }
  function classify(C, u, v, nrm, relaxed) {
    const { H, S, V, w, h } = C;
    if (!(u >= 0 && u < w && v >= 0 && v < h)) return 'x';
    const cnt = { R: 0, Y: 0, G: 0, o: 0 };
    for (let s = -3; s <= 3; s++) {
      const x = Math.round(u + nrm[0] * s), y = Math.round(v + nrm[1] * s);
      if (!(x >= 0 && x < w && y >= 0 && y < h)) continue;
      const p = y * w + x, hh = H[p], ss = S[p], vv = V[p];
      if (relaxed ? (ss >= 25 && vv >= 50 && (hh <= 15 || hh >= 140)) : (ss >= 45 && vv >= 60 && (hh <= 12 || hh >= 150))) cnt.R++;
      else if (ss >= 50 && vv >= 100 && hh >= 15 && hh <= 40) cnt.Y++;
      else if (ss >= 40 && vv >= 40 && hh >= 41 && hh <= 90) cnt.G++;
      else if (vv < 70) cnt.G += 0.5;             // dark rope beyond 6 m
      else cnt.o++;
    }
    let k = 'o', m = -1; for (const c in cnt) if (cnt[c] > m) { m = cnt[c]; k = c; }
    return m >= 1.5 ? k : 'o';
  }
  function readRope(C, ln, relaxed) {
    const nrm = [-ln.d[1], ln.d[0]], seq = [], ts = [];
    for (let t = ln.tmin - 400; t < ln.tmax + 400; t += 1) { ts.push(t); seq.push(classify(C, ln.c[0] + ln.d[0] * t, ln.c[1] + ln.d[1] * t, nrm, relaxed)); }
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
  // the yellow 2-6 m span: grow from the longest yellow run over gaps (glare, the red 5 m marker, float gaps) that are
  // short against the span so far; stop at the frame edge or at a real green section (beyond 6 m)
  function yellowSpan(R) {
    let i0 = -1; R.forEach((r, i) => { if (r[0] === 'Y' && (i0 < 0 || r[2] - r[1] > R[i0][2] - R[i0][1])) i0 = i; });
    if (i0 < 0) return null;
    let a = R[i0][1], b = R[i0][2];
    const stop = r => r[0] === 'x' || (r[0] === 'G' && r[2] - r[1] > 10);
    for (const dir of [1, -1]) {
      let j = i0 + dir;
      for (;;) {
        let k = j; while (k >= 0 && k < R.length && R[k][0] !== 'Y' && !stop(R[k])) k += dir;
        if (k < 0 || k >= R.length || R[k][0] !== 'Y') break;
        const gap = dir > 0 ? R[k][1] - b : a - R[k][2], len = R[k][2] - R[k][1];
        if (gap > 0.45 * ((b - a) + len)) break;
        if (dir > 0) b = R[k][2]; else a = R[k][1];
        j = k + dir;
      }
    }
    return { a, b };
  }
  /* R: the rope read with strict colors; Rr: read again with a relaxed red (a faded or compressed red 0-2 m section
     still counts as red there) - used only for the red evidence at the 2 m end and for the 0 m end. */
  function marks(R, Rr) {
    Rr = Rr || R;
    const sp = yellowSpan(R); if (!sp) return null;
    const { a, b } = sp, L = b - a; if (L < 40) return null;
    const inner = R.filter(r => r[0] === 'R' && r[1] > a + 0.05 * L && r[2] < b - 0.05 * L);
    const xs = R.filter(r => r[0] === 'x');
    const borderLo = xs.some(r => r[2] <= a + 2 && a - r[2] < 0.12 * L + 15), borderHi = xs.some(r => r[1] >= b - 2 && r[1] - b < 0.12 * L + 15);
    const redLo = Rr.filter(r => r[0] === 'R' && r[2] - r[1] >= 3 && r[2] <= a + 3 && a - r[2] < 0.25 * L), redHi = Rr.filter(r => r[0] === 'R' && r[2] - r[1] >= 3 && r[1] >= b - 3 && r[1] - b < 0.25 * L);
    // green beyond 6 m must be a real section, not a speck of glare-tinted water
    const grLo = R.filter(r => r[0] === 'G' && r[2] - r[1] >= 8 && r[2] <= a + 3 && a - r[2] < 0.25 * L), grHi = R.filter(r => r[0] === 'G' && r[2] - r[1] >= 8 && r[1] >= b - 3 && r[1] - b < 0.25 * L);
    let five = null;
    // which end is 2 m: red beyond it, green beyond the other, and the 5 m marker nearer the 6 m end
    let score = (redLo.length - redHi.length) + (grHi.length - grLo.length);
    if (inner.length) { const r = inner.reduce((p, q) => (q[2] - q[1] > p[2] - p[1] ? q : p)); five = (r[1] + r[2]) / 2; score += (five - a) > (b - five) ? 2 : -2; }
    // a rope cut by the frame edge: the edge is not a mark
    if (borderLo !== borderHi && (borderLo ? !redLo.length : !redHi.length)) {
      const six = borderLo ? b : a;
      if (inner.length) { const r = inner.reduce((p, q) => (Math.abs((q[1] + q[2]) / 2 - six) < Math.abs((p[1] + p[2]) / 2 - six) ? q : p)); five = (r[1] + r[2]) / 2; }
      return { two: null, six, five, zero: null, cut: true };
    }
    if (score === 0) return null;
    const two = score > 0 ? a : b, six = score > 0 ? b : a, toward0 = two === a ? -1 : 1;
    const beyond = toward0 < 0 ? redLo : redHi;
    if (!beyond.length) return null;                        // the 2 m end must be a real red->yellow change
    const pairs = [[2, two], [6, six]].concat(five != null ? [[5, five]] : []);
    const pred0 = pairs.length >= 3 ? fit1d(pairs)(0) : two + toward0 * Math.abs(six - two) * 0.5, d0 = Math.abs(pred0 - two);
    // 0 m: the red section's far end. Prefer a clearly red end; the relaxed reading only when none is clear
    // (it also picks up the red of a boom or deck beyond the rope, so it is the second choice).
    const endsOf = RS => RS.filter(r => r[0] === 'R' && r[2] - r[1] >= 3 && (toward0 < 0 ? r[2] <= two + 3 : r[1] >= two - 3)).map(r => toward0 < 0 ? r[1] : r[2])
      .filter(e => Math.abs(e - two) >= 0.5 * d0 && Math.abs(e - two) <= 2.0 * d0);
    const pick = es => es.length ? es.reduce((p, q) => (Math.abs(q - pred0) < Math.abs(p - pred0) ? q : p)) : null;
    const zero = pick(endsOf(R)) ?? pick(endsOf(Rr));
    return { two, six, five, zero };
  }
  function ropes(C) {
    const pts = thinYellow(C), lines = ransacLines(pts, 4, 1500, 3, 60), out = [];
    for (const ln of lines) {
      const m = marks(readRope(C, ln), readRope(C, ln, true)); if (!m) continue;
      if (m.cut && m.five == null) continue;               // a cut rope needs both its 5 m and 6 m
      const P = t => (t == null ? null : [ln.c[0] + ln.d[0] * t, ln.c[1] + ln.d[1] * t]);
      const mk = { 0: P(m.zero), 2: P(m.two), 5: P(m.five), 6: P(m.six) }, n = Object.values(mk).filter(Boolean).length;
      let cr = null, ok = true;
      if (n === 4) { cr = ((m.five - m.zero) * (m.six - m.two)) / ((m.five - m.two) * (m.six - m.zero)); ok = Math.abs(cr / CR_TRUE - 1) < 0.08; }
      out.push({ line: ln, marks: mk, n, cr, crOK: ok, cut: !!m.cut, score: n + (ok && n === 4 ? 1 : 0) - (ok ? 0 : 3) + Math.min(1, ln.n / 800) });
    }
    return out.sort((p, q) => q.score - p.score);
  }
  function auto(img, opts) {
    opts = opts || {};
    const width = opts.width || 20, hw = width / 2, t0 = Date.now();
    const C = hsv(img, opts.channels || 4), R = ropes(C);
    const far = R.filter(r => r.marks[0] && r.n >= 3 && r.crOK);
    const res = { ropes: R.length, ms: 0 };
    if (!far.length) return Object.assign(res, { refs: null, why: 'No lane line with its colored marks was found from the goal line to 6 m (red to 2 m, yellow to 6 m).', ms: Date.now() - t0 });
    const f = far[0], fl = f.line, nrm = [-fl.d[1], fl.d[0]];
    const distF = p => Math.abs((p[0] - fl.c[0]) * nrm[0] + (p[1] - fl.c[1]) * nrm[1]);
    const meanV = r => { const v = Object.values(r.marks).filter(Boolean).map(p => p[1]); return v.reduce((a, b) => a + b, 0) / v.length; };
    const fy = meanV(f);
    const near = R.filter(r => r !== f && [2, 5, 6].filter(X => r.marks[X]).length >= 2 && Object.values(r.marks).filter(Boolean).every(p => distF(p) > 40) && meanV(r) > fy);
    if (!near.length) return Object.assign(res, { refs: null, why: 'The near lane line’s 5 m or 6 m section was not found (the red 5 m marker and the change from yellow to green).', far: f, ms: Date.now() - t0 });
    const n = near.reduce((p, q) => (q.n > p.n || (q.n === p.n && meanV(q) > meanV(p)) ? q : p));
    const refs = [];
    for (const X of [0, 2, 5, 6]) if (f.marks[X]) refs.push({ key: 'r' + X, side: 'far', X, Y: hw, u: f.marks[X][0], v: f.marks[X][1] });
    for (const X of [2, 5, 6]) if (n.marks[X]) refs.push({ key: 'r' + X, side: 'near', X, Y: -hw, u: n.marks[X][0], v: n.marks[X][1] });
    return Object.assign(res, { refs, why: null, far: f, near: n, ms: Date.now() - t0 });
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
        if (cn < cost) { h = hn; r = rn; improved = cost - cn > 1e-9 * cost; cost = cn; lam = Math.max(1e-9, lam / 10); if (!improved) return pack(h); improved = true; }
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
  return { auto, ropes, refineH, CR_TRUE };
});
