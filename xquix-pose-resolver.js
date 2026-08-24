/* =====================================================================
 * XquiX Studio — pose resolver
 * ---------------------------------------------------------------------
 * Chooses each player's pose automatically from what is already true on the
 * board, and hands the resulting joint angles to the player rig.
 *
 * Dependency surface, mirroring xquix-game-tracker.js:
 *   1. this file, after xquix-player-rig.js
 *   2. window.MIZE.PlayerRig  — setAngles() is the only thing it calls
 *   3. the Studio's own globals, all read-only and all guarded:
 *      ballCarrier, playerSide, computeShotBlockCorridor, nearestPlayerToBall,
 *      #arrowsGroup
 * No Studio source changes are required. It writes nothing except each
 * player's joint angles, and stop() puts every one of them back to rest.
 *
 * WHY AUTOMATIC
 * With seven players a side across many frames, assigning a pose by hand
 * everywhere is more clicking than anyone will do. So poses are chosen by
 * default and overridden only where a specific look is wanted: set
 * el.dataset.poseId and that pose wins over everything below.
 *
 * WHAT IT READS
 * Five of the seven triggers map onto state the Studio already keeps. Two do
 * not — the board has no shot or pass *event*; a shot is a red arrow the coach
 * draws and a pass moves the ball instantly. Those two therefore read the
 * arrows: a player is shooting if a shot arrow starts at them in this frame.
 * That was a deliberate choice over inferring it from the ball, because it
 * leaves the coach in control of when it fires rather than guessing.
 * ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------- library */

  // The pose tool's seeded set, bundled so the module does something the
  // moment it loads. These angles are plausible guesses, not coached
  // positions — replace the whole thing with setLibrary(exportedJson).
  const SEED = {
    format: 'mize-pose-library', version: 1,
    triggerOrder: ['shooting', 'passing', 'hasBall', 'blocking', 'swimming', 'guarding', 'idle'],
    poses: [
      { id: 'p1',  name: 'Tread — rest',         body: 'v', trigger: 'idle',     angles: {} },
      { id: 'p2',  name: 'Tread — arms forward', body: 'v', trigger: 'guarding', angles: { shoulder_L: -38, shoulder_R: 38, elbow_L: 18, elbow_R: -18 } },
      { id: 'p3',  name: 'Tread — block high',   body: 'v', trigger: 'blocking', angles: { shoulder_L: 26, shoulder_R: -26, elbow_L: -30, elbow_R: 30 } },
      { id: 'p4',  name: 'Tread — ball hand up', body: 'v', trigger: 'hasBall',  angles: { shoulder_R: 52, elbow_R: -46 } },
      { id: 'p5',  name: 'Swim — glide',         body: 'h', trigger: '',         angles: {} },
      { id: 'p6',  name: 'Swim — catch',         body: 'h', trigger: '',         angles: { shoulder_L: -30, elbow_L: 16, shoulder_R: 22, elbow_R: -12, hip_L: -16, knee_L: 26, hip_R: 14, knee_R: -20 } },
      { id: 'p7',  name: 'Swim — pull',          body: 'h', trigger: '',         angles: { shoulder_L: -56, elbow_L: 38, shoulder_R: 34, elbow_R: -20, hip_L: 16, knee_L: -22, hip_R: -14, knee_R: 24 } },
      { id: 'p8',  name: 'Swim — recovery',      body: 'h', trigger: '',         angles: { shoulder_L: 24, elbow_L: -28, shoulder_R: -34, elbow_R: 20, hip_L: -14, knee_L: 22, hip_R: 16, knee_R: -24 } },
      { id: 'p9',  name: 'Shot — wind up',       body: 'h', trigger: 'shooting', angles: { shoulder_R: 46, elbow_R: -58 } },
      { id: 'p10', name: 'Shot — release',       body: 'h', trigger: '',         angles: { shoulder_R: -30, elbow_R: 12 } },
      { id: 'p11', name: 'Reach — catch pass',   body: 'h', trigger: 'passing',  angles: { shoulder_L: -24, shoulder_R: 24, elbow_L: 20, elbow_R: -20 } },
      { id: 'p12', name: 'Eggbeater',            body: 'v', trigger: '',         angles: { shoulder_L: -14, shoulder_R: 14 } }
    ],
    cycles: [
      { id: 'c1', name: 'Freestyle stroke', body: 'h', trigger: 'swimming', stepMs: 420, poses: ['p6', 'p7', 'p8', 'p5'] }
    ]
  };

  let LIB = SEED;
  let byId = {}, byTrigger = {};

  // Most specific first, so shooting beats hasBall — a shooter is also a
  // carrier, and the more particular thing is what should show.
  const ORDER = ['shooting', 'passing', 'hasBall', 'blocking', 'swimming', 'guarding', 'idle'];

  /* --------------------------------------------------------- handedness */

  // Nearly every pose worth authoring exists twice — the same shot, block or
  // carry with the other arm. Keying a slot on trigger+body alone therefore
  // throws half a library away: the two variants collide and one silently wins.
  //
  // The board already knows which arm to use. `ballHand` is a saved global and
  // `dataset.blockArm` is a saved per-player field, so the discriminator is
  // free — nothing new has to be tracked or stored.
  //
  // A pose declares its arm as `hand: 'L' | 'R'`. Libraries authored before that
  // field existed get it read off the name instead, which is why the naming
  // convention "<something> - left arm" is load-bearing rather than cosmetic.
  const HAND_SUFFIX = /[-–—]\s*(left|right)\s*(arm|hand|side)?\s*$/i;

  function handOf(ref) {
    const h = (ref.hand || '').toString().trim().toUpperCase();
    if (h === 'L' || h === 'LEFT')  return 'L';
    if (h === 'R' || h === 'RIGHT') return 'R';
    // A pose that declares a limb focus has already answered this: a left-legged
    // kick has a side, but no bearing on which hand holds the ball, and reading
    // its name would bind it to the wrong thing.
    if (ref.focus && ref.focus !== 'arm') return null;
    const m = HAND_SUFFIX.exec(ref.name || '');
    return m ? (m[1].toLowerCase() === 'left' ? 'L' : 'R') : null;   // null = either arm
  }

  // Which arm this player is using, for the trigger that matched. Anything
  // ball-related follows the ball; blocking follows the assigned blocking arm.
  // Everything else is two-armed and asks for nothing.
  function handFor(el, trigger) {
    if (trigger === 'shooting' || trigger === 'passing' || trigger === 'hasBall') {
      if (typeof ballHand === 'undefined') return null;
      return ballHand === 'left' ? 'L' : 'R';
    }
    if (trigger === 'blocking') {
      const a = el.dataset.blockArm;
      const b = (a && a !== 'none') ? a : el.dataset.blockArmSaved;
      if (b === 'left')  return 'L';
      if (b === 'right') return 'R';
    }
    return null;
  }

  function indexLibrary() {
    byId = {}; byTrigger = {};
    // A slot now holds every candidate rather than the last one written, so
    // that handedness has something to choose between.
    const put = (t, body, entry) => {
      if (!t) return;                       // no trigger = manual only
      const slot = (byTrigger[t] || (byTrigger[t] = {}));
      (slot[body] || (slot[body] = [])).push(entry);
    };
    const add = (ref, kind) => {
      byId[ref.id] = ref;
      put(ref.trigger, ref.body, { kind, ref, hand: handOf(ref) });
    };
    for (const p of (LIB.poses  || [])) add(p, 'pose');
    // A cycle whose own name says nothing inherits the arm of its frames: a
    // wind-up and release built entirely from right-arm poses is a right-arm
    // motion whether or not anyone typed that in the name. Frames that disagree
    // mean a two-armed motion — a freestyle stroke — so it stays either-arm.
    for (const c of (LIB.cycles || [])) {
      add(c, 'cycle');
      const e = ((byTrigger[c.trigger] || {})[c.body] || []).slice(-1)[0];
      if (e && !e.hand) {
        const hs = (c.poses || []).map(id => byId[id] && handOf(byId[id])).filter(Boolean);
        if (hs.length === (c.poses || []).length && new Set(hs).size === 1) e.hand = hs[0];
      }
    }
  }
  indexLibrary();

  // Pick one candidate out of a slot.
  //   1. the arm the board asked for beats an either-arm pose beats the wrong arm
  //   2. within that, a cycle beats a still pose — a repeating motion is the
  //      more useful answer for anything that is genuinely moving
  //   3. within that, the first authored wins, so the order in the file is a
  //      decision the coach can make rather than an accident of edit history
  function pick(trigger, body, hand) {
    const list = (byTrigger[trigger] || {})[body];
    if (!list || !list.length) return null;
    let best = null, bestScore = -1;
    for (const e of list) {
      const armed = (hand && e.hand === hand) ? 2 : (e.hand ? 0 : 1);
      const score = armed * 2 + (e.kind === 'cycle' ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  /* -------------------------------------------------------- board probes */

  const ARROW_START_M = 1.30;   // how close an arrow's tail must be to count as this player's
  const GUARD_M       = 2.00;   // the Studio's own marking radius (maybeAutoFace)

  const num = v => { const n = +v; return isFinite(n) ? n : 0; };
  const at = el => ({ x: num(el.dataset.x), y: num(el.dataset.y) });

  function sideOf(el) {
    if (typeof playerSide === 'function') { try { return playerSide(el); } catch (e) {} }
    return ((el.dataset.label || '')[0] === 'W') ? 'white' : 'blue';
  }

  // A shot or pass arrow whose tail sits on this player. Arrows live in board
  // metres in #arrowsGroup, same coordinate space as dataset.x / dataset.y.
  function hasArrowFrom(el, type) {
    const g = document.getElementById('arrowsGroup');
    if (!g) return false;
    const p = at(el);
    const lines = g.querySelectorAll('line[data-type="' + type + '"]');
    for (const l of lines) {
      const dx = num(l.getAttribute('x1')) - p.x, dy = num(l.getAttribute('y1')) - p.y;
      if (dx * dx + dy * dy <= ARROW_START_M * ARROW_START_M) return true;
    }
    return false;
  }

  function isCarrier(el) {
    return (typeof ballCarrier !== 'undefined') && ballCarrier === el;
  }

  // The Studio already knows how to answer this one properly, corridor
  // geometry and all. It returns a {reason} when the player is not blocking.
  function isBlocking(el) {
    if (typeof computeShotBlockCorridor !== 'function') return false;
    let attacker = (typeof ballCarrier !== 'undefined' && ballCarrier) ? ballCarrier : null;
    if (!attacker && typeof nearestPlayerToBall === 'function') {
      try { attacker = nearestPlayerToBall(); } catch (e) {}
    }
    if (!attacker) return false;
    try { return !!(computeShotBlockCorridor(el, attacker) || {}).points; } catch (e) { return false; }
  }

  // No marking state exists in the Studio, but its smart-positioning logic
  // already treats "nearest opponent within 2 m" as marking, so that is the
  // threshold used here rather than inventing a second one.
  function isGuarding(el) {
    const me = sideOf(el), p = at(el);
    const ps = document.querySelectorAll('.player');
    for (const o of ps) {
      if (o === el || sideOf(o) === me) continue;
      const q = at(o), dx = q.x - p.x, dy = q.y - p.y;
      if (dx * dx + dy * dy <= GUARD_M * GUARD_M) return true;
    }
    return false;
  }

  // Lying flat is necessary but not sufficient. The engine calls `h` "swimming"
  // because it had one flat sprite and no way to say more, but a flat player
  // parked on the board is holding position, not stroking — which is exactly
  // the difference between a freestyle cycle and a horizontal treading kick.
  //
  // So the trigger is flat *and travelling*. Playback lerps dataset.x/y every
  // animation frame, so measuring displacement between ticks costs nothing and
  // needs no engine internals. The hold carries a swimmer across the gap
  // between two frames of a play instead of flickering back to a tread.
  //
  // setSwimMode('always') restores the old behaviour, which is the right switch
  // to reach for if a still board should show strokes.
  const SWIM_MPS = 0.35;        // a sprint is ~1.5 m/s; drift and nudges are well under this
  const SWIM_HOLD_MS = 500;
  let swimMode = 'moving';      // 'moving' | 'always'
  const motion = new WeakMap();

  function isSwimming(el, now) {
    if (el.dataset.pose !== 'h') return false;
    if (swimMode === 'always') return true;
    const p = at(el), m = motion.get(el);
    motion.set(el, { x: p.x, y: p.y, t: now, until: m ? m.until : 0 });
    if (m) {
      const dt = (now - m.t) / 1000;
      if (dt > 0.001) {
        const v = Math.hypot(p.x - m.x, p.y - m.y) / dt;
        if (v >= SWIM_MPS) { motion.get(el).until = now + SWIM_HOLD_MS; return true; }
      }
      return now < m.until;
    }
    return false;
  }

  function triggerFor(el, now) {
    if (hasArrowFrom(el, 'shot')) return 'shooting';
    if (hasArrowFrom(el, 'pass')) return 'passing';
    if (isCarrier(el))            return 'hasBall';
    if (isBlocking(el))           return 'blocking';
    if (isSwimming(el, now))      return 'swimming';
    if (isGuarding(el))           return 'guarding';
    return 'idle';
  }

  /* ------------------------------------------------------------- angles */

  const TICK_MS = 70;           // also the cycle's sub-step, see cycleAngles
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function blend(a, b, u) {
    const out = {}, ks = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of ks) out[k] = (num((a || {})[k])) * (1 - u) + (num((b || {})[k])) * u;
    return out;
  }

  // A cycle is a repeating motion, not a position: a swimmer interpolating
  // toward one frozen "swimming" pose would simply stop moving once it arrived.
  // Phase comes from the wall clock so every player on the same cycle strokes
  // together, offset by a stable per-player amount so a squad does not look
  // like a chorus line.
  // Phase is quantised to a grid of sub-steps, one per tick, and every player's
  // offset is snapped to that same grid. Left continuous, a four-pose cycle mints
  // a new set of angles every tick for every player, each of which is a fresh SVG
  // for the rig to build and cache — the cache filled and flushed on a loop and a
  // pass cost 11.7 ms. On the grid the whole cycle is a fixed 24 frames that every
  // player shares, so after one lap round it everything is a cache hit.
  function subStepsFor(step) { return Math.max(2, Math.round(step / TICK_MS)); }

  function cycleAngles(c, el, now) {
    const ids = (c.poses || []).filter(id => byId[id]);
    if (!ids.length) return {};
    if (ids.length === 1) return byId[ids[0]].angles || {};
    const step = Math.max(60, num(c.stepMs) || 420);
    const sub = subStepsFor(step);
    const total = ids.length * sub;
    // whole sub-steps only, so the set of distinct frames is finite
    const k = (Math.floor(now / (step / sub)) + phaseOffset(el, total)) % total;
    const i = Math.floor(k / sub) % ids.length;
    const j = (i + 1) % ids.length;
    return blend(byId[ids[i]].angles, byId[ids[j]].angles, ease((k % sub) / sub));
  }

  // Deterministic per player, so it does not shuffle between ticks — and landed
  // on the same grid, so a squad shares one set of frames instead of each player
  // needing their own.
  function phaseOffset(el, total) {
    const s = el.dataset.label || el.dataset.id || '';
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
    return h % total;
  }

  /* ------------------------------------------------------------ resolve */

  function resolve(el, now) {
    const body = (el.dataset.pose === 'h') ? 'h' : 'v';

    // A hand-assigned pose wins outright — that is the whole point of the
    // override. It still has to suit the body: a treading pose has no legs in
    // it and would leave a swimmer's half-posed.
    const manual = el.dataset.poseId && byId[el.dataset.poseId];
    if (manual && manual.body === body) {
      const isCycle = Array.isArray(manual.poses);
      return { trigger: 'manual', id: manual.id, name: manual.name,
               angles: isCycle ? cycleAngles(manual, el, now) : (manual.angles || {}) };
    }

    const want = triggerFor(el, now);
    const hand = handFor(el, want);
    // Fall through from the matched trigger down the order. A library with no
    // pose for, say, a swimmer holding the ball should not freeze that player
    // at rest — it should use the next thing that does fit.
    let from = ORDER.indexOf(want);
    if (from < 0) from = ORDER.length - 1;
    for (let i = from; i < ORDER.length; i++) {
      const hit = pick(ORDER[i], body, hand);
      if (!hit) continue;
      const angles = hit.kind === 'cycle' ? cycleAngles(hit.ref, el, now) : (hit.ref.angles || {});
      return { trigger: want, used: ORDER[i], hand, id: hit.ref.id, name: hit.ref.name, angles };
    }
    return { trigger: want, used: null, hand, id: null, name: null, angles: {} };
  }

  /* --------------------------------------------------------------- tick */

  let timer = null, running = false;
  const lastSig = new WeakMap();

  // Half a degree, matching the rig's own cache bucket — writing finer than it
  // can draw would just churn strings.
  function sig(r) {
    let s = (r.id || '-') + '|';
    const ks = Object.keys(r.angles).sort();
    for (const k of ks) { const v = Math.round(num(r.angles[k]) * 2) / 2; if (v) s += k + v + ';'; }
    return s;
  }

  function pass(now) {
    const Rig = window.MIZE && window.MIZE.PlayerRig;
    if (!Rig || typeof Rig.setAngles !== 'function') return 0;
    let wrote = 0;
    for (const el of document.querySelectorAll('.player')) {
      let r;
      try { r = resolve(el, now); } catch (e) { continue; }
      const s = sig(r);
      if (lastSig.get(el) === s) continue;      // nothing to redraw
      lastSig.set(el, s);
      try { Rig.setAngles(el, Object.keys(r.angles).length ? r.angles : null); wrote++; } catch (e) {}
    }
    return wrote;
  }

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(() => { try { pass(performance.now()); } catch (e) {} }, TICK_MS);
    pass(performance.now());
  }

  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    const Rig = window.MIZE && window.MIZE.PlayerRig;
    for (const el of document.querySelectorAll('.player')) {
      lastSig.delete(el);
      if (Rig && Rig.setAngles) { try { Rig.setAngles(el, null); } catch (e) {} }
    }
  }

  /* ---------------------------------------------------------------- API */

  const API = {
    _booted: false,
    get running() { return running; },
    start, stop,
    // One resolve pass right now, without waiting for the tick.
    apply() { return pass(performance.now()); },

    // Replace the bundled seed with a pose library exported from the pose tool.
    setLibrary(json) {
      const lib = (typeof json === 'string') ? JSON.parse(json) : json;
      if (!lib || !Array.isArray(lib.poses)) throw new Error('not a mize-pose-library export');
      LIB = lib; indexLibrary();
      for (const el of document.querySelectorAll('.player')) lastSig.delete(el);
      if (running) pass(performance.now());
      return API.coverage();
    },
    getLibrary() { return LIB; },

    // Which trigger/body combinations the current library can actually answer.
    // The seeded set has holes — no swimming pose for hasBall or blocking — and
    // a hole means that player falls through to a less specific pose.
    coverage() {
      const rows = [];
      for (const t of ORDER) for (const body of ['v', 'h']) {
        const handed = (t === 'shooting' || t === 'passing' || t === 'hasBall' || t === 'blocking');
        const row = { trigger: t, body, candidates: ((byTrigger[t] || {})[body] || []).length };
        if (handed) { for (const h of ['L', 'R']) { const e = pick(t, body, h); row[h] = e ? e.ref.name : null; } }
        else { const e = pick(t, body, null); row.pose = e ? e.ref.name : null; row.kind = e ? e.kind : null; }
        rows.push(row);
      }
      return rows;
    },

    // Every pose in the library that nothing on the board can ever reach —
    // either its slot is claimed by something that outranks it, or its trigger
    // is blank. A pose used only as a frame inside a cycle counts as reached.
    unreachable() {
      const seen = new Set();
      for (const t of ORDER) for (const body of ['v', 'h']) for (const h of ['L', 'R', null]) {
        const e = pick(t, body, h);
        if (!e) continue;
        seen.add(e.ref.id);
        if (e.kind === 'cycle') for (const id of (e.ref.poses || [])) seen.add(id);
      }
      return (LIB.poses || []).concat(LIB.cycles || [])
        .filter(p => !seen.has(p.id))
        .map(p => ({ id: p.id, name: p.name, body: p.body, trigger: p.trigger || '(none)' }));
    },

    // What every player on the board resolved to, and why. This is the thing to
    // look at when a pose is not what you expected.
    explain() {
      const now = performance.now();
      return [...document.querySelectorAll('.player')].map(el => {
        const r = resolve(el, now);
        return { label: el.dataset.label, team: el.dataset.team, body: el.dataset.pose,
                 trigger: r.trigger, usedTrigger: r.used || r.trigger,
                 arm: r.hand || '-',
                 pose: r.name || '(none — left at rest)',
                 fellThrough: !!(r.used && r.used !== r.trigger) };
      });
    },

    // Pin one player to a pose by hand; null hands them back to the resolver.
    setManual(el, poseId) {
      if (!el || !el.dataset) return;
      if (poseId) el.dataset.poseId = poseId; else delete el.dataset.poseId;
      lastSig.delete(el);
      if (running) pass(performance.now());
    },
    getManual(el) { return (el && el.dataset && el.dataset.poseId) || null; },

    triggerOf(el) { return triggerFor(el, performance.now()); },

    // 'moving' (default): a flat player strokes only while actually travelling,
    // so a flat player holding station gets a treading pose instead.
    // 'always': any flat player strokes, as the sprite set used to imply.
    setSwimMode(m) { swimMode = (m === 'always') ? 'always' : 'moving'; return swimMode; },
    getSwimMode() { return swimMode; }
  };

  function boot() {
    if (!window.MIZE) return;
    if (window.MIZE.PoseResolver && window.MIZE.PoseResolver._booted) return;
    window.MIZE.PoseResolver = API;
    API._booted = true;
    if (window.MIZE.PlayerRig) start();
  }

  if (window.MIZE) window.MIZE.PoseResolver = API;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
