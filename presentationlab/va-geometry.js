/* XquiX Video Analysis — Phase B geometry evaluation core.
   Pure JS. Depends only on homography.js (HG). Runs in the browser harness and in Node.
   NOT production code: nothing here is loaded by index.html.

   COORDINATE FRAMES
   Source field (measurement frame, true metres of the recorded pool — never rescaled):
     X = distance from the VISIBLE goal line into the field      (0 .. spec.length)
     Y = lateral offset from that goal's centre; +Y = FAR sideline (away from the camera),
         -Y = near sideline (camera side)                         (-width/2 .. +width/2)
   XquiX board (rendering only, 29 x 24 incl. deck, field 25 x 20 at (2,2)):
     visible goal = Studio's LEFT goal  (Blue defends):  board = (2 + X, 12 - Y)
     visible goal = Studio's RIGHT goal (White defends): board = (27 - X, 12 + Y)
     The two are a 180-degree rotation of each other, never a mirror.
     "12 - Y" keeps the camera's side at the bottom of the board, which is a true overhead
     view from the camera's side (frame-reader/ZONE-NAMING-DECISION.md). NOTE:
     frame-reader/STUDIO-IMPORT-FORMAT.md writes "12 + Y" for the left goal; the Phase B
     import check is what settles it on a real frame (near-side player must land lower). */
(function (root, factory) {
  const HG = (typeof module === 'object' && module.exports) ? require('./homography.js') : root.HG;
  const api = factory(HG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VAG = api;
})(typeof self !== 'undefined' ? self : this, function (HG) {
  'use strict';

  const DEFAULT_SPEC = { length: 25, width: 20, goalWidth: 3.0 };

  // ---------- statistics ----------
  function stats(arr) {
    const a = arr.filter(Number.isFinite).slice().sort((p, q) => p - q);
    if (!a.length) return { n: 0, mean: null, median: null, max: null, p90: null };
    const q = f => { const i = (a.length - 1) * f, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
    return { n: a.length, mean: a.reduce((s, v) => s + v, 0) / a.length, median: q(0.5), p90: q(0.9), max: a[a.length - 1] };
  }

  // Deterministic RNG so a report can be reproduced exactly.
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // ---------- calibration ----------
  /* refs: [{ id, label, X, Y, u, v }] — known water-plane points, in the source-field frame.
     Returns the HG calibration object or { error }. */
  function fit(refs) {
    if (!refs || refs.length < 4) return { error: 'needs at least 4 fit references (has ' + (refs ? refs.length : 0) + ')' };
    if (!generalPosition(refs)) return { error: 'the fit references lie (almost) on one line — add a reference away from that line' };
    const cal = HG.calibrateFromReferences({ points: refs.map(r => ({ X: r.X, Y: r.Y, u: r.u, v: r.v, label: r.label })) });
    if (!cal || cal.error) return { error: cal ? cal.error : 'could not solve' };
    return cal;
  }

  // At least three non-collinear world points (in metres) among the fit set.
  function generalPosition(refs) {
    for (let i = 0; i < refs.length; i++) for (let j = i + 1; j < refs.length; j++) for (let k = j + 1; k < refs.length; k++) {
      const a = refs[i], b = refs[j], c = refs[k];
      const area2 = Math.abs((b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X));
      if (area2 > 1.0) return true;           // triangle area > 0.5 m^2
    }
    return false;
  }

  function err(pred, truth) {
    const dX = pred.X - truth.X, dY = pred.Y - truth.Y;
    return { dX, dY, e: Math.hypot(dX, dY) };
  }

  /* The whole Phase B evaluation for one frame.
     session = {
       spec: { length, width, goalWidth },
       refs: [{ id, label, X, Y, u, v, role: 'fit' | 'check' }],
       players: [{ id, team: 'light'|'dark'|'unknown', role: 'field'|'goalkeeper'|'unknown',
                   u, v,                     // waterline point (the anchor under test)
                   cap: { u, v } | null,     // optional: the cap itself, to measure the anchor effect
                   truth: { X, Y } | null }],// MIZE's ground truth, source-field metres
       ball: { u, v, truth: {X,Y} | null } | null,
       noisePx: 2, noiseRuns: 300, seed: 1
     } */
  function evaluate(session) {
    const spec = Object.assign({}, DEFAULT_SPEC, session.spec || {});
    const refs = session.refs || [];
    const fitRefs = refs.filter(r => r.role !== 'check');
    const checkRefs = refs.filter(r => r.role === 'check');
    const cal = fit(fitRefs);
    const out = { spec, generatedAt: null, fitCount: fitRefs.length, checkCount: checkRefs.length };
    if (cal.error) { out.error = cal.error; return out; }
    out.H = cal.H;

    // 1. Fit residuals — how well the model explains the points it was built from. NOT accuracy.
    out.fitResiduals = fitRefs.map(r => {
      const p = cal.toWorld(r.u, r.v), im = cal.toImage(r.X, r.Y);
      return { id: r.id, label: r.label, px: [r.u, r.v], truth: { X: r.X, Y: r.Y }, calc: { X: p.X, Y: p.Y },
               errM: err(p, r).e, errPx: Math.hypot(im.u - r.u, im.v - r.v) };
    });

    // 2. Hold-out references — never used in the fit. This is an accuracy measurement.
    out.check = checkRefs.map(r => {
      const p = cal.toWorld(r.u, r.v), e = err(p, r);
      return { id: r.id, label: r.label, px: [r.u, r.v], calc: { X: p.X, Y: p.Y }, truth: { X: r.X, Y: r.Y },
               errM: e.e, dX: e.dX, dY: e.dY, mpp: cal.metresPerPixel(r.u, r.v) };
    });

    // 3. Leave-one-out over EVERY reference (fit and check alike): each one predicted by a
    //    calibration that did not see it. Uses all references as the pool, one left out at a time.
    out.loo = refs.map(r => {
      const others = refs.filter(o => o !== r);
      const c = fit(others);
      if (c.error) return { id: r.id, label: r.label, error: c.error };
      const p = c.toWorld(r.u, r.v), e = err(p, r);
      // How consistent the REST are once this one is gone. A single wrong reference (misnamed
      // marker, mis-click) drags every leave-one-out error up — it poisons each fit it is in —
      // so the LOO error alone does not point at it. Removing the culprit, however, leaves the
      // others agreeing with each other: its othersResidualM is by far the smallest.
      const othersResidualM = others.reduce((s, o) => s + err(c.toWorld(o.u, o.v), o).e, 0) / others.length;
      return { id: r.id, label: r.label, calc: { X: p.X, Y: p.Y }, truth: { X: r.X, Y: r.Y }, errM: e.e, dX: e.dX, dY: e.dY, othersResidualM };
    });
    { // name a suspect only when removing one reference makes the rest clearly more consistent
      const ok = out.loo.filter(q => Number.isFinite(q.othersResidualM)).sort((a, b) => a.othersResidualM - b.othersResidualM);
      out.suspectRef = (ok.length >= 5 && ok[0].othersResidualM * 3 < ok[1].othersResidualM && ok[1].othersResidualM > 0.15) ? ok[0].id : null;
    }

    // 4. Players: video pixel -> calculated field coordinate -> ground truth -> error.
    const noise = noiseStudy(fitRefs, (session.players || []).map(p => [p.u, p.v]), session.noisePx ?? 2, session.noiseRuns ?? 300, session.seed ?? 1);
    out.players = (session.players || []).map((p, i) => {
      const c = cal.toWorld(p.u, p.v);
      const row = { id: p.id, team: p.team || 'unknown', role: p.role || 'unknown', capNumber: null,
                    px: [p.u, p.v], calc: { X: c.X, Y: c.Y }, truth: p.truth || null,
                    mpp: cal.metresPerPixel(p.u, p.v), horizonPx: cal.horizonMargin(p.u, p.v),
                    noiseP50: noise ? noise[i].p50 : null, noiseP90: noise ? noise[i].p90 : null,
                    inSourceField: c.X >= -0.5 && c.X <= spec.length + 0.5 && Math.abs(c.Y) <= spec.width / 2 + 0.5 };
      if (p.truth) { const e = err(c, p.truth); row.errM = e.e; row.dX = e.dX; row.dY = e.dY; }
      if (p.cap && Number.isFinite(p.cap.u)) {
        const cc = cal.toWorld(p.cap.u, p.cap.v);
        row.capCalc = { X: cc.X, Y: cc.Y };
        if (p.truth) row.capErrM = err(cc, p.truth).e;
      }
      return row;
    });

    if (session.ball && Number.isFinite(session.ball.u)) {
      const c = cal.toWorld(session.ball.u, session.ball.v);
      out.ball = { px: [session.ball.u, session.ball.v], calc: { X: c.X, Y: c.Y }, truth: session.ball.truth || null };
      if (session.ball.truth) out.ball.errM = err(c, session.ball.truth).e;
    }

    const measured = out.players.filter(r => Number.isFinite(r.errM));
    out.summary = {
      players: stats(measured.map(r => r.errM)),
      playersCapPoint: stats(out.players.filter(r => Number.isFinite(r.capErrM)).map(r => r.capErrM)),
      check: stats(out.check.map(r => r.errM)),
      loo: stats(out.loo.filter(r => Number.isFinite(r.errM)).map(r => r.errM)),
      fitResidualM: stats(out.fitResiduals.map(r => r.errM)),
      noiseP90: stats(out.players.map(r => r.noiseP90)),
      depthRange: measured.length ? [Math.min(...measured.map(r => r.truth.X)), Math.max(...measured.map(r => r.truth.X))] : null,
      lateralRange: measured.length ? [Math.min(...measured.map(r => r.truth.Y)), Math.max(...measured.map(r => r.truth.Y))] : null
    };
    return out;
  }

  /* Click-noise sensitivity: perturb every fit reference by a random offset inside a disc of
     radius r px, refit, and see how far each player's computed position moves. This does not
     measure accuracy — it measures how much a pixel or two of clicking changes the answer. */
  function noiseStudy(fitRefs, pts, r, runs, seed) {
    if (!pts.length || !(r > 0) || fitRefs.length < 4) return null;
    const base = fit(fitRefs);
    if (base.error) return null;
    const ref0 = pts.map(([u, v]) => base.toWorld(u, v));
    const rand = rng(seed), d = pts.map(() => []);
    for (let k = 0; k < runs; k++) {
      const jittered = fitRefs.map(f => { const a = rand() * 2 * Math.PI, m = r * Math.sqrt(rand()); return Object.assign({}, f, { u: f.u + m * Math.cos(a), v: f.v + m * Math.sin(a) }); });
      const c = fit(jittered);
      if (c.error) continue;
      pts.forEach(([u, v], i) => { const p = c.toWorld(u, v); d[i].push(Math.hypot(p.X - ref0[i].X, p.Y - ref0[i].Y)); });
    }
    return d.map(arr => { const s = stats(arr); return { p50: s.median, p90: s.p90 }; });
  }

  // ---------- frames ----------
  /* Source field -> XquiX field-of-play space (MIZE.Field: 0..25 along, 0..20 across, from the
     top-left corner of the board's field). Only meaningful where the source point lies inside a
     25 x 20 field measured from the visible goal; elsewhere returns inXquiX:false with the true
     value kept. No rescaling, ever (MIZE decision 4, 2026-09-23). */
  /* HANDEDNESS (found 2026-09-24 by loading Test 7 into the real Studio): the measurement frame
     (X out from the goal, +Y toward the FAR side) is right-handed only when the visible goal appears on
     the LEFT of the camera image. When the goal appears on the right, the same convention is a mirror
     image, and a plain "12 - Y" mapping reflects the scene (a left wing becomes a right wing).
     s = +1 (goal on the image's left) or -1 (goal on the right), read from the calibration itself:
     the image directions of +X and +Y, compared with the image's own orientation (y grows down). */
  function handedness(H) {
    if (!H) return 1;
    const im = (X, Y) => { const s = H[2][0]*X + H[2][1]*Y + H[2][2]; return [(H[0][0]*X + H[0][1]*Y + H[0][2])/s, (H[1][0]*X + H[1][1]*Y + H[1][2])/s]; };
    const o = im(0, 0), a = im(1, 0), b = im(0, 1);
    const z = (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
    return z < 0 ? 1 : -1;
  }
  function toXquiXField(X, Y, visibleGoal, hand) {
    const left = visibleGoal !== 'right', s = hand || 1;
    const fx = left ? X : 25 - X, fy = left ? 10 - s * Y : 10 + s * Y;
    return { fx, fy, inXquiX: fx >= 0 && fx <= 25 && fy >= 0 && fy <= 20 };
  }
  function toBoard(X, Y, visibleGoal, hand) {
    const f = toXquiXField(X, Y, visibleGoal, hand);
    return { x: f.fx + 2, y: f.fy + 2, inXquiX: f.inXquiX };
  }

  /* Which Studio goal is the visible one. Decided ONLY by the coach's toggle (or later by
     confident evidence) — never by cap colour: a red cap says "goalkeeper", not whose.
     attackingAtVisibleGoal: 'light' | 'dark'. Studio: White attacks the left goal (Blue's). */
  function visibleGoalFor(attackingAtVisibleGoal) {
    if (attackingAtVisibleGoal === 'light') return 'left';
    if (attackingAtVisibleGoal === 'dark') return 'right';
    return null;
  }

  /* A Studio formation record (the shape Library -> Import accepts, STUDIO-IMPORT-FORMAT.md)
     from the CALCULATED positions. For visual verification only.
     - Identity unknown: labels carry no digits, so capText() draws no cap number
       (it shows the label letters instead — a production limit, not solved in Phase B);
       every player carries capNumber:null in videoAnalysis.players.
     - Players outside a 25 x 20 field from the visible goal are left out and listed.
     - No ball is invented: without a marked ball the ball layer is switched off. */
  function toStudioFormation(result, opts) {
    opts = opts || {};
    /* ORIENTATION (MIZE, 2026-09-24): the board must replicate the video exactly — the same end of the
       pool, the same way round, and the teams in their own cap colours. So the visible goal is the Studio
       goal on the side where it appears in the image, and light caps are always Studio's white, dark caps
       always blue, whichever team attacks. (An earlier version recoloured teams by role; MIZE: "a no go".)
       Known production limit: some Studio tools assume White attacks the left goal (smart goalie
       positioning, the goalie D-pad's lateral pass, goalPointFor); when the video's attack runs the other
       way those tools point the wrong way until Studio stores an attack direction per scene (Phase E).
       opts.orientation 'by-colour' is the older rotate-to-convention behaviour. */
    const hand = handedness(result.H);
    const goalSide = hand === 1 ? 'left' : 'right';
    const byConvention = opts.orientation === 'by-colour';
    const vg = byConvention ? visibleGoalFor(opts.attackingAtVisibleGoal) : (opts.attackingAtVisibleGoal ? goalSide : null);
    const studioColour = t => (t === 'light' ? 'white' : 'blue');
    if (!vg) return { error: 'set which team attacks the visible goal (Light attacks / Dark attacks) — it is not inferred' };
    const seq = { W: 0, B: 0 }, letters = 'abcdefghijklmnopqrstuvwxyz';
    const players = [], excluded = [];
    for (const r of result.players || []) {
      if (r.team !== 'light' && r.team !== 'dark') { excluded.push({ id: r.id, reason: 'team unknown' }); continue; }
      const b = toBoard(r.calc.X, r.calc.Y, vg, hand);
      if (!b.inXquiX) { excluded.push({ id: r.id, reason: 'outside the 25 x 20 XquiX field (true position kept in the data)' }); continue; }
      const side = studioColour(r.team) === 'white' ? 'W' : 'B';
      const gk = r.role === 'goalkeeper';
      // 'WGK'/'BGK', not 'WG'/'BG': capText() maps exactly 'WG'/'BG' to cap 1, which would be
      // an invented number. The leading W/B still tells Studio whose goalkeeper it is.
      // Identity is unknown, so the cap must stay blank. capText() draws the label itself when it holds no
      // digit, so field players get labels made only of zero-width spaces (unique by count, invisible).
      // A goalkeeper's label must start with W/B (Studio reads the goalie's side from label[0]), so the
      // goalkeeper keeps that single team letter on the cap — the one visible mark, and not a number.
      const ZW = '\u200b';
      let label;
      if (gk) { const k = side + 'g'; seq[k] = (seq[k] || 0) + 1; label = side + ZW.repeat(seq[k]); }
      else { seq.zw = (seq.zw || 0) + 1; label = ZW.repeat(seq.zw + 10); }
      // Field players face the visible goal; goalkeepers face out into the field. 90 = east, 270 = west.
      const towardGoal = vg === 'left' ? 270 : 90, outward = vg === 'left' ? 90 : 270;
      players.push({
        label, team: gk ? 'goalie' : studioColour(r.team), name: label, role: gk ? 'Goalkeeper' : 'Driver',
        x: +b.x.toFixed(3), y: +b.y.toFixed(3), pose: 'v', rot: gk ? outward : towardGoal,
        locked: false, hidden: false, blockArm: 'none', blockArmSaved: 'right', blockMaxAngle: 15, category: '',
        sizePercent: 100, visionDistance: 5, secondaryVisionAngle: 0, showPrimaryVision: false, showSecondaryVision: false
      });
    }
    let ball = { x: 14.5, y: 12, carrier: null, hand: 'right' }, ballShown = false;
    if (result.ball && result.ball.calc) {
      const b = toBoard(result.ball.calc.X, result.ball.calc.Y, vg, hand);
      if (b.inXquiX) { ball = { x: +b.x.toFixed(3), y: +b.y.toFixed(3), carrier: null, hand: 'right' }; ballShown = true; }
    }
    const name = opts.name || 'Video geometry test';
    return {
      record: {
        schemaVersion: 1, applicationVersion: '1.0.0', type: 'formation', name, coachingDNA: ['video-analysis-phase-b'],
        savedAt: opts.savedAt || new Date().toISOString(),
        state: { players, ball, extraBalls: [], drawings: [],
                 layers: { players: true, ball: ballShown, drawings: true, highlights: true, notes: true, ghosts: true } },
        videoAnalysis: { phase: 'B', orientation: byConvention ? 'by-colour' : 'as-video', visibleGoal: vg, handedness: hand, attacking: opts.attackingAtVisibleGoal, studioColours: { light: studioColour('light'), dark: studioColour('dark') }, spec: result.spec,
                         players: (result.players || []).map(r => ({ id: r.id, team: r.team, side: r.team === opts.attackingAtVisibleGoal ? 'offence' : (r.team === 'unknown' ? 'unknown' : 'defence'), role: r.role, capNumber: null, sourceField: r.calc })) }
      },
      excluded
    };
  }

  // Reference presets for a standard layout, source-field metres. The harness offers these
  // as named choices; the pool's actual marker distances come from MIZE, not from here.
  function presets(spec) {
    spec = Object.assign({}, DEFAULT_SPEC, spec || {});
    const hw = spec.width / 2, g = spec.goalWidth / 2, out = [];
    out.push({ key: 'postNear', label: 'Goal post base — near side', X: 0, Y: -g });
    out.push({ key: 'postFar', label: 'Goal post base — far side', X: 0, Y: g });
    for (const [side, s] of [['near', -1], ['far', 1]]) {
      out.push({ key: 'gl_' + side, label: 'Goal line × ' + side + ' sideline', X: 0, Y: s * hw });
      for (const d of [2, 5, 6]) out.push({ key: d + '_' + side, label: d + ' m × ' + side + ' sideline', X: d, Y: s * hw });
      out.push({ key: 'half_' + side, label: 'Half line × ' + side + ' sideline', X: spec.length / 2, Y: s * hw });
    }
    return out;
  }

  /* Who attacks? In a set play each attacker is marked by a defender sitting between him and the goal.
     For every close light/dark pair (≤ 2.5 m) the player nearer the goal votes for his team as the
     defence. Measured on Tests 1, 3, 4, 5, 7: 5/5 correct; decided only when the vote margin is ≥ 0.3
     (Test 3, a 6-on-5, is too close to call and falls back to the coach's toggle). */
  function inferAttacking(result, minMargin) {
    const P = (result.players || []).filter(p => p.role !== 'goalkeeper' && (p.team === 'light' || p.team === 'dark'))
      .map(p => ({ id: p.id, team: p.team, X: p.calc.X, Y: p.calc.Y, d: Math.hypot(p.calc.X, p.calc.Y) }));
    const votes = { light: 0, dark: 0 }, seen = new Set();
    for (const a of P) {
      const o = P.filter(b => b.team !== a.team).map(b => ({ b, dist: Math.hypot(a.X - b.X, a.Y - b.Y) })).sort((x, y) => x.dist - y.dist)[0];
      if (!o || o.dist > 2.5) continue;
      const k = [a.id, o.b.id].sort().join('|'); if (seen.has(k)) continue; seen.add(k);
      votes[(a.d < o.b.d ? a : o.b).team]++;
    }
    const n = votes.light + votes.dark, margin = n ? Math.abs(votes.light - votes.dark) / n : 0;
    const defence = votes.light > votes.dark ? 'light' : votes.dark > votes.light ? 'dark' : null;
    const attacking = defence && margin >= (minMargin ?? 0.3) ? (defence === 'light' ? 'dark' : 'light') : null;
    return { attacking, votes, margin, pairs: seen.size };
  }

  return { DEFAULT_SPEC, handedness, inferAttacking, stats, fit, evaluate, noiseStudy, toXquiXField, toBoard, visibleGoalFor, toStudioFormation, presets, generalPosition };
});
