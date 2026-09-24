/* XQUIX.VideoAnalysis — Presentation Lab test build (Phase E).
   Pause the game, then Screens -> Left -> Analyze. The picture comes from the left screen when it holds a video file or a
   screenshot; otherwise (empty, or a YouTube/Vimeo player the browser keeps sealed) from Capture from screen: the coach
   picks the tab or window where the game is paused, one frame is taken, sharing stops at once. Not on iPad/iPhone.
     1. Field: the coach taps 4+ field markers and names each (automatic marker detection is not built yet).
     2. Players: the detector reads heads, teams, the goalkeeper and the ball; the coach corrects in place.
     3. Show on board: the scene lands on the center board at the same end and in the teams' own cap colors.
   Depends on HG (homography.js), VAG (va-geometry.js), VADetect (va-detect.js), va-model.json — all lab-owned.
   Never invents: no cap numbers, no players or ball the coach or the detector did not place. */
(function () {
  'use strict';
  if (window.XQUIX && window.XQUIX.VideoAnalysis) return;
  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || location.href;
  const MODEL_URL = new URL('va-model.json', SCRIPT_URL).href.replace(/\?.*$/, '') + '?t=' + Date.now();
  const MAX_W = 1920;

  // ---------- marker catalog (measurement frame: X from the visible goal line, +Y = far side) ----------
  const MARKERS = [
    { key: 'post', label: 'Goal post', X: () => 0, Y: s => s.goalWidth / 2 },
    { key: 'float2', label: '2 m float on the goal rope', X: s => -s.ropeBehind, Y: s => s.goalWidth / 2 + 2 },
    { key: 'gl', label: 'Goal line at the side rope', X: s => -s.ropeBehind, Y: s => s.width / 2 },
    { key: 'r0', label: '0 m: where the red starts on the side rope', X: () => 0, Y: s => s.width / 2 },
    { key: 'm2', label: '2 m mark at the side rope', X: () => 2, Y: s => s.width / 2 },
    { key: 'm5', label: '5 m mark at the side rope', X: () => 5, Y: s => s.width / 2 },
    { key: 'm6', label: '6 m mark at the side rope', X: () => 6, Y: s => s.width / 2 },
    { key: 'half', label: 'Half line at the side rope', X: s => s.length / 2, Y: s => s.width / 2 }
  ];
  const markerWorld = (m, spec) => { const d = MARKERS.find(k => k.key === m.key); return { X: d.X(spec), Y: (m.side === 'far' ? 1 : -1) * d.Y(spec) }; };
  const markerLabel = m => (MARKERS.find(k => k.key === m.key) || {}).label + (m.side === 'far' ? ' — far side' : ' — near side');

  // ---------- state ----------
  let S = null, model = null, modelPromise = null;
  function loadModel() {
    if (model) return Promise.resolve(model);
    if (!modelPromise) modelPromise = fetch(MODEL_URL).then(r => { if (!r.ok) throw new Error('model ' + r.status); return r.json(); }).then(j => (model = j));
    return modelPromise;
  }

  // ---------- CSS ----------
  const css = `
  #xqva{position:fixed;inset:0;z-index:2147481500;background:#07090a;color:#e8eef0;display:flex;flex-direction:column;
    font:14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-user-select:none;user-select:none}
  #xqva .bar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#0e1416;border-bottom:1px solid #1d282b;flex-wrap:wrap}
  #xqva .bar.bottom{border-top:1px solid #1d282b;border-bottom:0;padding-bottom:calc(10px + env(safe-area-inset-bottom))}
  #xqva .title{font-weight:650;letter-spacing:.01em}
  #xqva .steps{display:flex;gap:6px;margin-left:6px}
  #xqva .step{font-size:12px;color:#8a9aa0;padding:3px 9px;border:1px solid #243236;border-radius:6px}
  #xqva .step.on{color:#e8eef0;border-color:#2ecab8;box-shadow:0 0 10px rgba(46,202,184,.25)}
  #xqva .step.done{color:#2ecab8}
  #xqva .msg{flex:1;min-width:180px;color:#b8c6ca;font-size:13px}
  #xqva button{font:600 13px system-ui,-apple-system,sans-serif;color:#e8eef0;background:#172124;border:1px solid #2a3a3e;border-radius:7px;
    padding:7px 12px;cursor:pointer;touch-action:manipulation}
  #xqva button:hover{border-color:#2ecab8}
  #xqva button:disabled{opacity:.4;cursor:default;border-color:#2a3a3e}
  #xqva button.primary{background:#10302c;border-color:#2ecab8;color:#fff}
  #xqva button.sel{border-color:#2ecab8;color:#2ecab8;box-shadow:inset 0 0 0 1px rgba(46,202,184,.4)}
  #xqva .seg{display:inline-flex;gap:0}
  #xqva .seg button{border-radius:0;margin-left:-1px}
  #xqva .seg button:first-child{border-radius:7px 0 0 7px;margin-left:0}
  #xqva .seg button:last-child{border-radius:0 7px 7px 0}
  #xqva .lbl{font-size:12px;color:#8a9aa0}
  #xqva .stat{font-size:13px;color:#e8eef0;padding:0 2px}
  #xqva .stat b{font-weight:650}
  #xqva .warn{color:#f2c230}
  #xqva .spacer{flex:1}
  #xqva .view{flex:1;position:relative;min-height:0}
  #xqva svg.frame{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
  #xqva .pop{position:absolute;z-index:3;background:#0e1416;border:1px solid #2a3a3e;border-radius:10px;padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.6);
    display:flex;flex-direction:column;gap:6px;min-width:190px;max-height:calc(100% - 16px);overflow:auto}
  #xqva .pop .row{display:flex;align-items:center;gap:6px;justify-content:space-between}
  #xqva .pop .row span{font-size:12.5px;color:#cfdadd}
  #xqva .pop .hd{font-size:11px;color:#8a9aa0;letter-spacing:.06em;text-transform:uppercase;padding:0 2px}
  #xqva .busy{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(7,9,10,.55);z-index:4;font-weight:600}
  #xqva .busy.on{display:flex}
  body.xqvaOpen #labTools{display:none}
  body.xqvaLab #xqva{top:22px}
  #xqva .bar:first-child{padding-top:calc(10px + env(safe-area-inset-top))}
  body.xqvaLab #xqva .bar:first-child{padding-top:10px}
  @media (max-width:700px){ #xqva .steps{display:none} #xqva button{padding:7px 9px} }`;

  // ---------- helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  function el(tag, attrs, parent, ns) {
    const e = ns ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
    for (const k in attrs || {}) { if (attrs[k] == null) continue; if (k === 'text') e.textContent = attrs[k]; else if (k === 'on') for (const ev in attrs.on) e.addEventListener(ev, attrs.on[ev]); else e.setAttribute(k, attrs[k]); }
    if (parent) parent.appendChild(e); return e;
  }
  const sv = (tag, attrs, parent) => el(tag, attrs, parent, true);
  const fmtTime = t => { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

  // ---------- grabbing the paused frame ----------
  function sourceMedia() {
    const c = document.getElementById('videoContent'); if (!c) return null;
    return c.querySelector(':scope > video, :scope > img, :scope > iframe');
  }
  function grab() {
    const m = sourceMedia();
    // nothing readable on the left screen (empty, or a YouTube/Vimeo player the browser keeps sealed): capture from the screen
    if (!m || m.tagName === 'IFRAME') return { capture: true, embedded: !!m };
    let w, h, name;
    if (m.tagName === 'VIDEO') {
      if (!m.videoWidth) return { error: 'The video has not loaded a picture yet. Play it to the moment you want, pause, and try again.' };
      if (!m.paused) m.pause();
      w = m.videoWidth; h = m.videoHeight; name = 'Video scene ' + fmtTime(m.currentTime);
    } else {
      if (!m.naturalWidth) return { error: 'The image has not loaded yet.' };
      w = m.naturalWidth; h = m.naturalHeight; name = 'Screenshot scene';
    }
    const f = frameFrom(m, w, h, name);
    return f.error ? { capture: true, tainted: true } : f;
  }
  function frameFrom(src, w, h, name) {
    const k = Math.min(1, MAX_W / w), cw = Math.round(w * k), ch = Math.round(h * k);
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(src, 0, 0, cw, ch);
    let data;
    try { data = cx.getImageData(0, 0, cw, ch); }
    catch (e) { return { error: 'tainted' }; }
    return { w: cw, h: ch, url: cv.toDataURL('image/jpeg', 0.9), data, name };
  }

  /* Capture from screen: the coach picks the tab or window with the paused game (YouTube, Vimeo, any player);
     the browser shows its own picker and sharing indicator. ONE frame is taken and the stream is stopped at once. */
  const canCapture = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  function captureScreen() {
    let stream;
    const req = navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser', frameRate: 5 }, audio: false,
      selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', preferCurrentTab: false, monitorTypeSurfaces: 'include' });   // called inside the tap: needs the user gesture
    return req.then(st => {
      stream = st;
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = st;
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('no picture arrived from the shared screen')), 6000);
        v.onloadeddata = () => { v.play().catch(() => {}); setTimeout(() => { clearTimeout(t); res(v); }, 350); };   // let a real frame arrive
      });
    }).then(v => {
      const f = frameFrom(v, v.videoWidth, v.videoHeight, 'Screen capture scene');
      return f;
    }).finally(() => { if (stream) stream.getTracks().forEach(tr => tr.stop()); });
  }

  // ---------- open / close ----------
  function open() {
    const g = grab();
    if (g.error) { notify(g.error); return false; }
    if (g.capture) {
      if (!canCapture()) { notify('This device can’t share its screen with the Studio (iPad and iPhone browsers don’t allow it). Take a screenshot of the paused game and load it with Screens → Left → File, then tap Analyze.'); return false; }
      loadModel().catch(() => {});
      captureScreen().then(f => { if (f.error) { notify('The shared picture could not be read. Try again, or use a screenshot.'); return; } start(f); })
        .catch(e => { if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return; notify('Screen capture did not work: ' + (e && e.message || e) + '. Use a screenshot instead (Screens → Left → File).'); });
      return true;
    }
    start(g); return true;
  }
  function start(g) {
    loadModel().catch(() => {});
    S = { frame: g, spec: { length: 25, width: 20, goalWidth: 3, ropeBehind: 0 }, markers: [], cal: null, step: 'field',
          players: [], ball: null, attacking: null, attackingBy: null, corrections: [] };
    build(); render();
    autoField();
  }
  /* Automatic field (MIZE's requirements): the far lane line's 0 / 2 / 5 / 6 m and the near lane line's 5 m / 6 m,
     read from the rope colors. Found -> the markers are placed for the coach to check and the players are read at
     once (one confirmation view). Not found -> the reason, and marking by hand as the fallback. */
  const FIELD_URL = new URL('va-field.js', SCRIPT_URL).href.replace(/\?.*$/, '') + '?t=' + Date.now();
  function ensureField() {
    if (window.VAField) return Promise.resolve();
    return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = FIELD_URL; sc.onload = () => res(); sc.onerror = () => rej(new Error('va-field.js did not load')); document.head.appendChild(sc); });
  }
  function autoField() {
    const busy = $('#xqvaBusy'); busy.textContent = 'Finding the field…'; busy.classList.add('on');
    ensureField().then(() => new Promise(r => setTimeout(r, 30))).then(() => {
      if (!S) return;
      const r = VAField.auto(S.frame.data, { width: S.spec.width });
      S.autoField = { ok: !!r.refs, why: r.why, ms: r.ms };
      busy.classList.remove('on');
      if (r.refs) {
        const KEY = { 0: 'r0', 2: 'm2', 5: 'm5', 6: 'm6' };
        S.markers = r.refs.map(q => ({ key: KEY[q.X], side: q.side, u: q.u, v: q.v, auto: true }));
        refit();
        if (S.cal) { render(); findPlayers(); return; }
        S.autoField = { ok: false, why: 'The lane lines were found but do not define the field.' }; S.markers = [];
      }
      render();
    }).catch(e => { busy.classList.remove('on'); if (S) { S.autoField = { ok: false, why: e.message }; render(); } });
  }
  function close() {
    const o = document.getElementById('xqva'); if (o) o.remove(); document.body.classList.remove('xqvaOpen', 'xqvaLab');
    document.removeEventListener('keydown', onKey, true);
    S = null;
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); const p = $('#xqva .pop'); if (p) p.remove(); else close(); } }
  function notify(text) {
    // MizeDialog is a top-level const in index.html: not a window property, so test the binding itself
    if (typeof MizeDialog !== 'undefined' && MizeDialog && typeof MizeDialog.alert === 'function') MizeDialog.alert(text); else alert(text);
  }

  // ---------- layout ----------
  function build() {
    if (!document.getElementById('xqvaCss')) el('style', { id: 'xqvaCss', text: css }, document.head);
    document.body.classList.add('xqvaOpen'); document.body.classList.toggle('xqvaLab', !!document.getElementById('labBanner'));
    const o = el('div', { id: 'xqva', role: 'dialog', 'aria-label': 'Analyze scene' }, document.body);
    const top = el('div', { class: 'bar' }, o);
    el('span', { class: 'title', text: 'Analyze scene' }, top);
    const steps = el('div', { class: 'steps' }, top);
    el('span', { class: 'step', 'data-s': 'field', text: '1 Field' }, steps);
    el('span', { class: 'step', 'data-s': 'players', text: '2 Players' }, steps);
    el('span', { class: 'msg', id: 'xqvaMsg' }, top);
    el('button', { id: 'xqvaCancel', text: 'Cancel', on: { click: close } }, top);
    const view = el('div', { class: 'view' }, o);
    const svg = sv('svg', { class: 'frame', viewBox: `0 0 ${S.frame.w} ${S.frame.h}`, preserveAspectRatio: 'xMidYMid meet' }, view);
    sv('image', { href: S.frame.url, x: 0, y: 0, width: S.frame.w, height: S.frame.h }, svg);
    const cp = sv('clipPath', { id: 'xqvaClip' }, sv('defs', {}, svg)); sv('rect', { x: 0, y: 0, width: S.frame.w, height: S.frame.h }, cp);
    sv('g', { id: 'xqvaLines', 'clip-path': 'url(#xqvaClip)' }, svg); sv('g', { id: 'xqvaMarks' }, svg);
    svg.addEventListener('pointerdown', onDown); svg.addEventListener('pointermove', onMove); svg.addEventListener('pointerup', onUp);
    el('div', { class: 'busy', id: 'xqvaBusy', text: 'Reading players…' }, view);
    el('div', { class: 'bar bottom', id: 'xqvaBottom' }, o);
    document.addEventListener('keydown', onKey, true);
  }
  const svgEl = () => $('#xqva svg.frame');
  function toFrame(ev) { const s = svgEl(), p = s.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; const q = p.matrixTransform(s.getScreenCTM().inverse()); return [q.x, q.y]; }
  const unit = () => { const s = svgEl(), m = s.getScreenCTM(); return m ? 1 / m.a : 1; };   // frame px per screen px

  // ---------- calibration ----------
  function refit() {
    S.cal = null; S.fitInfo = null;
    const refs = S.markers.map(m => Object.assign({ label: markerLabel(m), u: m.u, v: m.v }, markerWorld(m, S.spec)));
    if (refs.length < 4) return;
    const cal = VAG.fit(refs);
    if (cal.error) { S.fitInfo = { error: cal.error }; return; }
    // the algebraic fit alone is poorly conditioned when the references lie on two ropes: refine in pixels
    if (window.VAField && refs.length > 4) cal.H = VAField.refineH(cal.H, refs);
    const Hi = VADetect.inv3(cal.H);
    const errs = refs.map(r => { const p = VADetect.ap(Hi, r.u, r.v); return Math.hypot(p[0] - r.X, p[1] - r.Y); });
    // leave-one-out when there is a spare marker: the honest check of the fit
    let loo = null;
    // a set of markers pins the field only if it spreads both out from the goal line and across it
    const spread = rs => { const X = rs.map(r => r.X), Y = rs.map(r => r.Y); return Math.max(...X) - Math.min(...X) >= 1.5 && Math.max(...Y) - Math.min(...Y) >= 3; };
    if (refs.length >= 5) {
      loo = refs.map((r, i) => { const rest = refs.filter((_, j) => j !== i); if (!spread(rest)) return null; const c = VAG.fit(rest); if (c.error) return null; const p = VADetect.ap(VADetect.inv3(c.H), r.u, r.v); return Math.hypot(p[0] - r.X, p[1] - r.Y); }).filter(v => v != null);
    }
    const pxMax = Math.max(...refs.map(r => { const p = VADetect.ap(cal.H, r.X, r.Y); return Math.hypot(p[0] - r.u, p[1] - r.v); }));
    S.cal = { H: cal.H, Hi }; S.fitInfo = { mean: errs.reduce((a, b) => a + b, 0) / errs.length, looMax: loo && loo.length ? Math.max(...loo) : null, spread: spread(refs), pxMax };
  }

  // ---------- rendering ----------
  function render() {
    if (!S) return;
    document.querySelectorAll('#xqva .step').forEach(s => { s.classList.toggle('on', s.dataset.s === S.step); s.classList.toggle('done', S.step === 'players' && s.dataset.s === 'field'); });
    drawLines(); drawMarks(); bottom();
  }
  function msg(t, cls) { const m = $('#xqvaMsg'); m.textContent = t; m.className = 'msg' + (cls ? ' ' + cls : ''); }

  function drawLines() {
    const g = $('#xqvaLines'); g.innerHTML = '';
    if (!S.cal) return;
    const H = S.cal.H, sp = S.spec, hw = sp.width / 2, u = unit();
    // a homography is defined up to scale, sign included: "in front of the camera" is the sign a real marker has
    const m0 = markerWorld(S.markers[0], sp), sg = Math.sign(H[2][0] * m0.X + H[2][1] * m0.Y + H[2][2]) || 1;
    const seg = (X0, Y0, X1, Y1, col, wd, dash) => {
      const pts = []; for (let i = 0; i <= 24; i++) { const t = i / 24, X = X0 + (X1 - X0) * t, Y = Y0 + (Y1 - Y0) * t, s = sg * (H[2][0] * X + H[2][1] * Y + H[2][2]); if (s <= 0) continue; pts.push(VADetect.ap(H, X, Y)); }
      if (pts.length > 1) sv('polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: col, 'stroke-width': wd * u, 'stroke-dasharray': dash ? `${6 * u} ${5 * u}` : '', opacity: .85 }, g);
    };
    seg(0, -hw, 0, hw, '#ffffff', 1.6); seg(0, -hw, sp.length / 2, -hw, '#ffffff', 1.2); seg(0, hw, sp.length / 2, hw, '#ffffff', 1.2);
    seg(2, -hw, 2, hw, '#e0504a', 1.2, true); seg(5, -hw, 5, hw, '#f2c230', 1.2, true); seg(6, -hw, 6, hw, '#f2c230', 1.2, true);
    seg(sp.length / 2, -hw, sp.length / 2, hw, '#ffffff', 1.2, true);
    const gp = sp.goalWidth / 2; seg(0, -gp, 0, gp, '#2ecab8', 3);
  }

  const TEAM_COL = { light: '#ffffff', dark: '#4d8dff', unknown: '#9aa6aa' };
  function drawMarks() {
    const g = $('#xqvaMarks'); g.innerHTML = ''; const u = unit();
    if (S.step === 'field') {
      S.markers.forEach((m, i) => {
        sv('circle', { cx: m.u, cy: m.v, r: 9 * u, fill: 'none', stroke: '#000', 'stroke-width': 4 * u, opacity: .6 }, g);
        sv('circle', { cx: m.u, cy: m.v, r: 9 * u, fill: 'rgba(46,202,184,.18)', stroke: '#2ecab8', 'stroke-width': 2 * u }, g);
        sv('circle', { cx: m.u, cy: m.v, r: 1.6 * u, fill: '#2ecab8' }, g);
        const t = sv('text', { x: m.u + 13 * u, y: m.v - 10 * u, fill: '#e8eef0', 'font-size': 13 * u, 'font-weight': 600, stroke: '#000', 'stroke-width': 3 * u, 'paint-order': 'stroke' }, g);
        t.textContent = (i + 1) + ' ' + (MARKERS.find(k => k.key === m.key) || {}).label.replace(' at the side rope', '').replace(' on the goal rope', '') + (m.side === 'far' ? ' (far)' : ' (near)');
      });
      if (S.pending) sv('circle', { cx: S.pending[0], cy: S.pending[1], r: 7 * u, fill: 'none', stroke: '#f2c230', 'stroke-width': 2 * u }, g);
      return;
    }
    // players
    if (S.ball) {
      const b = S.ball.px, r = Math.max(14, ballRadius()) ;
      sv('circle', { cx: b[0], cy: b[1], r: r + 3 * u, fill: 'none', stroke: '#000', 'stroke-width': 4 * u, opacity: .55 }, g);
      sv('circle', { cx: b[0], cy: b[1], r, fill: 'none', stroke: '#f2c230', 'stroke-width': 2.5 * u, 'stroke-dasharray': `${5 * u} ${3 * u}` }, g);
      const t = sv('text', { x: b[0] - r, y: b[1] + r + 14 * u, fill: '#f2c230', 'font-size': 12 * u, 'font-weight': 600, stroke: '#000', 'stroke-width': 3 * u, 'paint-order': 'stroke' }, g); t.textContent = 'Ball';
    }
    S.players.forEach((p, i) => {
      const r = Math.max(10, p.capPx * 0.62), col = p.role === 'goalkeeper' ? '#e0504a' : TEAM_COL[p.team];
      const low = (p.detectConf != null && p.detectConf < 0.75);
      sv('circle', { cx: p.head[0], cy: p.head[1], r: r + 2.5 * u, fill: 'none', stroke: '#000', 'stroke-width': 4 * u, opacity: .55 }, g);
      sv('circle', { cx: p.head[0], cy: p.head[1], r, fill: 'none', stroke: col, 'stroke-width': 2.8 * u, 'stroke-dasharray': low ? `${5 * u} ${4 * u}` : '' }, g);
      if (S.sel === i) sv('circle', { cx: p.head[0], cy: p.head[1], r: r + 7 * u, fill: 'none', stroke: '#2ecab8', 'stroke-width': 2 * u }, g);
      const tag = p.role === 'goalkeeper' ? 'GK' : p.team === 'unknown' ? '?' : '';
      if (tag) { const t = sv('text', { x: p.head[0] + r + 3 * u, y: p.head[1] - r, fill: col, 'font-size': 14 * u, 'font-weight': 700, stroke: '#000', 'stroke-width': 3 * u, 'paint-order': 'stroke' }, g); t.textContent = tag; }
    });
  }
  function ballRadius() { const d = S.players.length ? S.players.map(p => p.capPx).sort((a, b) => a - b)[S.players.length >> 1] : 24; return d * 0.62 + 9; }

  function bottom() {
    const b = $('#xqvaBottom'); b.innerHTML = '';
    if (S.step === 'field') {
      el('span', { class: 'lbl', text: 'Field width' }, b);
      const w = el('div', { class: 'seg' }, b);
      // MIZE 2026-09-24: the field is 20 m wide as a rule; only a special pool is narrower, and then the coach says so
      el('button', { class: S.spec.width === 20 ? 'sel' : '', text: '20 m', on: { click: () => { S.spec.width = 20; refit(); render(); } } }, w);
      el('button', { class: S.spec.width !== 20 ? 'sel' : '', text: S.spec.width !== 20 ? S.spec.width + ' m' : 'Narrower…', title: 'Only for a special pool whose field is narrower than 20 m',
        on: { click: () => { const a = prompt('Field width in meters (narrower than 20):', S.spec.width !== 20 ? S.spec.width : ''); const v = parseFloat(a);
          if (v > 5 && v < 20) { S.spec.width = v; refit(); render(); } } } }, w);
      el('span', { class: 'lbl', text: 'Goal rope' }, b);
      const r = el('div', { class: 'seg' }, b);
      for (const [v, t] of [[0, 'On the goal line'], [0.3, '0.3 m behind']]) el('button', { class: S.spec.ropeBehind === v ? 'sel' : '', text: t, on: { click: () => { S.spec.ropeBehind = v; refit(); render(); } } }, r);
      el('span', { class: 'spacer' }, b);
      el('button', { text: 'Undo marker', disabled: S.markers.length ? null : '', on: { click: () => { S.markers.pop(); refit(); render(); } } }, b);
      el('button', { class: 'primary', id: 'xqvaFind', text: 'Find players', disabled: S.cal ? null : '', on: { click: findPlayers } }, b);
      const n = S.markers.length;
      if (n === 0 && S.autoField && !S.autoField.ok) msg('The field could not be found automatically: ' + S.autoField.why + ' Mark it by hand: tap a marker you can see on the water and name it (at least 4).', 'warn');
      else if (n < 4) msg(`Tap a field marker you can see on the water and name it (${n} of at least 4). Use markers that are spread out: goal posts, 2 m floats, marks on the side ropes.`);
      else if (S.fitInfo && S.fitInfo.error) msg('These markers don’t define the field: ' + S.fitInfo.error, 'warn');
      else if (!S.fitInfo.spread) msg('The markers sit almost in one line. Add one further out from the goal line (a 2 m, 5 m or 6 m mark) and one across the pool.', 'warn');
      else if (n === 4) msg('4 markers: the field lines are drawn from them. Check that they sit on the water where they should. A 5th marker lets me measure the fit.');
      else msg(`${n} markers · they agree to ${S.fitInfo.mean.toFixed(2)} m on average` + (S.fitInfo.mean > 0.35 ? ' — they disagree: a marker is probably misplaced or misnamed (check the drawn lines)' : ''), S.fitInfo.mean > 0.35 ? 'warn' : '');
      return;
    }
    const c = { light: 0, dark: 0, unknown: 0, gk: 0 }; S.players.forEach(p => { if (p.role === 'goalkeeper') c.gk++; else c[p.team]++; });
    const st = el('span', { class: 'stat' }, b);
    st.innerHTML = `Light <b>${c.light}</b> · Dark <b>${c.dark}</b> · Goalkeeper <b>${c.gk}</b>` + (c.unknown ? ` · <span class="warn">Team unread <b>${c.unknown}</b></span>` : '') + ` · Ball ${S.ball ? '✓' : '<span class="warn">none</span>'}`;
    el('span', { class: 'lbl', text: 'Attacking' }, b);
    const a = el('div', { class: 'seg' }, b);
    for (const v of ['light', 'dark']) el('button', { class: S.attacking === v ? 'sel' : '', text: v === 'light' ? 'Light' : 'Dark', on: { click: () => { S.attacking = v; S.attackingBy = 'coach'; render(); } } }, a);
    el('span', { class: 'spacer' }, b);
    el('button', { text: 'Back to field', on: { click: () => { S.step = 'field'; closePop(); render(); } } }, b);
    el('button', { class: 'primary', id: 'xqvaShow', text: 'Show on board', disabled: (S.attacking && !c.unknown) ? null : '', on: { click: showOnBoard } }, b);
    const shaky = S.fitInfo && S.fitInfo.pxMax > 20;
    const pre = S.autoField && S.autoField.ok ? (shaky ? 'Field found automatically, but the lane-line marks don’t fully agree — check the field lines closely. ' : 'Field found automatically — check the field lines. ') : '';
    if (c.unknown) msg(pre + 'Tap each grey “?” player and set Light or Dark.', 'warn');
    else if (!S.attacking) msg(pre + 'Which team is attacking? The scene can’t tell from these pairs — choose Light or Dark.', 'warn');
    else msg(pre + 'Tap a ring to fix it, tap the water to add a missed player or the ball.' + (S.attackingBy === 'pairs' ? ' Attacking side read from the player pairs — change it if wrong.' : ''), shaky ? 'warn' : '');
  }

  // ---------- pointer ----------
  let drag = null;
  function hitMarker(p) { const u = unit(); let best = -1, bd = 1e9; S.markers.forEach((m, i) => { const d = Math.hypot(m.u - p[0], m.v - p[1]); if (d < 16 * u && d < bd) { bd = d; best = i; } }); return best; }
  function hitPlayer(p) { const u = unit(); let best = -1, bd = 1e9; S.players.forEach((q, i) => { const d = Math.hypot(q.head[0] - p[0], q.head[1] - p[1]); if (d < Math.max(10, q.capPx * 0.62) + 10 * u && d < bd) { bd = d; best = i; } }); return best; }
  function onDown(ev) {
    if ($('#xqva .pop')) { closePop(); ev.preventDefault(); return; }
    const p = toFrame(ev);
    if (S.step === 'field') { const i = hitMarker(p); if (i >= 0) { drag = { i, start: p, moved: false, id: ev.pointerId }; svgEl().setPointerCapture(ev.pointerId); return; } }
    drag = { i: -1, start: p, moved: false, id: ev.pointerId };
  }
  function onMove(ev) {
    if (!drag) return; const p = toFrame(ev), u = unit();
    if (Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) > 5 * u) drag.moved = true;
    if (drag.i >= 0 && drag.moved) { const m = S.markers[drag.i]; m.u = p[0]; m.v = p[1]; refit(); drawLines(); drawMarks(); }
  }
  function onUp(ev) {
    if (!drag) return; const d = drag; drag = null; const p = toFrame(ev);
    if (d.i >= 0) { if (d.moved) { refit(); render(); } else markerPop(d.i, ev); return; }
    if (d.moved) return;
    if (S.step === 'field') { S.pending = p; drawMarks(); namePop(p, ev); }
    else { const i = hitPlayer(p); if (i >= 0) { S.sel = i; drawMarks(); playerPop(i, ev); } else waterPop(p, ev); }
  }

  // ---------- popovers ----------
  function closePop() { const p = $('#xqva .pop'); if (p) p.remove(); if (S) { S.pending = null; S.sel = null; } if (S) drawMarks(); }
  function pop(ev, title) {
    const old = $('#xqva .pop'); if (old) old.remove();
    const view = $('#xqva .view'), box = view.getBoundingClientRect(), pp = el('div', { class: 'pop' }, view);
    if (title) el('div', { class: 'hd', text: title }, pp);
    requestAnimationFrame(() => {
      const r = pp.getBoundingClientRect();
      let x = ev.clientX - box.left + 14, y = ev.clientY - box.top - 20;
      if (x + r.width > box.width - 8) x = ev.clientX - box.left - r.width - 14;
      y = Math.max(8, Math.min(box.height - r.height - 8, y)); x = Math.max(8, x);
      pp.style.left = x + 'px'; pp.style.top = y + 'px';
    });
    pp.style.left = '-9999px'; return pp;
  }
  function namePop(p, ev) {
    const pp = pop(ev, 'What is here?');
    for (const k of MARKERS) {
      const row = el('div', { class: 'row' }, pp); el('span', { text: k.label }, row);
      const seg = el('div', { class: 'seg' }, row);
      for (const side of ['near', 'far']) el('button', { text: side === 'near' ? 'Near' : 'Far', title: side === 'near' ? 'The side nearer the camera' : 'The side away from the camera',
        on: { click: () => { if (S.markers.some(m => m.key === k.key && m.side === side)) { S.markers = S.markers.filter(m => !(m.key === k.key && m.side === side)); }
          S.markers.push({ key: k.key, side, u: p[0], v: p[1] }); closePop(); refit(); render(); } } }, seg);
    }
    el('button', { text: 'Cancel', on: { click: closePop } }, pp);
  }
  function markerPop(i, ev) {
    const m = S.markers[i], pp = pop(ev, markerLabel(m));
    el('div', { class: 'lbl', text: 'Drag a marker to move it.' }, pp);
    el('button', { text: 'Remove marker', on: { click: () => { S.markers.splice(i, 1); closePop(); refit(); render(); } } }, pp);
  }
  function log(kind, o) { S.corrections.push(Object.assign({ kind, at: new Date().toISOString() }, o)); }
  function playerPop(i, ev) {
    const p = S.players[i], pp = pop(ev, p.role === 'goalkeeper' ? 'Goalkeeper' : p.team === 'unknown' ? 'Player — team unread' : (p.team === 'light' ? 'Light' : 'Dark') + ' player');
    const set = (team, role) => () => { log('change', { id: p.id, from: { team: p.team, role: p.role }, to: { team, role } }); p.team = team; p.role = role; if (role === 'goalkeeper') S.players.forEach((q, j) => { if (j !== i && q.role === 'goalkeeper') { q.role = 'field'; } }); afterEdit(); };
    el('button', { text: 'Light player', class: p.role === 'field' && p.team === 'light' ? 'sel' : '', on: { click: set('light', 'field') } }, pp);
    el('button', { text: 'Dark player', class: p.role === 'field' && p.team === 'dark' ? 'sel' : '', on: { click: set('dark', 'field') } }, pp);
    el('button', { text: 'Goalkeeper', class: p.role === 'goalkeeper' ? 'sel' : '', on: { click: set('unknown', 'goalkeeper') } }, pp);
    el('button', { text: 'Remove — not a player', on: { click: () => { log('remove', { id: p.id, head: p.head }); S.players.splice(i, 1); afterEdit(); } } }, pp);
    if (S.ball && Math.hypot(S.ball.px[0] - p.head[0], S.ball.px[1] - p.head[1]) < ballRadius() + 20) el('button', { text: 'Remove the ball here', on: { click: () => { log('ball', { from: S.ball.px, to: null }); S.ball = null; afterEdit(); } } }, pp);
  }
  function waterPop(p, ev) {
    const pp = pop(ev, 'Add here');
    const add = (team, role) => () => { const cap = medianCap(p); const q = { id: 'c' + (S.players.length + 1) + '-' + Date.now() % 1000, head: [p[0], p[1]], capPx: cap, waterline: [p[0], p[1] + 0.9 * cap], detectConf: null, team, teamConf: null, role, source: 'coach' };
      if (role === 'goalkeeper') S.players.forEach(o => { if (o.role === 'goalkeeper') o.role = 'field'; });
      log('add', { head: q.head, team, role }); S.players.push(q); afterEdit(); };
    el('button', { text: 'Light player', on: { click: add('light', 'field') } }, pp);
    el('button', { text: 'Dark player', on: { click: add('dark', 'field') } }, pp);
    el('button', { text: 'Goalkeeper', on: { click: add('unknown', 'goalkeeper') } }, pp);
    el('button', { text: 'Ball here', on: { click: () => { log('ball', { from: S.ball ? S.ball.px : null, to: p }); S.ball = { px: p, source: 'coach' }; afterEdit(); } } }, pp);
    if (S.ball) el('button', { text: 'No ball visible', on: { click: () => { log('ball', { from: S.ball.px, to: null }); S.ball = null; afterEdit(); } } }, pp);
  }
  // expected head size at a point, from the calibration (same rule as the detector)
  function medianCap(p) {
    const Hi = S.cal.Hi, a = VADetect.ap(Hi, p[0], p[1]), b = VADetect.ap(Hi, p[0] + 1, p[1]), c = VADetect.ap(Hi, p[0], p[1] + 1);
    const m = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
    return m > 0 ? +(0.22 / m).toFixed(1) : 24;
  }
  function afterEdit() { closePop(); if (S.attackingBy !== 'coach') inferAttack(); render(); }

  // ---------- detection ----------
  function calcOf(p) { const w = VADetect.ap(S.cal.Hi, p.waterline[0], p.waterline[1]); return { X: w[0], Y: w[1] }; }
  function inferAttack() {
    const res = { players: S.players.filter(p => p.team !== 'unknown' || p.role === 'goalkeeper').map(p => ({ id: p.id, team: p.team, role: p.role, calc: calcOf(p) })) };
    const r = VAG.inferAttacking(res);
    if (r.attacking) { S.attacking = r.attacking; S.attackingBy = 'pairs'; } else if (S.attackingBy === 'pairs') { S.attacking = null; S.attackingBy = null; }
  }
  function findPlayers() {
    const busy = $('#xqvaBusy'); busy.textContent = 'Reading players…'; busy.classList.add('on');
    loadModel().then(m => new Promise(res => setTimeout(() => res(m), 30))).then(m => {
      const spec = { length: S.spec.length, width: S.spec.width, goalWidth: S.spec.goalWidth };
      const r = VADetect.detect(S.frame.data, S.cal.H, spec, m, {});
      S.detector = { players: r.players.map(p => Object.assign({}, p)), ball: r.ball, ms: r.ms };
      S.players = r.players.map(p => Object.assign({ source: 'detector' }, p));
      S.ball = r.ball ? { px: r.ball.px, source: 'detector' } : null;
      S.step = 'players'; S.attacking = null; S.attackingBy = null; inferAttack();
      busy.classList.remove('on'); render();
    }).catch(e => { busy.classList.remove('on'); msg('The detector could not run: ' + e.message, 'warn'); });
  }

  // ---------- to the board ----------
  function showOnBoard() {
    const defending = S.attacking === 'light' ? 'dark' : 'light';
    // the goalkeeper in front of the visible goal defends it: his team is the defending team (a deduction from the
    // coach's attack choice, not from his cap color)
    const res = { H: S.cal.H, spec: { length: S.spec.length, width: S.spec.width, goalWidth: S.spec.goalWidth },
      players: S.players.map(p => ({ id: p.id, team: p.role === 'goalkeeper' ? defending : p.team, role: p.role, calc: calcOf(p) })),
      ball: S.ball ? { calc: (() => { const nb = nearestHolder(S.ball.px); return nb ? calcOf(nb) : (() => { const w = VADetect.ap(S.cal.Hi, S.ball.px[0], S.ball.px[1]); return { X: w[0], Y: w[1] }; })(); })() } : null };
    const out = VAG.toStudioFormation(res, { attackingAtVisibleGoal: S.attacking, name: S.frame.name });
    if (out.error) { msg(out.error, 'warn'); return; }
    const rec = out.record;
    rec.videoAnalysis.phase = 'E-lab';
    rec.videoAnalysis.review = { markers: S.markers.map(m => Object.assign({ label: markerLabel(m) }, m, markerWorld(m, S.spec))), fit: S.fitInfo,
      detector: S.detector, corrections: S.corrections, ballPlacedAtHolder: !!(S.ball && nearestHolder(S.ball.px)) };
    try {
      if (typeof recordHistory === 'function') recordHistory('Analyze scene: ' + rec.name);
      loadState(typeof formationRecordState === 'function' ? formationRecordState(rec) : rec.state);
      if (typeof resetTimelineForFormationLoad === 'function') resetTimelineForFormationLoad();
    } catch (e) { msg('The board could not take the scene: ' + e.message, 'warn'); return; }
    window.XQUIX.VideoAnalysis.last = rec;
    close();
    try { if (typeof XQStage !== 'undefined' && XQStage.isOpen()) XQStage.setCamera('center'); } catch (e) {}
    if (out.excluded.length) setTimeout(() => notify(out.excluded.length + (out.excluded.length === 1 ? ' player was' : ' players were') + ' left off the board: outside the 25 × 20 m field seen from this goal.'), 900);
  }
  // A held ball is above the water, so its own image point is not on the water plane: place it at the holder.
  function nearestHolder(px) {
    let best = null, bd = 1e9;
    for (const p of S.players) { const d = Math.hypot(p.head[0] - px[0], p.head[1] - px[1]); if (d < bd) { bd = d; best = p; } }
    return best && bd < Math.max(60, 3 * best.capPx) ? best : null;
  }

  // ---------- Studio wiring (lab) ----------
  function wire() {
    // 1. Screens -> Left: an Analyze button next to Video · File · Clear
    if (typeof window.cwItems === 'function' && !window.cwItems._xqva) {
      const orig = window.cwItems;
      const wrapped = function (g) {
        const L = orig.apply(this, arguments);
        if (g !== 'screens' || !Array.isArray(L)) return L;
        const i = L.findIndex(x => x && x.id === 'mediaClear'); if (i < 0) return L;
        const m = sourceMedia(), readable = m && m.tagName !== 'IFRAME';
        L.splice(i + 1, 0, { id: 'analyze', label: 'Analyze', icon: ICON,
          title: readable ? 'Put this paused moment on the center board' : 'Put a paused game on the center board: pick the tab or window where it is paused (YouTube, Vimeo, any player)',
          tap: () => open() });
        return L;
      };
      wrapped._xqva = true; window.cwItems = wrapped;
    }
    // 2. The left screen's File also takes a screenshot (image) in the lab
    const inp = document.getElementById('videoFileInput');
    if (inp && !inp._xqva) {
      inp._xqva = true; inp.accept = 'video/*,image/*';
      inp.addEventListener('change', e => {
        const f = inp.files && inp.files[0]; if (!f || !/^image\//.test(f.type)) return;
        e.stopImmediatePropagation();
        const img = document.createElement('img'); img.src = URL.createObjectURL(f); img.alt = 'Screenshot'; img.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000';
        showStudioFrameContent('video', img); inp.value = '';
        setTimeout(() => { try { if (typeof cwRender === 'function') cwRender(); } catch (_) {} }, 50);
      }, true);
    }
    // keep the Analyze button's enabled state current when the left screen changes
    const c = document.getElementById('videoContent');
    if (c && !c._xqva) { c._xqva = true; new MutationObserver(() => { try { if (typeof cwRender === 'function') cwRender(); } catch (_) {} }).observe(c, { childList: true }); }
  }
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="1.6"/><circle cx="15" cy="10" r="1.6"/><circle cx="12" cy="15" r="1.6"/></svg>';

  window.XQUIX = window.XQUIX || {};
  window.XQUIX.VideoAnalysis = { open, close, state: () => S, loadModel, _grab: grab, canCapture };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  window.addEventListener('load', wire);
})();
