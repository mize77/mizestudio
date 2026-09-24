/* XquiX Video Analysis — frame check (Phase E lab). MIZE's requirements as measurable checks:
   picture large enough, sharp, not too much glare on the water; (field and caps are checked by va-field / va-detect).
   Limits measured on the 8 test frames (2026-09-24): sharpness 17-59 on good frames, 7-11 when blurred (sigma 2),
   13-29 at half resolution; glare 0-1.9 % on good frames (no heavy-glare frame yet: the glare limit is provisional). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.VACheck = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const LIMITS = { minWidth: 1280, minSharp: 12, maxGlare: 6 };
  // region: optional world->image H; then only the pool in front of the goal (X 0..12, |Y| < 9.5) counts
  function inRegion(H, x, y) {
    if (!H) return true;
    const a = H, det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const inv = [[(a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det, (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det, (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det],
                 [(a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det, (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det, (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det],
                 [(a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det, (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det, (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det]];
    const s = inv[2][0] * x + inv[2][1] * y + inv[2][2], X = (inv[0][0] * x + inv[0][1] * y + inv[0][2]) / s, Y = (inv[1][0] * x + inv[1][1] * y + inv[1][2]) / s;
    return X > 0 && X < 12 && Math.abs(Y) < 9.5;
  }
  function measure(img, H, opts) {
    opts = opts || {};
    const w = img.width, h = img.height, d = img.data, ch = opts.channels || 4;
    // glare: very bright, colorless pixels on the water (4-px grid)
    let n = 0, g = 0;
    for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
      if (!inRegion(H, x, y)) continue;
      const q = (y * w + x) * ch, r = d[q], gg = d[q + 1], b = d[q + 2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      n++; if (mx >= 235 && (mx - mn) * 255 / mx <= 40) g++;
    }
    const glare = n ? 100 * g / n : 0;
    // sharpness: 95th percentile of |Laplacian| at a 1280-px-wide scale (box-averaged)
    const k = w / 1280, W = Math.floor(w / k), Hh = Math.floor(h / k), gray = new Float32Array(W * Hh);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * k), x1 = Math.max(x0 + 1, Math.floor((x + 1) * k)), y0 = Math.floor(y * k), y1 = Math.max(y0 + 1, Math.floor((y + 1) * k));
      let s = 0, c = 0;
      for (let yy = y0; yy < Math.min(h, y1); yy++) for (let xx = x0; xx < Math.min(w, x1); xx++) { const q = (yy * w + xx) * ch; s += 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2]; c++; }
      gray[y * W + x] = s / c;
    }
    const vals = [];
    for (let y = 1; y < Hh - 1; y += 2) for (let x = 1; x < W - 1; x += 2) {
      if (!inRegion(H, x * k, y * k)) continue;
      const p = y * W + x; vals.push(Math.abs(gray[p - 1] + gray[p + 1] + gray[p - W] + gray[p + W] - 4 * gray[p]));
    }
    vals.sort((a, b) => a - b);
    const sharp = vals.length ? vals[Math.floor(0.95 * (vals.length - 1))] : 0;
    return { width: w, glare: +glare.toFixed(1), sharp: +sharp.toFixed(1) };
  }
  /* One line per requirement: { key, ok (true / false / null = not known yet), label, text } */
  function checks(m, field, teamSep) {
    const out = [];
    out.push({ key: 'size', label: 'Size', ok: m.width >= LIMITS.minWidth, text: m.width >= LIMITS.minWidth ? 'The picture is large enough.' : `The picture is small (${m.width} px wide). Make the video larger (theater mode or full size) before you pause.` });
    out.push({ key: 'sharp', label: 'Sharp', ok: m.sharp >= LIMITS.minSharp, text: m.sharp >= LIMITS.minSharp ? 'The picture is sharp.' : 'The picture is blurry. Pause on a still moment, when the camera is not moving.' });
    out.push({ key: 'glare', label: 'Glare', ok: m.glare <= LIMITS.maxGlare, text: m.glare <= LIMITS.maxGlare ? 'Little glare on the water.' : `Much glare on the water (${m.glare} %). Players in the glare may be missed.` });
    out.push({ key: 'field', label: 'Lane lines', ok: field == null ? null : !!field.ok, text: field == null ? 'Looking for the lane lines…' : field.ok ? 'Both lane lines found; the field is set from them.' : (field.why || 'The lane lines were not found.') });
    out.push({ key: 'caps', label: 'Caps', ok: teamSep == null ? null : teamSep >= 32, text: teamSep == null ? 'Checked when the players are read.' : teamSep >= 32 ? 'The two teams’ caps look clearly different.' : 'The two teams’ caps look alike here: check the team colors closely.' });
    return out;
  }
  return { measure, checks, LIMITS };
});
