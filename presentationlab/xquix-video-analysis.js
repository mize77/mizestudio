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
    { key: 'half', label: 'Half line at the side rope', X: s => s.length / 2, Y: s => s.width / 2 },
    // MIZE 2026-09-24: when the near side shows no marker, the 2 / 5 / 6 m line exactly in the middle of the field
    // (in line with the goal center), placed by eye. Two of them are needed; 2 m and 6 m are the best pair.
    { key: 'c2', label: '2 m line, middle of the field', X: () => 2, Y: () => 0, middle: true },
    { key: 'c5', label: '5 m line, middle of the field', X: () => 5, Y: () => 0, middle: true },
    { key: 'c6', label: '6 m line, middle of the field', X: () => 6, Y: () => 0, middle: true }
  ];
  const markerWorld = (m, spec) => { const d = MARKERS.find(k => k.key === m.key); return { X: d.X(spec), Y: d.middle ? 0 : (m.side === 'far' ? 1 : -1) * d.Y(spec) }; };
  const markerLabel = m => { const d = MARKERS.find(k => k.key === m.key) || {}; return d.label + (d.middle ? '' : (m.side === 'far' ? ' — far side' : ' — near side')); };

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
  #xqva .tags{display:flex;align-items:center;gap:8px;padding:6px 14px;background:#0b1012;border-top:1px solid #1d282b;flex-wrap:wrap}
  #xqva .tags input{font:13px system-ui,-apple-system,sans-serif;color:#e8eef0;background:#121a1d;border:1px solid #2a3a3e;border-radius:7px;padding:6px 9px;min-width:130px;max-width:200px}
  #xqva .tags input:focus{outline:none;border-color:#2ecab8}
  #xqva .tags .hint{font-size:12px;color:#8a9aa0}
  #xqvaLib{position:fixed;inset:0;z-index:2147481500;background:rgba(7,9,10,.92);color:#e8eef0;display:flex;flex-direction:column;font:14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  #xqvaLib .bar{display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;background:#0e1416;border-bottom:1px solid #1d282b;flex-wrap:wrap}
  body.xqvaLab #xqvaLib{top:22px}
  #xqvaLib .title{font-weight:650}
  #xqvaLib select,#xqvaLib input{font:13px system-ui,-apple-system,sans-serif;color:#e8eef0;background:#121a1d;border:1px solid #2a3a3e;border-radius:7px;padding:6px 9px}
  #xqvaLib button{font:600 13px system-ui,-apple-system,sans-serif;color:#e8eef0;background:#172124;border:1px solid #2a3a3e;border-radius:7px;padding:7px 12px;cursor:pointer}
  #xqvaLib button:hover{border-color:#2ecab8}
  #xqvaLib button.primary{background:#10302c;border-color:#2ecab8;color:#fff}
  #xqvaLib .lbl{font-size:12px;color:#8a9aa0}
  #xqvaLib .spacer{flex:1}
  #xqvaLib .grid{flex:1;overflow:auto;padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;align-content:start}
  #xqvaLib .card{background:#0e1416;border:1px solid #1d282b;border-radius:10px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column}
  #xqvaLib .card:hover{border-color:#2ecab8}
  #xqvaLib .card .thumb{aspect-ratio:16/9;background:#050708 center/cover no-repeat}
  #xqvaLib .card .meta{padding:8px 10px;display:flex;flex-direction:column;gap:3px}
  #xqvaLib .card .teams{font-weight:650;font-size:13px}
  #xqvaLib .card .sys{font-size:12px;color:#cfdadd}
  #xqvaLib .card .when{font-size:11px;color:#8a9aa0}
  #xqvaLib .empty{grid-column:1/-1;color:#8a9aa0;padding:30px;text-align:center}
  #xqva .checks{display:flex;gap:6px;flex-wrap:wrap}
  #xqva .chk{font-size:12px;padding:3px 8px;border-radius:6px;border:1px solid #243236;color:#b8c6ca;background:transparent;cursor:pointer}
  #xqva .chk.ok{color:#cfe9e5;border-color:rgba(46,202,184,.45)}
  #xqva .chk.ok::before{content:"✓ ";color:#2ecab8}
  #xqva .chk.no{color:#f2c230;border-color:rgba(242,194,48,.6)}
  #xqva .chk.no::before{content:"⚠ "}
  #xqva .chk.wait{opacity:.55}
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
          players: [], ball: null, attacking: null, attackingBy: null, corrections: [], tags: Object.assign({ teamAttacking: '', teamDefending: '', systemOffense: '', systemDefense: '' }, lastTags()) };
    build(); render();
    autoField();
  }
  /* Automatic field (MIZE's requirements): the far lane line's 0 / 2 / 5 / 6 m and the near lane line's 5 m / 6 m,
     read from the rope colors. Found -> the markers are placed for the coach to check and the players are read at
     once (one confirmation view). Not found -> the reason, and marking by hand as the fallback. */
  // va-field-std.js: the standard-color reader (tried first); va-field.js: the pattern reader and the fitting
  const FIELD_T = Date.now(), fieldUrl = f => new URL(f, SCRIPT_URL).href.replace(/\?.*$/, '') + '?t=' + FIELD_T;
  function loadScript(f) { return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = fieldUrl(f); sc.onload = () => res(); sc.onerror = () => rej(new Error(f + ' did not load')); document.head.appendChild(sc); }); }
  function ensureField() {
    if (window.VAField && window.VAFieldStd && window.VACheck) return Promise.resolve();
    return (window.VAFieldStd ? Promise.resolve() : loadScript('va-field-std.js')).then(() => window.VAField ? null : loadScript('va-field.js')).then(() => window.VACheck ? null : loadScript('va-check.js'));
  }
  const ensureTrack = () => window.VATrack ? Promise.resolve() : loadScript('va-track.js');
  function autoField() {
    const busy = $('#xqvaBusy'); busy.textContent = 'Finding the field…'; busy.classList.add('on');
    ensureField().then(() => new Promise(r => setTimeout(r, 30))).then(() => {
      if (!S) return;
      try { S.metrics = VACheck.measure(S.frame.data, null); } catch (e) {}
      const r = VAField.auto(S.frame.data, { width: S.spec.width });
      S.autoField = { ok: !!r.refs, why: r.why, ms: r.ms };
      busy.classList.remove('on');
      if (r.refs) {
        const KEY = { 0: 'r0', 2: 'm2', 5: 'm5', 6: 'm6' };
        S.markers = r.refs.map(q => ({ key: KEY[q.X], side: q.side, u: q.u, v: q.v, auto: true }));
        refit();
        if (S.cal) { remeasure(); render(); findPlayers(); return; }
        S.autoField = { ok: false, why: 'The lane lines were found but do not define the field.' }; S.markers = [];
      } else if (r.far && r.far.marks) {
        // the far lane line was read: keep its marks; the coach adds the middle points the near side does not show
        const KEY = { 0: 'r0', 2: 'm2', 5: 'm5', 6: 'm6' };
        S.markers = [0, 2, 5, 6].filter(X => r.far.marks[X]).map(X => ({ key: KEY[X], side: 'far', u: r.far.marks[X][0], v: r.far.marks[X][1], auto: true }));
        S.autoField.farOnly = true;
      }
      render();
    }).catch(e => { busy.classList.remove('on'); if (S) { S.autoField = { ok: false, why: e.message }; render(); } });
  }
  // glare and sharpness on the pool itself once the field is known (deck, walls and overlays no longer count)
  function remeasure() { try { if (window.VACheck && S && S.cal) S.metrics = VACheck.measure(S.frame.data, S.cal.H); } catch (e) {} }
  function renderChecks() {
    const box = $('#xqvaChecks'); if (!box || !S || !window.VACheck || !S.metrics) return; box.innerHTML = '';
    const field = S.autoField ? { ok: S.autoField.ok || !!(S.cal && S.markers.length >= 4), why: S.autoField.ok ? null : (S.cal ? (S.autoField.farOnly ? 'Far lane line found automatically; middle points placed by you.' : 'Set by hand from your markers.') : S.autoField.why) } : null;
    for (const c of VACheck.checks(S.metrics, field, S.teamSep == null ? null : S.teamSep)) {
      el('button', { class: 'chk ' + (c.ok === true ? 'ok' : c.ok === false ? 'no' : 'wait'), title: c.text, text: c.label, on: { click: () => msg(c.text, c.ok === false ? 'warn' : '') } }, box);
    }
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
    el('div', { class: 'checks', id: 'xqvaChecks', 'aria-label': 'Frame check' }, top);
    el('span', { class: 'msg', id: 'xqvaMsg' }, top);
    el('button', { id: 'xqvaCancel', text: 'Cancel', on: { click: close } }, top);
    const view = el('div', { class: 'view' }, o);
    const svg = sv('svg', { class: 'frame', viewBox: `0 0 ${S.frame.w} ${S.frame.h}`, preserveAspectRatio: 'xMidYMid meet' }, view);
    sv('image', { href: S.frame.url, x: 0, y: 0, width: S.frame.w, height: S.frame.h }, svg);
    const cp = sv('clipPath', { id: 'xqvaClip' }, sv('defs', {}, svg)); sv('rect', { x: 0, y: 0, width: S.frame.w, height: S.frame.h }, cp);
    sv('g', { id: 'xqvaLines', 'clip-path': 'url(#xqvaClip)' }, svg); sv('g', { id: 'xqvaMarks' }, svg);
    svg.addEventListener('pointerdown', onDown); svg.addEventListener('pointermove', onMove); svg.addEventListener('pointerup', onUp);
    el('div', { class: 'busy', id: 'xqvaBusy', text: 'Reading players…' }, view);
    el('div', { class: 'tags', id: 'xqvaTags' }, o);
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
    renderChecks();
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
        t.textContent = (i + 1) + ' ' + (MARKERS.find(k => k.key === m.key) || {}).label.replace(' at the side rope', '').replace(' on the goal rope', '').replace(', middle of the field', ' (middle)') + (m.side === 'middle' ? '' : m.side === 'far' ? ' (far)' : ' (near)');
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

  /* Tags (MIZE, 2026-09-24): both teams by name, and the offensive and the defensive system — at least one of the two
     systems is required before the scene goes to the board. Saved with the scene so situations can be found and
     compared later (a team's typical defense, one system across games). Remembered for the next scene of the session. */
  function lastTags() { try { return JSON.parse(localStorage.getItem('xquixVaTags') || '{}'); } catch (e) { return {}; } }
  const tagsComplete = () => !!(S && S.tags && (S.tags.systemOffense || S.tags.systemDefense));
  function renderTags() {
    const box = $('#xqvaTags'); if (!box) return; box.style.display = S.step === 'players' ? '' : 'none';
    if (box.dataset.built) return; box.dataset.built = '1';
    const T = S.tags;
    const field = (key, ph, title) => { const i = el('input', { type: 'text', placeholder: ph, title, value: T[key] || '', 'aria-label': ph, autocomplete: 'off', autocapitalize: 'words' }, box);
      i.addEventListener('input', () => { T[key] = i.value.trim(); bottom(); }); i.addEventListener('keydown', ev => ev.stopPropagation()); return i; };
    el('span', { class: 'lbl', text: 'Teams' }, box);
    field('teamAttacking', 'Attacking team', 'The team attacking in this scene');
    field('teamDefending', 'Defending team', 'The team defending in this scene');
    el('span', { class: 'lbl', text: 'System' }, box);
    field('systemOffense', 'Offensive system', 'The attacking team’s system (e.g. 6-on-5, center play) — this or the defensive one is required');
    field('systemDefense', 'Defensive system', 'The defending team’s system (e.g. press, zone, M-drop) — this or the offensive one is required');
    el('span', { class: 'hint', text: 'one system is required' }, box);
  }
  function showReady() { const c = { unknown: 0 }; S.players.forEach(p => { if (p.role !== 'goalkeeper' && p.team === 'unknown') c.unknown++; }); return !!(S.attacking && !c.unknown && tagsComplete()); }
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
      const mids = S.markers.filter(m => MARKERS.find(k => k.key === m.key && k.middle)).length;
      if (S.autoField && S.autoField.farOnly && !S.cal) msg(`The far lane line was found automatically. The near side shows no marker: tap where the 2 m line and the 6 m line cross the middle of the field (in line with the goal center) and choose "Here"${mids ? ` (${mids} of 2 placed)` : ''}. The 5 m line works too.`, 'warn');
      else if (n === 0 && S.autoField && !S.autoField.ok) msg('The field could not be found automatically: ' + S.autoField.why + ' Mark it by hand: tap a marker you can see on the water and name it (at least 4).', 'warn');
      else if (n < 4) msg(`Tap a field marker you can see on the water and name it (${n} of at least 4). Use markers that are spread out: goal posts, 2 m floats, marks on the side ropes.`);
      else if (S.fitInfo && S.fitInfo.error) msg('These markers don’t define the field: ' + S.fitInfo.error, 'warn');
      else if (!S.fitInfo.spread) msg('The markers sit almost in one line. Add one further out from the goal line (a 2 m, 5 m or 6 m mark) and one across the pool.', 'warn');
      else if (n === 4) msg('4 markers: the field lines are drawn from them. Check that they sit on the water where they should. A 5th marker lets me measure the fit.');
      else msg(`${n} markers · they agree to ${S.fitInfo.mean.toFixed(2)} m on average` + (S.fitInfo.mean > 0.35 ? ' — they disagree: a marker is probably misplaced or misnamed (check the drawn lines)' : ''), S.fitInfo.mean > 0.35 ? 'warn' : '');
      return;
    }
    renderTags();
    const c = { light: 0, dark: 0, unknown: 0, gk: 0 }; S.players.forEach(p => { if (p.role === 'goalkeeper') c.gk++; else c[p.team]++; });
    const st = el('span', { class: 'stat' }, b);
    st.innerHTML = `Light <b>${c.light}</b> · Dark <b>${c.dark}</b> · Goalkeeper <b>${c.gk}</b>` + (c.unknown ? ` · <span class="warn">Team unread <b>${c.unknown}</b></span>` : '') + ` · Ball ${S.ball ? '✓' : '<span class="warn">none</span>'}`;
    el('span', { class: 'lbl', text: 'Attacking' }, b);
    const a = el('div', { class: 'seg' }, b);
    for (const v of ['light', 'dark']) el('button', { class: S.attacking === v ? 'sel' : '', text: v === 'light' ? 'Light' : 'Dark', on: { click: () => { S.attacking = v; S.attackingBy = 'coach'; render(); } } }, a);
    el('span', { class: 'spacer' }, b);
    el('button', { text: 'Back to field', on: { click: () => { S.step = 'field'; closePop(); render(); } } }, b);
    if (S.play) el('button', { class: 'primary', id: 'xqvaShow', text: 'Track the play', title: `Read every 0.5 s from ${fmtT(S.play.start)} to ${fmtT(S.play.end)} and animate it on the board`, disabled: showReady() ? null : '', on: { click: trackPlay } }, b);
    else el('button', { class: 'primary', id: 'xqvaShow', text: 'Show on board', disabled: showReady() ? null : '', on: { click: showOnBoard } }, b);
    const shaky = S.fitInfo && S.fitInfo.pxMax > 20;
    const pre = S.autoField && S.autoField.ok ? (shaky ? 'Field found automatically, but the lane-line marks don’t fully agree — check the field lines closely. ' : 'Field found automatically — check the field lines. ') : '';
    if (c.unknown) msg(pre + 'Tap each grey “?” player and set Light or Dark.', 'warn');
    else if (S.attacking && !tagsComplete()) msg(pre + 'Name the offensive or the defensive system (one is required), then Show on board.', 'warn');
    else if (!S.attacking) msg(pre + 'Which team is attacking? The scene can’t tell from these pairs — choose Light or Dark.', 'warn');
    else msg(pre + (S.play ? 'This is the first moment of the play: check every player, team and the ball — the play is tracked from them. ' : '') + 'Tap a ring to fix it, tap the water to add a missed player or the ball.' + (S.attackingBy === 'pairs' ? ' Attacking side read from the player pairs — change it if wrong.' : ''), shaky ? 'warn' : '');
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
      if (k.middle) { el('button', { text: 'Here', title: 'Where this line crosses the middle of the field, in line with the goal center',
        on: { click: () => { S.markers = S.markers.filter(m => m.key !== k.key); S.markers.push({ key: k.key, side: 'middle', u: p[0], v: p[1] }); closePop(); refit(); render(); } } }, seg); continue; }
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
      S.detector = { players: r.players.map(p => Object.assign({}, p)), ball: r.ball, ms: r.ms }; S.teamSep = r.teamSep; remeasure();
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
    const T = S.tags, teams = [T.teamAttacking, T.teamDefending].filter(Boolean).join(' vs '), systems = [T.systemOffense && 'O: ' + T.systemOffense, T.systemDefense && 'D: ' + T.systemDefense].filter(Boolean).join(', ');
    const tagName = [teams, systems].filter(Boolean).join(' · ');
    try { localStorage.setItem('xquixVaTags', JSON.stringify({ teamAttacking: T.teamAttacking, teamDefending: T.teamDefending })); } catch (e) {}
    const out = VAG.toStudioFormation(res, { attackingAtVisibleGoal: S.attacking, name: tagName ? tagName + ' — ' + S.frame.name : S.frame.name });
    if (out.error) { msg(out.error, 'warn'); return; }
    const rec = out.record;
    rec.videoAnalysis.phase = 'E-lab';
    rec.videoAnalysis.tags = Object.assign({}, S.tags); rec.videoAnalysis.H = S.cal.H;
    rec.videoAnalysis.review = { frameCheck: S.metrics || null, teamSep: S.teamSep ?? null, markers: S.markers.map(m => Object.assign({ label: markerLabel(m) }, m, markerWorld(m, S.spec))), fit: S.fitInfo,
      detector: S.detector, corrections: S.corrections, ballPlacedAtHolder: !!(S.ball && nearestHolder(S.ball.px)) };
    try {
      if (typeof recordHistory === 'function') recordHistory('Analyze scene: ' + rec.name);
      loadState(typeof formationRecordState === 'function' ? formationRecordState(rec) : rec.state);
      if (typeof resetTimelineForFormationLoad === 'function') resetTimelineForFormationLoad();
    } catch (e) { msg('The board could not take the scene: ' + e.message, 'warn'); return; }
    window.XQUIX.VideoAnalysis.last = rec;
    const snapshot = trainingRecord(rec);
    close();
    saveForTraining(snapshot);
    try { if (typeof XQStage !== 'undefined' && XQStage.isOpen()) XQStage.setCamera('center'); } catch (e) {}
    if (out.excluded.length) setTimeout(() => notify(out.excluded.length + (out.excluded.length === 1 ? ' player was' : ' players were') + ' left off the board: outside the 25 × 20 m field seen from this goal.'), 900);
  }
  // A held ball is above the water, so its own image point is not on the water plane: place it at the holder.
  function nearestHolder(px) {
    let best = null, bd = 1e9;
    for (const p of S.players) { const d = Math.hypot(p.head[0] - px[0], p.head[1] - px[1]); if (d < bd) { bd = d; best = p; } }
    return best && bd < Math.max(60, 3 * best.capPx) ? best : null;
  }

  // ---------- a play, not one moment (MIZE, 2026-09-24: "animate the play on the tactical board") ----------
  /* The coach pauses the video at the start of the possession and taps Track play; plays on to its end, pauses,
     taps again. The first moment is analyzed and confirmed exactly like a scene (it is saved for learning like one).
     Then every 0.5 s of the play is read with the same calibration, the detections are linked to the confirmed
     players (va-track.js), and the frames go onto the Studio timeline, 0.5 s apart, ready to play. Frames where a
     player was not found keep his last position and say so in the frame note - a gap is shown, never filled in. */
  const PLAY = { step: 0.5, maxSec: 30 };
  let playMark = null;   // { video, start } after the first tap
  const fmtT = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), sec = t - m * 60; return m + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1); };
  function seekTo(v, t) {
    return new Promise((res, rej) => {
      if (Math.abs(v.currentTime - t) < 0.02 && v.readyState >= 2) return res();
      const h = setTimeout(() => { v.removeEventListener('seeked', on); rej(new Error('the video did not seek to ' + fmtT(t))); }, 5000);
      const on = () => { clearTimeout(h); v.removeEventListener('seeked', on); res(); };
      v.addEventListener('seeked', on); v.currentTime = t;
    }).then(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 40))));
  }
  function markPlay() {
    const m = sourceMedia();
    if (!m || m.tagName !== 'VIDEO') { notify('Track play needs a video file on the left screen (Screens → Left → File). A YouTube player can’t be read frame by frame — use Analyze with screen capture for single moments.'); return; }
    if (!m.videoWidth) { notify('The video has not loaded a picture yet. Play it to the start of the possession, pause, and try again.'); return; }
    if (!m.paused) m.pause();
    const t = m.currentTime;
    if (!playMark || playMark.video !== m || t <= playMark.start + 0.6) {
      playMark = { video: m, start: t };
      toast(`Start of the play marked at ${fmtT(t)}. Play on to the end of the possession, pause there, and tap “End here”.`, true);
      try { if (typeof cwRender === 'function') cwRender(); } catch (_) {}
      return;
    }
    const start = playMark.start; let end = t, cut = '';
    if (end - start > PLAY.maxSec) { end = start + PLAY.maxSec; cut = ` The play is cut at ${PLAY.maxSec} s.`; }
    playMark = null; try { if (typeof cwRender === 'function') cwRender(); } catch (_) {}
    loadModel().catch(() => {});
    seekTo(m, start).then(() => {
      const g = grab();
      if (g.error) { notify(g.error); return; }
      if (g.capture) { notify('The video’s picture can’t be read (a protected or cross-site video). Use a video file.'); return; }
      g.name = `Play ${fmtT(start)}–${fmtT(end)}`;
      start_(g, { video: m, start, end });
      if (cut) notify(cut.trim());
    }).catch(e => notify('Could not go to the start of the play: ' + e.message));
  }
  function start_(g, play) { start(g); S.play = play; render(); }
  const detToWorld = p => { const w = VADetect.ap(S.cal.Hi, p.waterline[0], p.waterline[1]); return { id: p.id, team: p.team, role: p.role, X: w[0], Y: w[1], head: p.head, capPx: p.capPx }; };
  async function trackPlay() {
    if (!S || !S.play || !showReady()) return;
    const P = S.play, v = P.video, H = S.cal.H, spec = { length: S.spec.length, width: S.spec.width, goalWidth: S.spec.goalWidth };
    const busy = $('#xqvaBusy'); busy.textContent = 'Reading the play…'; busy.classList.add('on');
    const btn = $('#xqvaShow'); if (btn) btn.disabled = '';
    try {
      const [model] = await Promise.all([loadModel(), ensureTrack()]);
      // the confirmed first moment: the tracks. The goalkeeper's team is the defending team (as in showOnBoard).
      const defending = S.attacking === 'light' ? 'dark' : 'light';
      const tracks = S.players.map((p, i) => Object.assign(detToWorld(p), { track: i + 1, team: p.role === 'goalkeeper' ? 'unknown' : p.team, held: false, jump: false, moved: 0 }));
      const ballAt = (ball, players) => {   // where the ball is, in meters: at its holder if one is close (a held ball is above the water)
        if (!ball) return null;
        let best = null, bd = 1e9; for (const q of players) { const d = Math.hypot(q.head[0] - ball.px[0], q.head[1] - ball.px[1]); if (d < bd) { bd = d; best = q; } }
        if (best && bd < Math.max(60, 3 * best.capPx)) return { calc: { X: best.X, Y: best.Y }, holderId: best.id, px: ball.px };
        const w = VADetect.ap(S.cal.Hi, ball.px[0], ball.px[1]); return { calc: { X: w[0], Y: w[1] }, holderId: null, px: ball.px };
      };
      const times = []; for (let t = P.start + PLAY.step; t <= P.end + 1e-6; t += PLAY.step) times.push(+t.toFixed(3));
      const framesOut = [], log = [];
      let ball = ballAt(S.ball, tracks), ballHeld = 0;
      const snapshot = (t, info) => {
        const res = { H, spec, ball: ball ? { calc: ball.calc, holderId: ball.holderId } : null,
          players: tracks.map(k => ({ id: k.id, team: k.role === 'goalkeeper' ? defending : k.team, role: k.role, calc: { X: k.X, Y: k.Y }, track: k.track })) };
        const out = VAG.toStudioFormation(res, { attackingAtVisibleGoal: S.attacking, name: S.frame.name });
        if (out.error) throw new Error(out.error);
        const held = tracks.filter(k => k.held).length, jumps = tracks.filter(k => k.jump).length;
        const note = [fmtT(t), held ? `${held} not found (held)` : '', jumps ? `${jumps} jumped` : '', info && info.ballHeld ? 'ball not seen' : ''].filter(Boolean).join(' · ');
        framesOut.push(Object.assign(out.record.state, { duration: PLAY.step, note }));
        log.push({ t: +(t - P.start).toFixed(2), players: tracks.map(k => ({ track: k.track, team: k.team, role: k.role, X: +k.X.toFixed(2), Y: +k.Y.toFixed(2), held: k.held, jump: k.jump, moved: +k.moved.toFixed(2) })),
                   ball: ball ? { X: +ball.calc.X.toFixed(2), Y: +ball.calc.Y.toFixed(2), holder: ball.holderId, held: !!(info && info.ballHeld) } : null, matched: info ? info.matched : tracks.length });
      };
      snapshot(P.start, null);
      for (let k = 0; k < times.length; k++) {
        busy.textContent = `Reading the play… ${k + 1} of ${times.length}`;
        await seekTo(v, times[k]);
        const f = frameFrom(v, v.videoWidth, v.videoHeight, '');
        if (f.error) throw new Error('the video’s picture could not be read at ' + fmtT(times[k]));
        await new Promise(r => setTimeout(r, 15));
        const r = VADetect.detect(f.data, H, spec, model, {});
        const dets = r.players.map(detToWorld);
        const info = VATrack.link(tracks, dets, {});
        tracks.forEach(k => { if (k.det) { k.head = k.det.head; k.capPx = k.det.capPx; } });
        const nb = ballAt(r.ball, tracks.filter(k => !k.held));
        if (nb) { ball = nb; info.ballHeld = false; }
        else if (ball) { info.ballHeld = true; ballHeld++; if (ball.holderId) { const h = tracks.find(k => k.id === ball.holderId); if (h) ball = { calc: { X: h.X, Y: h.Y }, holderId: h.id }; } }
        // a ball that was at a holder stays with that player while it is not seen (he is the last one known to have it)
        snapshot(times[k], info);
      }
      // the first moment is a confirmed scene: saved for learning exactly like Show on board
      const first = framesOut[0];
      const rec = { schemaVersion: 1, type: 'formation', name: S.frame.name, savedAt: new Date().toISOString(), state: first,
        videoAnalysis: { phase: 'E-lab', play: { start: P.start, end: P.end, step: PLAY.step, frames: framesOut.length }, tags: Object.assign({}, S.tags), H, attacking: S.attacking,
          review: { frameCheck: S.metrics || null, teamSep: S.teamSep ?? null, markers: S.markers.map(m => Object.assign({ label: markerLabel(m) }, m, markerWorld(m, S.spec))), fit: S.fitInfo, detector: S.detector, corrections: S.corrections } } };
      const snapshotRec = trainingRecord(rec);
      const held = log.reduce((a, f) => a + f.players.filter(p => p.held).length, 0), jumps = log.reduce((a, f) => a + f.players.filter(p => p.jump).length, 0);
      window.XQUIX.VideoAnalysis.lastPlay = { name: S.frame.name, start: P.start, end: P.end, step: PLAY.step, tags: Object.assign({}, S.tags), attacking: S.attacking, H, spec, frames: log, held, jumps, ballHeld };
      // onto the timeline
      if (typeof frames === 'undefined' || typeof loadFrame !== 'function') throw new Error('this Studio has no timeline to take the play');
      try { if (typeof recordHistory === 'function') recordHistory('Analyze play: ' + S.frame.name); } catch (_) {}
      frames = framesOut; currentFrame = 0; loadFrame(0);
      try { if (typeof openTimelinePanel === 'function') openTimelinePanel(); } catch (_) {}
      const n = framesOut.length; busy.classList.remove('on'); close();
      saveForTraining(snapshotRec);
      try { if (typeof XQStage !== 'undefined' && XQStage.isOpen()) XQStage.setCamera('center'); } catch (_) {}
      const flags = [held ? `${held} player position${held === 1 ? '' : 's'} held (not found)` : '', jumps ? `${jumps} jump${jumps === 1 ? '' : 's'} flagged` : '', ballHeld ? `ball not seen in ${ballHeld} frame${ballHeld === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
      setTimeout(() => notify(`Play on the timeline: ${n} frames, ${((n - 1) * PLAY.step).toFixed(1)} s. ` + (flags ? `Check the frames whose note says so: ${flags}.` : 'Every player was found in every frame.')), 700);
    } catch (e) {
      busy.classList.remove('on'); if (btn) btn.disabled = null; msg('The play could not be tracked: ' + e.message, 'warn');
    }
  }

  // ---------- learning by doing (MIZE, 2026-09-24) ----------
  /* Every confirmed scene is kept as training data: the frame (private bucket video-analysis, <user id>/<scene id>.jpg)
     and a row in public.video_analysis_scenes with the field, the detector's reading, what the coach confirmed and every
     correction. Platform admin (MIZE) only, by RLS; nothing is sent for anyone else. */
  function trainingRecord(rec) {
    const round = v => (typeof v === 'number' ? +v.toFixed(1) : v);
    return {
      name: rec.name, frameUrl: S.frame.url, w: S.frame.w, h: S.frame.h,
      field: { markers: S.markers.map(m => ({ key: m.key, side: m.side, u: round(m.u), v: round(m.v), auto: !!m.auto, X: markerWorld(m, S.spec).X, Y: markerWorld(m, S.spec).Y })),
               auto: S.autoField || null, fit: S.fitInfo || null, width: S.spec.width, ropeBehind: S.spec.ropeBehind, H: S.cal && S.cal.H },
      detector: S.detector || null,
      confirmed: { players: S.players.map(p => ({ id: p.id, head: p.head.map(round), waterline: p.waterline.map(round), capPx: p.capPx, team: p.team, role: p.role, source: p.source || 'detector', detectConf: p.detectConf ?? null })),
                   ball: S.ball ? { px: S.ball.px.map(round), source: S.ball.source } : null, attacking: S.attacking, attackingBy: S.attackingBy },
      corrections: S.corrections, frameCheck: Object.assign({}, S.metrics || {}, { teamSep: S.teamSep ?? null }), formation: rec.videoAnalysis, tags: Object.assign({}, S.tags)
    };
  }
  function toast(text, warn) {
    let t = document.getElementById('xqvaToast');
    if (!t) { t = el('div', { id: 'xqvaToast' }, document.body);
      t.style.cssText = 'position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147481600;background:#0e1416;color:#e8eef0;border:1px solid #2a3a3e;border-radius:8px;padding:8px 14px;font:600 13px system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);transition:opacity .4s;max-width:min(560px,calc(100vw - 32px));text-align:center;pointer-events:none'; }
    t.textContent = text; t.style.borderColor = warn ? 'rgba(242,194,48,.7)' : 'rgba(46,202,184,.55)'; t.style.opacity = '1';
    clearTimeout(t._h); t._h = setTimeout(() => { t.style.opacity = '0'; }, warn ? 6000 : 3000);
  }
  const auth = () => (window.XQUIX && XQUIX.Auth && XQUIX.Auth.getClient) ? XQUIX.Auth : null;
  async function saveForTraining(r) {
    const A = auth(), sb = A && A.getClient(), user = A && A.getCurrentUser();
    if (!sb || !user) { toast('Not saved for learning: sign in to the Studio first.', true); return { saved: false, why: 'signed out' }; }
    try {
      const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), path = user.id + '/' + id + '.jpg';
      const blob = await (await fetch(r.frameUrl)).blob();
      const up = await sb.storage.from('video-analysis').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (up.error) throw up.error;
      const row = { id, name: r.name, source: document.getElementById('labBanner') ? 'lab' : 'studio', frame_path: path, frame_w: r.w, frame_h: r.h,
        team_attacking: r.tags.teamAttacking || null, team_defending: r.tags.teamDefending || null, system_offense: r.tags.systemOffense || null, system_defense: r.tags.systemDefense || null,
        field: r.field, detector: r.detector, confirmed: r.confirmed, corrections: r.corrections, frame_check: r.frameCheck, formation: r.formation,
        app_version: window.LAB_PINNED ? 'presentationlab ' + window.LAB_PINNED : 'studio' };
      const ins = await sb.from('video_analysis_scenes').insert(row);
      if (ins.error) throw ins.error;
      toast('Scene saved for learning.');
      return { saved: true, id };
    } catch (e) {
      const m = (e && (e.message || e.error)) || String(e);
      toast(/row-level security|permission|403|Unauthorized/i.test(m) ? 'Not saved for learning: only the platform admin’s scenes are collected.' : 'Not saved for learning: ' + m, true);
      return { saved: false, why: m };
    }
  }
  /* The lab's LAB panel gets "Export training scenes": every saved scene with its frame, one JSON file to download. */
  async function exportScenes(btn) {
    const A = auth(), sb = A && A.getClient();
    if (!sb || !A.getCurrentUser()) { toast('Sign in to the Studio to export.', true); return; }
    btn.disabled = true; const label = btn.textContent;
    try {
      const { data, error } = await sb.from('video_analysis_scenes').select('*').order('created_at');
      if (error) throw error;
      const out = [];
      for (let i = 0; i < data.length; i++) {
        btn.textContent = `Exporting ${i + 1} / ${data.length}…`;
        const r = data[i]; let frame = null;
        if (r.frame_path) { const dl = await sb.storage.from('video-analysis').download(r.frame_path);
          if (!dl.error) frame = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(dl.data); }); }
        out.push(Object.assign({}, r, { frame }));
      }
      const blob = new Blob([JSON.stringify({ kind: 'xquix-video-analysis-training', exportedAt: new Date().toISOString(), scenes: out })], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'xquix-training-scenes-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove();
      toast(`${out.length} scenes exported.`);
    } catch (e) { toast('Export failed: ' + ((e && e.message) || e), true); }
    btn.disabled = false; btn.textContent = label;
  }

  // ---------- scene library (MIZE, 2026-09-24: tagged situations, searchable by team and system) ----------
  let LIB = null;
  async function openLibrary() {
    const A = auth(), sb = A && A.getClient();
    if (!sb || !A.getCurrentUser()) { toast('Sign in to the Studio to open the scene library.', true); return; }
    closeLibrary();
    document.body.classList.toggle('xqvaLab', !!document.getElementById('labBanner'));
    const o = el('div', { id: 'xqvaLib', role: 'dialog', 'aria-label': 'Scene library' }, document.body);
    const top = el('div', { class: 'bar' }, o);
    el('span', { class: 'title', text: 'Scene library' }, top);
    el('span', { class: 'lbl', text: 'Team' }, top); const fTeam = el('select', { id: 'xqvaLibTeam' }, top);
    el('span', { class: 'lbl', text: 'System' }, top); const fSys = el('select', { id: 'xqvaLibSys' }, top);
    el('span', { class: 'lbl', text: 'Side' }, top); const fSide = el('select', { id: 'xqvaLibSide' }, top);
    for (const [v, t] of [['', 'Any'], ['offense', 'Offense'], ['defense', 'Defense']]) el('option', { value: v, text: t }, fSide);
    const count = el('span', { class: 'lbl', id: 'xqvaLibCount' }, top);
    el('span', { class: 'spacer' }, top);
    el('button', { class: 'primary', id: 'xqvaLibCompare', text: 'Compare', title: 'The average formation of the scenes shown, on the board', on: { click: compareScenes } }, top);
    el('button', { text: 'Close', on: { click: closeLibrary } }, top);
    const grid = el('div', { class: 'grid', id: 'xqvaLibGrid' }, o);
    el('div', { class: 'empty', text: 'Loading…' }, grid);
    document.addEventListener('keydown', libKey, true);
    const { data, error } = await sb.from('video_analysis_scenes').select('id,created_at,name,source,frame_path,team_attacking,team_defending,system_offense,system_defense,formation,field').order('created_at', { ascending: false });
    if (error) { grid.innerHTML = ''; el('div', { class: 'empty', text: 'Could not load the scenes: ' + error.message }, grid); return; }
    LIB = { scenes: data, thumbs: {} };
    const teams = [...new Set(data.flatMap(r => [r.team_attacking, r.team_defending]).filter(Boolean))].sort();
    const systems = [...new Set(data.flatMap(r => [r.system_offense, r.system_defense]).filter(Boolean))].sort();
    el('option', { value: '', text: 'Any team' }, fTeam); teams.forEach(t => el('option', { value: t, text: t }, fTeam));
    el('option', { value: '', text: 'Any system' }, fSys); systems.forEach(t => el('option', { value: t, text: t }, fSys));
    [fTeam, fSys, fSide].forEach(f => f.addEventListener('change', renderLibrary));
    renderLibrary();
  }
  function libKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeLibrary(); } }
  function closeLibrary() { const o = document.getElementById('xqvaLib'); if (o) o.remove(); if (!document.getElementById('xqva')) document.body.classList.remove('xqvaLab'); document.removeEventListener('keydown', libKey, true); }
  function libraryFilter() {
    const team = ($('#xqvaLibTeam') || {}).value || '', sys = ($('#xqvaLibSys') || {}).value || '', side = ($('#xqvaLibSide') || {}).value || '';
    return LIB.scenes.filter(r => {
      if (team && r.team_attacking !== team && r.team_defending !== team) return false;
      if (sys && r.system_offense !== sys && r.system_defense !== sys) return false;
      // "side" is about the chosen team when one is chosen (its offense = it attacks), else about which system is named
      if (side === 'offense') { if (team ? r.team_attacking !== team : !r.system_offense) return false; }
      if (side === 'defense') { if (team ? r.team_defending !== team : !r.system_defense) return false; }
      return true;
    });
  }
  function renderLibrary() {
    const grid = $('#xqvaLibGrid'); if (!grid || !LIB) return; grid.innerHTML = '';
    const rows = libraryFilter(); $('#xqvaLibCount').textContent = rows.length + (rows.length === 1 ? ' scene' : ' scenes');
    const cb = $('#xqvaLibCompare'); if (cb) cb.disabled = rows.length < 2;
    if (!rows.length) { el('div', { class: 'empty', text: LIB.scenes.length ? 'No scene matches these filters.' : 'No scenes saved yet. Every scene you put on the board with Analyze is saved here.' }, grid); return; }
    for (const r of rows) {
      const card = el('div', { class: 'card', role: 'button', tabindex: 0, title: 'Open this scene on the board' }, grid);
      const th = el('div', { class: 'thumb' }, card); loadThumb(r, th);
      const m = el('div', { class: 'meta' }, card);
      el('div', { class: 'teams', text: [r.team_attacking, r.team_defending].filter(Boolean).join(' vs ') || (r.name || 'Scene') }, m);
      el('div', { class: 'sys', text: [r.system_offense && 'O: ' + r.system_offense, r.system_defense && 'D: ' + r.system_defense].filter(Boolean).join('  ·  ') }, m);
      el('div', { class: 'when', text: new Date(r.created_at).toLocaleString() + (r.source === 'lab' ? ' · lab' : '') }, m);
      const open = () => openScene(r);
      card.addEventListener('click', open); card.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') open(); });
    }
  }
  async function loadThumb(r, th) {
    if (!r.frame_path) return;
    if (LIB.thumbs[r.id]) { th.style.backgroundImage = `url(${LIB.thumbs[r.id]})`; return; }
    try { const sb = auth().getClient(); const { data, error } = await sb.storage.from('video-analysis').createSignedUrl(r.frame_path, 600);
      if (!error && data && data.signedUrl) { LIB.thumbs[r.id] = data.signedUrl; th.style.backgroundImage = `url(${data.signedUrl})`; } } catch (e) {}
  }
  /* A saved scene back onto the board: the same formation record that went there when it was confirmed. */
  function openScene(r) {
    const va = r.formation; if (!va) { toast('This scene has no board record.', true); return; }
    try {
      // rebuild the Studio record from the stored videoAnalysis + confirmed players via toStudioFormation
      const res = { H: va.H, spec: va.spec, players: (va.players || []).map(p => ({ id: p.id, team: p.team, role: p.role, calc: p.sourceField })), ball: null };
      const out = VAG.toStudioFormation(Object.assign({}, res, { H: va.H || hFromVa(r) }), { attackingAtVisibleGoal: va.attacking, name: r.name || 'Scene' });
      if (out.error) throw new Error(out.error);
      const rec = out.record; rec.videoAnalysis = va;
      if (typeof recordHistory === 'function') recordHistory('Scene library: ' + rec.name);
      loadState(typeof formationRecordState === 'function' ? formationRecordState(rec) : rec.state);
      if (typeof resetTimelineForFormationLoad === 'function') resetTimelineForFormationLoad();
      closeLibrary();
      try { if (typeof XQStage !== 'undefined' && XQStage.isOpen()) XQStage.setCamera('center'); } catch (e) {}
    } catch (e) { toast('Could not open the scene: ' + e.message, true); }
  }
  /* Compare (MIZE, 2026-09-24: "analyze patterns and structures of systems with the same tag"): the average formation
     of the scenes shown. Every scene is put in one frame (X out from the goal the attack goes to, Y across, +Y = the
     far side as seen from the camera... which differs per camera - so Y is mirrored where needed so that the attackers'
     mean Y is the same sign, the best available normalisation without cap numbers). Players of a side are matched
     across scenes to running average positions (Hungarian assignment, iterated); each average position carries how
     far the matched players sit from it (the spread) and in how many scenes it was found. Shown on the board as a
     formation: the average positions as players, a note with the spread; nothing is invented - only the scenes'
     confirmed positions go in. Needs 2 scenes; 20-30 of one team and system to say something. */
  function scenePositions(r) {
    const va = r.formation; if (!va || !va.players) return null;
    const out = [];
    for (const p of va.players) { if (!p.sourceField || p.role === 'goalkeeper') continue; if (p.side !== 'offence' && p.side !== 'defence') continue;
      out.push({ side: p.side === 'offence' ? 'offense' : 'defense', X: p.sourceField.X, Y: p.sourceField.Y }); }
    return out.length ? out : null;
  }
  function hungarian(D) {          // rows <= cols; returns col index per row (min total cost), small sizes only
    const n = D.length, m = D[0].length; let best = null;
    const perm = (used, row, cost, asg) => { if (best && cost >= best.cost) return; if (row === n) { best = { cost, asg: asg.slice() }; return; }
      for (let j = 0; j < m; j++) if (!used[j]) { used[j] = true; asg.push(j); perm(used, row + 1, cost + D[row][j], asg); asg.pop(); used[j] = false; } };
    if (n <= 7) { perm(new Array(m).fill(false), 0, 0, []); return best.asg; }
    // greedy fallback for larger sets
    const asg = [], used = new Set(); for (let i = 0; i < n; i++) { let bj = -1; for (let j = 0; j < m; j++) if (!used.has(j) && (bj < 0 || D[i][j] < D[i][bj])) bj = j; used.add(bj); asg.push(bj); } return asg;
  }
  function averageFormation(sets, iters) {
    sets = sets.filter(s => s.length);
    if (sets.length < 2) return null;
    // normalise the across-field sign: the attackers' ball-side is unknown, so use the side with more spread... keep simple:
    // mirror a scene when its mean Y has the opposite sign of the first scene's mean Y (both sides together)
    let ref = sets.reduce((a, b) => (b.length > a.length ? b : a)).map(p => [p[0], p[1]]);
    let acc;
    for (let it = 0; it < (iters || 8); it++) {
      acc = ref.map(() => []);
      for (const s of sets) {
        const rows = ref.length <= s.length ? ref : s, cols = ref.length <= s.length ? s : ref;
        const D = rows.map(a => cols.map(b => Math.hypot(a[0] - b[0], a[1] - b[1])));
        const asg = hungarian(D);
        asg.forEach((j, i) => { const ri = ref.length <= s.length ? i : j, sp = ref.length <= s.length ? s[j] : s[i]; acc[ri].push(sp); });
      }
      ref = acc.map((a, i) => a.length ? [a.reduce((t, p) => t + p[0], 0) / a.length, a.reduce((t, p) => t + p[1], 0) / a.length] : ref[i]);
    }
    return ref.map((p, i) => ({ X: p[0], Y: p[1], n: acc[i].length, spread: acc[i].length ? acc[i].reduce((t, q) => t + Math.hypot(q[0] - p[0], q[1] - p[1]), 0) / acc[i].length : null }));
  }
  function compareScenes() {
    const rows = libraryFilter().map(r => ({ r, pos: scenePositions(r) })).filter(x => x.pos);
    if (rows.length < 2) { toast('Choose at least two scenes with player positions to compare.', true); return; }
    // mirror across the field where needed: align each scene's attackers' mean Y sign with the first scene's
    const meanY = pos => { const a = pos.filter(p => p.side === 'offense'); return a.length ? a.reduce((t, p) => t + p.Y, 0) / a.length : 0; };
    const sign0 = Math.sign(meanY(rows[0].pos)) || 1;
    const norm = rows.map(x => { const sg = (Math.sign(meanY(x.pos)) || 1) === sign0 ? 1 : -1; return x.pos.map(p => ({ side: p.side, X: p.X, Y: sg * p.Y })); });
    const avg = {};
    for (const side of ['offense', 'defense']) avg[side] = averageFormation(norm.map(pos => pos.filter(p => p.side === side).map(p => [p.X, p.Y])));
    if (!avg.offense && !avg.defense) { toast('These scenes hold no comparable positions.', true); return; }
    // onto the board: attackers light, defenders dark (a comparison has no real cap colors), goal on the left
    const H = [[1, 0, 0], [0, -1, 0], [0, 0, 1]];  // image y grows down: this puts the goal on the Studio's LEFT (handedness +1)
    const players = [];
    for (const side of ['offense', 'defense']) for (const p of (avg[side] || [])) players.push({ id: side + players.length, team: side === 'offense' ? 'light' : 'dark', role: 'field', calc: { X: p.X, Y: p.Y }, n: p.n, spread: p.spread });
    const team = ($('#xqvaLibTeam') || {}).value, sys = ($('#xqvaLibSys') || {}).value, sd = ($('#xqvaLibSide') || {}).value;
    const name = 'Average of ' + rows.length + ' scenes' + (team ? ' · ' + team : '') + (sys ? ' · ' + sys : '') + (sd ? ' · ' + sd : '');
    const out = VAG.toStudioFormation({ H, spec: { length: 25, width: 20, goalWidth: 3 }, players, ball: null }, { attackingAtVisibleGoal: 'light', name });
    if (out.error) { toast(out.error, true); return; }
    const rec = out.record;
    rec.videoAnalysis.comparison = { scenes: rows.map(x => x.r.id), filters: { team, system: sys, side: sd }, positions: players.map(p => ({ side: p.team === 'light' ? 'offense' : 'defense', X: +p.calc.X.toFixed(2), Y: +p.calc.Y.toFixed(2), scenes: p.n, spread: p.spread == null ? null : +p.spread.toFixed(2) })) };
    try {
      if (typeof recordHistory === 'function') recordHistory('Scene library: ' + name);
      loadState(typeof formationRecordState === 'function' ? formationRecordState(rec) : rec.state);
      if (typeof resetTimelineForFormationLoad === 'function') resetTimelineForFormationLoad();
    } catch (e) { toast('The board could not take the comparison: ' + e.message, true); return; }
    window.XQUIX.VideoAnalysis.lastComparison = rec.videoAnalysis.comparison;
    closeLibrary();
    try { if (typeof XQStage !== 'undefined' && XQStage.isOpen()) XQStage.setCamera('center'); } catch (e) {}
    const worst = players.filter(p => p.spread != null).sort((a, b) => b.spread - a.spread)[0];
    toast(`${name}: attackers light, defenders dark. Average positions; the least settled one moves ${worst ? worst.spread.toFixed(1) : '?'} m between scenes.`);
  }
  // the handedness (which Studio goal) needs H; it was stored in the field record of the scene
  function hFromVa(r) { const f = r.field || {}; return f.H || null; }

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
        const marked = playMark && playMark.video === m;
        L.splice(i + 2, 0, { id: 'trackPlay', label: marked ? 'End here' : 'Track play', icon: marked ? ICON_END : ICON_PLAY,
          title: marked ? `Play marked from ${fmtT(playMark.start)}: pause at the end of the possession and tap` : 'Animate a possession on the center board: pause at its start and tap, play to its end, pause and tap again',
          tap: () => markPlay() });
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
    // 3. SYSTEM group: the scene library (next to Library / Notes / Menu / Mode)
    if (typeof window.cwItems === 'function' && !window.cwItems._xqvaLib) {
      const orig2 = window.cwItems;
      const wrapped2 = function (g) { const L = orig2.apply(this, arguments); if (g !== 'system' || !Array.isArray(L)) return L;
        const i = L.findIndex(x => x && x.id === 'library');
        L.splice(i < 0 ? 0 : i + 1, 0, { id: 'scenes', label: 'Scenes', icon: ICON, title: 'Scene library: the situations you analyzed, by team and system', tap: () => openLibrary() }); return L; };
      wrapped2._xqva = window.cwItems._xqva; wrapped2._xqvaLib = true; window.cwItems = wrapped2;
    }
    // 4. LAB panel: export the collected training scenes
    const panel = document.getElementById('labPanel');
    if (panel && !document.getElementById('labVaExport')) {
      const b = document.createElement('button'); b.id = 'labVaExport'; b.textContent = 'Export training scenes (video analysis)';
      b.addEventListener('click', () => exportScenes(b)); panel.appendChild(b);
    }
    // keep the Analyze button's enabled state current when the left screen changes
    const c = document.getElementById('videoContent');
    if (c && !c._xqva) { c._xqva = true; new MutationObserver(() => { try { if (typeof cwRender === 'function') cwRender(); } catch (_) {} }).observe(c, { childList: true }); }
  }
  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="14" r="1.8"/><circle cx="12" cy="9" r="1.8"/><circle cx="18" cy="13" r="1.8"/><path d="M7.5 12.7 10.5 10.3M13.7 9.8l2.8 2.2"/><path d="M3 20h18"/></svg>';
  const ICON_END = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="1.6"/><circle cx="15" cy="10" r="1.6"/><circle cx="12" cy="15" r="1.6"/></svg>';

  window.XQUIX = window.XQUIX || {};
  window.XQUIX.VideoAnalysis = { open, close, state: () => S, loadModel, _grab: grab, canCapture, saveForTraining, exportScenes, openLibrary, closeLibrary, markPlay, trackPlay, playMark: () => playMark };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  window.addEventListener('load', wire);
})();
