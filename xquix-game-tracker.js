/* ============================================================================
 * XquiX Game Tracker — beta module
 * ----------------------------------------------------------------------------
 * Drop-in add-on for XquiX Studio. Integration contract, in full:
 *
 *   1. <script src="xquix-game-tracker.js"></script>  after the Studio scripts
 *   2. window.MIZE           — already exported by Studio
 *   3. #board, #stageWrap, #fieldZonesSvg, #fieldZonesGroup — existing DOM ids
 *
 * That is the whole dependency surface. No Studio source changes are required.
 *
 * Isolation: while tracking, a full-screen shield swallows every pointer event
 * before it reaches Studio, so no Studio tool can fire. Board taps are resolved
 * from client coordinates against #fieldZonesSvg's own viewBox and #fieldZones-
 * Group's own transform, which means Front Court, Presentation shift and any
 * future view mode are handled automatically without reading Studio internals.
 *
 * Zone geometry is Studio's "Offense" set (standardCircle), reproduced exactly:
 *   goal anchor (M.fieldX, 12) · centre r<=4 · zones 1-5 in 36 deg wedges r 4-9
 * plus the new outer zones 12/13/14, which extend the same +/-18 deg rays past
 * the 9 m arc to the halfway line.
 * ==========================================================================*/
(function () {
'use strict';

/* ---------------------------------------------------------------- constants */
var KEY = 'xquixGameTrackerV1';
var QLEN = 8 * 60;

/* Studio geometry, board space (metres, viewBox 0 0 29 24) */
var GEO = {
  goal:   { x: 2, y: 12 },   // left goal — the end Front Court crops to
  innerR: 4,                 // centre / hole set
  outerR: 9,                 // perimeter arc
  half:   { x0: 2, x1: 14.5, y0: 2, y1: 22 }   // attacking half of the field
};

/* phi = 0 points into the field; +phi rotates toward the goalkeeper's left,
   matching Studio's own fieldZonePolarPt() sign convention. */
var ZONES = [
  { id: 'z6',  n: 6,  name: 'Centre',           r1: 0, r2: 4,  a1: -90, a2:  90 },
  { id: 'z1',  n: 1,  name: 'Left Wing',        r1: 4, r2: 9,  a1: -90, a2: -54 },
  { id: 'z2',  n: 2,  name: 'Left Shooter',     r1: 4, r2: 9,  a1: -54, a2: -18 },
  { id: 'z3',  n: 3,  name: 'Central Shooter',  r1: 4, r2: 9,  a1: -18, a2:  18 },
  { id: 'z4',  n: 4,  name: 'Right Shooter',    r1: 4, r2: 9,  a1:  18, a2:  54 },
  { id: 'z5',  n: 5,  name: 'Right Wing',       r1: 4, r2: 9,  a1:  54, a2:  90 },
  { id: 'z12', n: 12, name: 'Left Back',        r1: 9, r2: 30, a1: -90, a2: -18, outer: true },
  { id: 'z13', n: 13, name: 'Mid Back',         r1: 9, r2: 30, a1: -18, a2:  18, outer: true },
  { id: 'z14', n: 14, name: 'Right Back',       r1: 9, r2: 30, a1:  18, a2:  90, outer: true },
  // Not part of the polar system at all -- represents "somewhere in the
  // far, unrendered half of the pool" rather than a specific position,
  // so it deliberately carries no r1/r2/a1/a2 (openZone()/zoneNum() never
  // read those; only hitZone()'s polar loop does, and OPPO is matched by
  // its own dedicated check there instead, before that loop even runs).
  { id: 'oppo', n: 'OPPO', name: 'Opposite Half' }
];
function zoneById(id) { for (var i = 0; i < ZONES.length; i++) if (ZONES[i].id === id) return ZONES[i]; return null; }

/* Per-device zone number customization -- any coach/parent can reassign
   which number displays at each geometric zone position, without needing
   admin authorization or team-wide coordination (confirmed: this is
   deliberately personal/local, not a database-backed team setting). */
var ZONE_NUM_KEY = 'xgtZoneNumbersV1';
function loadZoneNumberOverrides() { try { return JSON.parse(localStorage.getItem(ZONE_NUM_KEY) || '{}'); } catch (err) { return {}; } }
function saveZoneNumberOverrides() { try { localStorage.setItem(ZONE_NUM_KEY, JSON.stringify(S.zoneNumberOverrides)); } catch (err) {} }
/* The single point every display/storage site should read through --
   swapping z.n for this everywhere it was used keeps the override
   entirely transparent to the rest of the module. */
function zoneNum(z) { return (S.zoneNumberOverrides && S.zoneNumberOverrides[z.id] != null) ? S.zoneNumberOverrides[z.id] : z.n; }
function promptZoneNumberEdit(zoneId) {
  var z = zoneById(zoneId);
  if (!z) return;
  var current = zoneNum(z);
  // window.prompt matches this module's own existing precedent
  // (window.alert already appears in API.open) rather than introducing
  // MizeDialog, which this self-contained module never otherwise uses.
  var input = window.prompt('New number for this zone (currently ' + current + '):', String(current));
  if (input === null) return; // cancelled
  var n = parseInt(input, 10);
  if (isNaN(n) || String(n) !== input.trim()) { window.alert('Enter a whole number.'); return; }
  var conflict = ZONES.some(function (other) { return other.id !== zoneId && zoneNum(other) === n; });
  if (conflict) { window.alert('Zone ' + n + ' is already in use by another zone. Pick a different number.'); return; }
  S.zoneNumberOverrides[zoneId] = n;
  saveZoneNumberOverrides();
  drawOverlay(null);
}

/* ------------------------------------------------------------ action trees */
/* Deliberately separate structures. Neither may leak into the other. */
var FIELD_PLAYER_ACTIONS = [
  { id: 'shot', label: 'Shot', cls: 'b', children: [
    { id: 'goal',    label: 'Goal',         cls: 'g', placement: 'in',   scores: 'us' },
    { id: 'blocked', label: 'Blocked Shot', cls: 'w', placement: 'in' },
    { id: 'missed',  label: 'Missed Shot',  cls: 's', placement: 'miss' }
  ]},
  { id: 'exclusion', label: 'Personal Foul', cls: 'w', dc: true, children: [
    { id: 'penalty',   label: 'Penalty (5 m)',        cls: 'c' },
    { id: 'exclusion', label: 'Exclusion (20 s)',     cls: 'w' },
    { id: 'excl_sub',  label: 'Excl. + Substitution', cls: 'w' },
    { id: 'brutality', label: 'Brutality',            cls: 'c' }
  ]},
  { id: 'turnover', label: 'Turnover', cls: 'c', children: [
    { id: 'off_foul',      label: 'Offensive Foul',      cls: 'c' },
    { id: 'off_exclusion', label: 'Offensive Exclusion', cls: 'c' },
    { id: 'intercepted',   label: 'Pass Intercepted',    cls: 'c' },
    { id: 'shotclock',     label: 'Shot Clock Expired',  cls: 'c' }
  ]},
  { id: 'steal', label: 'Steal', cls: 'g', terminal: true }
];
/* Shared so a keeper's exclusion/turnover options stay identical to a field
   player's — the coach asked for exactly that. */
function sharedChild(actionId) {
  for (var i = 0; i < FIELD_PLAYER_ACTIONS.length; i++) {
    if (FIELD_PLAYER_ACTIONS[i].id === actionId) return FIELD_PLAYER_ACTIONS[i].children;
  }
  return [];
}

/* For a keeper the field tap means WHERE THE OPPONENT'S ACTION CAME FROM.
   A shot carries a type (regular / skip / lob / penalty) before its outcome,
   so `variants` inserts one extra step between action and outcome. */
var GOALKEEPER_ACTIONS = [
  { id: 'shot', label: 'Shot', cls: 'b',
    variants: [
      { id: 'regular', label: 'Regular',       cls: 'b' },
      { id: 'skip',    label: 'Skip Shot',     cls: 'b' },
      { id: 'lob',     label: 'Lob',           cls: 'b' },
      { id: 'penalty', label: 'Penalty (5 m)', cls: 'c' }
    ],
    children: [
      { id: 'blocked',   label: 'Blocked / Save', cls: 'g', placement: 'in' },
      { id: 'goal',      label: 'Goal',           cls: 'c', placement: 'in', scores: 'opp' },
      /* off target still matters: keeper positioning is part of why it went wide */
      { id: 'missed',    label: 'Missed',         cls: 's', placement: 'miss' },
      { id: 'def_block', label: 'Defender Block', cls: 'w', sub: 'stopped by our field player' }
    ]},
  { id: 'steal',     label: 'Steal',     cls: 'g', terminal: true },
  { id: 'exclusion', label: 'Personal Foul', cls: 'w', dc: true, children: sharedChild('exclusion') },
  { id: 'turnover',  label: 'Turnover',  cls: 'c', children: sharedChild('turnover') },
  { id: 'outlet', label: 'Outlet Pass', cls: 'b', children: [
    { id: 'completed', label: 'Completed', cls: 'g' },
    { id: 'turnover',  label: 'Turnover',  cls: 'c' }
  ]}
];
// Free tier: shot / personal foul (exclusion) / steal only, with shot and
// exclusion each trimmed to a specific outcome subset -- turnover (and,
// for goalkeepers, outlet) are excluded entirely. Built as filtered
// COPIES of the real trees below, never mutating FIELD_PLAYER_ACTIONS/
// GOALKEEPER_ACTIONS themselves, since other code (sharedChild, treeFor,
// stats computation checking e.action IDs) depends on those staying
// exactly as built regardless of which tier is viewing them live.
var FREE_TIER_ALLOWED_OUTCOMES = { shot: ['goal', 'blocked', 'missed'], exclusion: ['penalty', 'exclusion'] };
function freeTierActions(full) {
  return full.filter(function (a) { return a.id === 'steal' || FREE_TIER_ALLOWED_OUTCOMES.hasOwnProperty(a.id); })
    .map(function (a) {
      if (a.id === 'steal') return a; // already terminal (no children), nothing to trim
      var out = Object.assign({}, a);
      // Goalkeeper's shot has a regular/skip/lob/penalty variant step the
      // confirmed free-tier spec never mentioned at all -- dropping it
      // entirely (not just trimming its options) keeps the free flow to
      // the same number of steps as the field-player version.
      if (a.variants) out.variants = null;
      var keep = FREE_TIER_ALLOWED_OUTCOMES[a.id];
      out.children = a.children.filter(function (c) { return keep.indexOf(c.id) >= 0; });
      return out;
    });
}
// Fails open (full access) if the entitlements system isn't available for
// any reason -- matches the fail-open default used everywhere else this
// module checks a gate, so a misconfigured or not-yet-loaded check can
// never accidentally lock a paid coach out of their own action tree.
function xgtHasAdvancedActions() {
  return typeof XQUIX === 'undefined' || !XQUIX.Entitlements || typeof XQUIX.Entitlements.canFunction !== 'function'
    || XQUIX.Entitlements.canFunction('Advanced Tracking Actions');
}
function tree() {
  var full = (S.draft && S.draft.useGkTree) ? GOALKEEPER_ACTIONS : (S.playerRole === 'goalkeeper' ? GOALKEEPER_ACTIONS : FIELD_PLAYER_ACTIONS);
  return xgtHasAdvancedActions() ? full : freeTierActions(full);
}
function treeFor(ev) {
  return (ev.context && ev.context.tree === 'gk') ? GOALKEEPER_ACTIONS : FIELD_PLAYER_ACTIONS;
}
// Coach+team is the only mode with a real squad -- everything else
// (parent's own modes, and now coach+field/coach+goalkeeper too) means
// "track one specific player." Introduced when fixing the setup UI's
// backwards mapping (field player used to mean squad tracking, team used
// to mean nothing at all); this is the single shared definition every
// check below uses, rather than each one re-deriving it slightly
// differently and risking drift.
function singlePlayerMode() { return !(S.trackingMode === 'coach' && S.playerRole === 'team'); }
/* Coach mode: whoever of the designated keepers is currently in the water. */
// side-parameterized so bidirectional (team-mode) tracking can ask
// "who's currently between the posts for the OTHER side" just as easily
// as for our own -- defaults to 'us' so the one pre-existing caller (now
// rewritten anyway) and any future single-player-mode callers keep
// working without needing to pass anything.
function currentKeeper(side) {
  var water = side === 'opp' ? S.oppWater : S.water;
  var keepers = side === 'opp' ? S.oppKeepers : S.keepers;
  for (var i = 0; i < water.length; i++) if (keepers.indexOf(water[i]) >= 0) return water[i];
  return keepers.length ? keepers[0] : null;
}
// Phase F: pure display lookup -- S.keepers/currentKeeper() above are
// completely untouched by this, so sorting/indexOf/water-init logic that
// already depends on keeper numbers being real numbers keeps working
// exactly as before. Only what gets SHOWN on screen changes.
function xgtKeeperLabel(n) { return (S.keeperLabels && S.keeperLabels[n]) || n; }
// This side's real team name if one's been entered, otherwise a
// generic fallback -- used at every button/label anywhere in the
// tracker that refers to "my team" or "the opponent", so a coach who's
// entered real names sees them everywhere instead of just on the
// scoreboard. `style` picks the fallback that actually fits the
// grammar it's being dropped into: 'short' for a standalone label
// ("Us"/"Them"), 'possessive' for mid-sentence use ("Our"/"Their"),
// 'full' for a fallback meant to stand alone as a button/heading on
// its own ("My Team"/"Opponent"). Defaults to 'short'.
function xgtTeamLabel(side, style) {
  var name = side === 'us' ? S.game.home : S.game.away;
  if (name) return name;
  if (style === 'possessive') return side === 'us' ? 'Our' : 'Their';
  if (style === 'full') return side === 'us' ? 'My Team' : 'Opponent';
  return side === 'us' ? 'Us' : 'Them';
}

/* --------------------------------------------------------- goal placement */
var GOALG = { frame: { x: 130, y: 96, w: 340, h: 110 }, mouth: { x: 150, y: 116, w: 300, h: 90 }, waterY: 206 };
// Rebuilt to a realistic ratio -- a real water polo goal is 3.0m wide x
// 0.9m high (3.33:1), and the previous mouth (224x92, 2.43:1) was
// noticeably too tall/narrow relative to that. Scale here is 100 SVG
// units per meter, so these numbers read directly as meters x100: mouth
// 300x90 = 3.0m x 0.9m. Posts/crossbar are 20 units (0.2m) uniformly --
// the real posts are 0.1m, but 0.2m was the explicitly agreed
// tap-friendliness compromise, applied to the crossbar too rather than
// just the posts, since the previous version had non-uniform thickness
// (50-unit posts vs a 38-unit crossbar) that didn't match a real frame's
// uniform construction either.
var IN_TARGETS = (function () {
  var m = GOALG.mouth, cw = m.w / 3, ch = m.h / 3, out = [];
  [['Top', 0], ['Middle', 1], ['Low', 2]].forEach(function (r) {
    ['Left', 'Center', 'Right'].forEach(function (c, ci) {
      out.push({ id: (r[0] + '_' + c).toLowerCase(), label: r[0] + ' ' + c,
                 svg: (r[0] + ' ' + c).toUpperCase(), sm: true,
                 x: m.x + ci * cw, y: m.y + r[1] * ch, w: cw, h: ch });
    });
  });
  return out;
})();
var MISS_TARGETS = [
  { id: 'high_left',  label: 'High left',   svg: 'HIGH LEFT',     x: 30,  y: 6,   w: 100, h: 90 },
  { id: 'over',       label: 'Over the bar',svg: 'OVER THE BAR',  x: 130, y: 6,   w: 340, h: 90 },
  { id: 'high_right', label: 'High right',  svg: 'HIGH RIGHT',    x: 470, y: 6,   w: 100, h: 90 },
  { id: 'wide_left',  label: 'Wide left',   svg: 'WIDE LEFT',     x: 30,  y: 96,  w: 100, h: 110 },
  { id: 'wide_right', label: 'Wide right',  svg: 'WIDE RIGHT',    x: 470, y: 96,  w: 100, h: 110 },
  { id: 'post_left',  label: 'Left post',   svg: 'POST', x: 130, y: 96, w: 20, h: 110, frame: true, sm: true, rot: true },
  { id: 'crossbar',   label: 'Crossbar',    svg: 'CROSSBAR',      x: 150, y: 96,  w: 300, h: 20, frame: true },
  { id: 'post_right', label: 'Right post',  svg: 'POST', x: 450, y: 96, w: 20, h: 110, frame: true, sm: true, rot: true },
  { id: 'short',      label: 'Short, into the water', svg: 'SHORT — INTO THE WATER', x: 30, y: 218, w: 540, h: 70 },
  /* On target for the cage, stopped on the way by an opposing FIELD player —
     not the keeper. Sits inside the frame because that is where the ball was
     headed; the block is why it never arrived. */
  { id: 'blocked_field', label: 'Blocked by field player', svg: ['BLOCKED BY', 'FIELD PLAYER'],
    block: true, x: GOALG.mouth.x, y: GOALG.mouth.y, w: GOALG.mouth.w, h: GOALG.mouth.h }
];

/* -------------------------------------------------------------------- state */
var S = {
  active: false,
  trackingMode: 'parent',      // parent | coach
  playerRole: 'field',         // field | goalkeeper | team
  game: { date: '', loc: '', home: '', away: '' },
  me: { number: null, name: '' },
  squad: [], water: [], keepers: [],
  editingZoneNumbers: false,   // true while the tap-to-relabel flow (zoneNum below) is active; intercepts the normal zone-tap-opens-action-sheet behavior
  cloudSessionName: null,      // stable per-session name used as the upsert key for cloud sync (Phase A) -- generated once in go(), preserved across resume, cleared on New Game
  officiallyEnded: false,      // true once regulation ends outright, a shootout is decided, or the coach manually ends the session -- distinct from just closing the tracker mid-game, which leaves this false so Resume still offers it next time
  finishPromptShown: false,    // guards the "finish and save?" prompt from firing again on every subsequent render() once the coach has already answered it once (whether they said yes or not yet)
  shieldSuspendedForToolPanel: false, // Phase B: true while #xgtShield's pointer-events are deliberately disabled so the "Sessions" button's Library panel is actually clickable underneath it
  opponentTracked: false, oppSquad: [], oppWater: [], oppKeepers: [], // Phase E: opt-in opposing-team tracking, mirrors squad/water/keepers above
  keeperLabels: {}, // Phase F: number -> optional display label (e.g. {13:'1B'}) for competitions that label backup goalies 1A/1B/1C -- deliberately a SEPARATE map, not a change to S.keepers itself, so every existing sort()/indexOf()/currentKeeper() call touching keeper numbers keeps working on real numbers untouched
  trackScore: false, // opt-in "game score" display row, shown underneath the clock rather than flanking it -- most sessions are stats-first, not scoreboard-first, per confirmed feedback. A pure live-UI display preference, not game data (scoreOf() always computes the real score regardless of this flag) -- persisted locally so a resumed session keeps the choice, but deliberately NOT part of the cloud-synced record, since saved/combined session views already always show the score in their own header regardless of this toggle
  zoneNumberOverrides: {},     // {zoneId: displayNumber} -- per-device via localStorage (loadZoneNumberOverrides), NOT team-wide or database-backed; any coach/parent can set their own, deliberately
  q: 1, clock: QLEN, running: false, tick: null,
  events: [], undone: [], seq: 0,
  draft: null, onScrim: null, zonesVisible: true,
  hadFrontCourt: false,
  // Shootout: startSide is chosen once, at the very first attempt, and
  // never changes after -- who shoots next is always derived from it
  // plus how many attempts exist so far, never tracked as its own
  // separate "whose turn" flag that could drift out of sync. Goalkeeper
  // numbers default to null (resolved to each side's primary declared
  // keeper the first time the shootout screen actually renders) and are
  // freely changeable shot to shot, since a backup keeper subbing in
  // specifically for this is real and expected.
  shootoutStartSide: null,
  shootoutGoalkeepers: { us: null, them: null },
  // Off by default -- the automatic order enforcement below (no repeat
  // shooter until all 5 have gone in round 1, then only the next player
  // in that established order selectable in round 2+) is the standard
  // behavior. This is the explicit override for events whose own rules
  // differ from the official ones, letting the coach tap any shooter
  // freely instead.
  shootoutFreeSelection: false,
  // Only populated for a side whose water roster is unknown at shootout
  // time (opponent tracking wasn't enabled) -- a one-time, tap-declared
  // stand-in for S.water/S.oppWater so the shooter grid in the shootout
  // never has to fall back to typing a cap number. Left empty when the
  // real roster is known; drawMain() prefers S.water/S.oppWater first.
  shootoutRoster: { us: [], them: [] },
  // Set once, automatically, the moment the clock reaches 0:00 during
  // Q4 (see toggleClock()) -- sticky, never auto-clears itself even if
  // the coach later edits the clock/quarter, since that's a correction
  // to the record, not a real return to live play. Field-zone tapping
  // is blocked once this is true (openZone()), but roster-based foul
  // logging deliberately stays available on both sides -- misconduct
  // penalties can genuinely happen after the buzzer, and still need a
  // real record.
  regulationEnded: false
};
function fmt(s) { return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function el(id) { return document.getElementById(id); }

/* ================================================================= geometry */
function frontCourtOn() {
  var svg = el('fieldZonesSvg');
  return !!svg && (svg.getAttribute('viewBox') || '') !== '0 0 29 24';
}
/* client px -> board metres, derived entirely from the live SVG attributes so
   every Studio view mode is handled without asking Studio anything. */
function screenToBoard(clientX, clientY) {
  var svg = el('fieldZonesSvg'), grp = el('fieldZonesGroup');
  if (!svg) return null;
  var r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  var vb = (svg.getAttribute('viewBox') || '0 0 29 24').split(/\s+/).map(Number);
  var vx = vb[0] + (clientX - r.left) / r.width * vb[2];
  var vy = vb[1] + (clientY - r.top) / r.height * vb[3];
  var t = grp ? (grp.getAttribute('transform') || '') : '';
  var m;
  if ((m = t.match(/rotate\(\s*-90\s*,\s*([-\d.]+)/))) {       // Front Court
    var c = parseFloat(m[1]);
    return { x: c - (vy - c), y: c + (vx - c) };
  }
  if ((m = t.match(/translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)/))) { // Presentation
    return { x: vx - parseFloat(m[1]), y: vy - parseFloat(m[2]) };
  }
  return { x: vx, y: vy };
}
function boardToClient(bx, by) {
  var svg = el('fieldZonesSvg'), grp = el('fieldZonesGroup');
  if (!svg) return null;
  var r = svg.getBoundingClientRect();
  var vb = (svg.getAttribute('viewBox') || '0 0 29 24').split(/\s+/).map(Number);
  var t = grp ? (grp.getAttribute('transform') || '') : '';
  var vx = bx, vy = by, m;
  if ((m = t.match(/rotate\(\s*-90\s*,\s*([-\d.]+)/))) {
    var c = parseFloat(m[1]);
    vx = c + (by - c); vy = c - (bx - c);
  } else if ((m = t.match(/translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)/))) {
    vx = bx + parseFloat(m[1]); vy = by + parseFloat(m[2]);
  }
  return { x: r.left + (vx - vb[0]) / vb[2] * r.width,
           y: r.top  + (vy - vb[1]) / vb[3] * r.height };
}
function hitZone(bx, by) {
  var H = GEO.half;
  if (bx < H.x0 || bx > H.x1 || by < H.y0 || by > H.y1) return null;
  var dx = bx - GEO.goal.x, dy = by - GEO.goal.y;
  var r = Math.sqrt(dx * dx + dy * dy);
  var phi = Math.atan2(dy, dx) * 180 / Math.PI;
  if (phi < -90 || phi > 90) return null;
  if (r <= GEO.innerR) return 'z6';
  if (r <= GEO.outerR) {
    var i = Math.floor((phi + 90) / 36);
    return ['z1', 'z2', 'z3', 'z4', 'z5'][Math.max(0, Math.min(4, i))];
  }
  return phi < -18 ? 'z12' : (phi > 18 ? 'z14' : 'z13');
}
function polar(phiDeg, r) {
  var p = phiDeg * Math.PI / 180;
  return { x: GEO.goal.x + r * Math.cos(p), y: GEO.goal.y + r * Math.sin(p) };
}
/* Same sampled-polyline construction Studio uses, so our outlines land exactly
   on top of its own when the Offense zone set is switched on. */
function wedgePath(r1, r2, a1, a2) {
  var steps = Math.max(8, Math.round(Math.abs(a2 - a1) / 4.5)), i, outer = [], inner = [];
  for (i = 0; i <= steps; i++) outer.push(polar(a1 + (a2 - a1) * i / steps, r2));
  if (r1 <= 0.0001) {
    return 'M ' + GEO.goal.x + ' ' + GEO.goal.y + ' ' + outer.map(function (p) { return 'L ' + p.x + ' ' + p.y; }).join(' ') + ' Z';
  }
  for (i = steps; i >= 0; i--) inner.push(polar(a1 + (a2 - a1) * i / steps, r1));
  return 'M ' + outer.map(function (p) { return p.x + ' ' + p.y; }).join(' L ') +
         ' L ' + inner.map(function (p) { return p.x + ' ' + p.y; }).join(' L ') + ' Z';
}
function labelPoint(z) {
  if (z.id === 'z6') return polar(0, GEO.innerR * 0.5);
  if (z.outer) {
    var mid = (z.a1 + z.a2) / 2, rr = 11.4;
    if (z.id === 'z12') { mid = -50; rr = 10.8; }
    if (z.id === 'z14') { mid = 50;  rr = 10.8; }
    return polar(mid, rr);
  }
  return polar((z.a1 + z.a2) / 2, (z.r1 + z.r2) / 2);
}

/* ------------------------------------------------------- the overlay layer */
var NS = 'http://www.w3.org/2000/svg';
function ensureOverlay() {
  var svg = el('fieldZonesSvg');
  if (!svg) return null;
  var g = el('xgtZoneLayer');
  if (g) return g;
  var defs = document.createElementNS(NS, 'defs');
  var clip = document.createElementNS(NS, 'clipPath');
  clip.setAttribute('id', 'xgtHalfClip'); clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
  var cr = document.createElementNS(NS, 'rect');
  cr.setAttribute('x', GEO.half.x0); cr.setAttribute('y', GEO.half.y0);
  cr.setAttribute('width', GEO.half.x1 - GEO.half.x0); cr.setAttribute('height', GEO.half.y1 - GEO.half.y0);
  clip.appendChild(cr); defs.appendChild(clip);
  g = document.createElementNS(NS, 'g');
  g.setAttribute('id', 'xgtZoneLayer');
  g.appendChild(defs);
  svg.appendChild(g);
  syncOverlayTransform();
  // Studio re-renders its own zone group and re-transforms it on view changes;
  // mirror whatever transform it lands on rather than recomputing it here.
  var grp = el('fieldZonesGroup');
  if (grp && window.MutationObserver) {
    new MutationObserver(syncOverlayTransform).observe(grp, { attributes: true, attributeFilter: ['transform'] });
  }
  return g;
}
function syncOverlayTransform() {
  var g = el('xgtZoneLayer'), grp = el('fieldZonesGroup');
  if (!g || !grp) return;
  var t = grp.getAttribute('transform');
  if (t) g.setAttribute('transform', t); else g.removeAttribute('transform');
}
function drawOverlay(counts) {
  var g = ensureOverlay();
  if (!g) return;
  while (g.childNodes.length > 1) g.removeChild(g.lastChild);   // keep <defs>
  var clipped = document.createElementNS(NS, 'g');
  clipped.setAttribute('clip-path', 'url(#xgtHalfClip)');
  g.appendChild(clipped);
  ZONES.forEach(function (z) {
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', wedgePath(z.r1, z.r2, z.a1, z.a2));
    path.setAttribute('class', 'xgtZone');
    path.setAttribute('data-zone', z.id);
    if (counts) {
      var n = counts.map[z.id] || 0;
      path.setAttribute('fill', n ? heat(counts.max ? n / counts.max : 0) : 'rgba(255,255,255,.05)');
      path.setAttribute('fill-opacity', '0.9');
    }
    clipped.appendChild(path);
    var lp = labelPoint(z);
    var txt = document.createElementNS(NS, 'text');
    txt.setAttribute('x', lp.x); txt.setAttribute('y', lp.y);
    txt.setAttribute('class', 'xgtZoneLabel xgtZoneNum');
    if (frontCourtOn()) txt.setAttribute('transform', 'rotate(90,' + lp.x + ',' + lp.y + ')');
    // Numbers only for now -- naming these zones (matching how Studio's
    // own field zones can already be named) is a real feature, just not
    // this one yet. A dedicated naming option later replaces this single
    // line, rather than un-hiding a second one, so there's no leftover
    // "ZONE N" scaffolding to work around when that's built.
    txt.textContent = counts ? (counts.map[z.id] || 0) : zoneNum(z);
    clipped.appendChild(txt);
  });
  g.style.display = S.zonesVisible ? '' : 'none';
}
function flashZone(id) {
  var p = document.querySelector('#xgtZoneLayer path[data-zone="' + id + '"]');
  if (!p) return;
  p.classList.add('xgtFlash');
  setTimeout(function () { p.classList.remove('xgtFlash'); }, 170);
}
function removeOverlay() { var g = el('xgtZoneLayer'); if (g) g.remove(); }

/* ============================================================ event records */
function makeEvent(partial) {
  var ev = {
    eventId: ++S.seq,
    quarter: S.q,
    gameClock: S.clock,
    gameClockText: fmt(S.clock),
    trackedPlayer: { number: S.me.number, name: S.me.name },
    playerRole: S.playerRole,
    actor: null,
    fieldZone: null,
    fieldZoneName: null,
    fieldCoordinates: null,    // {bx,by,fx,fy,nx,ny} — board & field metres
    action: null, actionLabel: null,
    variant: null, variantLabel: null,      // shot type: regular / skip / lob / penalty
    outcome: null, outcomeLabel: null,
    goalkeeper: null,                        // cap number of the keeper facing it
    targetGoal: null,                        // 'own' | 'opponent'
    goalPlacement: null,
    context: { kind: 'action', trackingMode: S.trackingMode, dc: null, note: null },
    timestamp: new Date().toISOString()
  };
  for (var k in partial) if (Object.prototype.hasOwnProperty.call(partial, k)) ev[k] = partial[k];
  return ev;
}
// e.actor.side / e.foulCounterpart.side use 'us' | 'opp' almost
// everywhere (the main tracking flow's convention), but the water
// bar's quick-tap foul button stores 'us' | 'them' instead -- this
// normalizes either down to the same 'us' | 'opp' pair, so a set built
// from events logged either way lines up correctly.
function xgtDqSide(side) { return side === 'them' ? 'opp' : side; }
// Whichever role the primary actor DIDN'T fill (per e.context.dc) is
// the counterpart's -- these two read that consistently in either
// direction, rather than re-deriving it ad hoc at each call site.
function xgtWhoCommittedFoul(e) {
  if (!e.actor) return null;
  if (e.context && e.context.dc === 'committed') return e.actor;
  if (e.context && e.context.dc === 'drawn') return e.foulCounterpart || null;
  return e.actor; // no dc recorded at all -- treat the tapped player as the one who committed it
}
function xgtWhoDrewFoul(e) {
  if (!e.actor) return null;
  if (e.context && e.context.dc === 'drawn') return e.actor;
  if (e.context && e.context.dc === 'committed') return e.foulCounterpart || null;
  return null;
}
// Derived fresh from S.events on every call -- same "nothing stored to
// drift" principle as shootoutCurrentSide(): undoing the event that
// triggered a disqualification correctly un-disqualifies the player on
// the very next render, with no separate flag to keep in sync. Takes
// an explicit events list (defaulting to the live S.events) so
// xgtCheckDisqualification below can also ask "was this already true
// BEFORE the event just committed", to fire its toast exactly once.
// Exclusion and Penalty both eject the offending player for the same
// 20s kickout -- Penalty additionally gives the other team a penalty
// shot, but the ejection itself is identical, so both accumulate
// together toward the same three-strikes count. Excl.+Substitution
// and Brutality disqualify on their own, the first time either
// happens, and are tagged with their own specific reason rather than
// the generic 'fouls' reason, so the chip can show a distinct marker
// for those two even when the plain 3-foul count hasn't separately
// been reached. A more specific reason is never overwritten by the
// generic one if both would technically apply to the same player.
function xgtDisqualifiedSet(side, eventsList) {
  var normSide = xgtDqSide(side);
  var counts = {}, dq = {};
  (eventsList || S.events).forEach(function (e) {
    if (e.action !== 'exclusion' || !e.outcome) return;
    var who = xgtWhoCommittedFoul(e);
    if (!who || xgtDqSide(who.side) !== normSide) return;
    if (e.outcome === 'excl_sub') { dq[who.number] = 'excl_sub'; return; }
    if (e.outcome === 'brutality') { dq[who.number] = 'brutality'; return; }
    if (e.outcome === 'red_card') { dq[who.number] = 'red_card'; return; }
    if (e.outcome === 'exclusion' || e.outcome === 'penalty') {
      counts[who.number] = (counts[who.number] || 0) + 1;
      if (counts[who.number] >= 3 && !dq[who.number]) dq[who.number] = 'fouls';
    }
  });
  return dq;
}
// Returns the disqualification reason itself (not just a boolean) so
// callers can apply a reason-specific marker class -- dqExclSub /
// dqBrutality / dqRedCard get their own distinct visual mark (S / X /
// R), while the plain 3-foul case just gets the shared dqPlayer
// treatment alone.
function xgtDqClass(dqSet, number) {
  var reason = dqSet[number];
  if (!reason) return '';
  return ' dqPlayer' + (reason === 'excl_sub' ? ' dqExclSub' : reason === 'brutality' ? ' dqBrutality' : reason === 'red_card' ? ' dqRedCard' : '');
}
// Runs after every commit(). The only thing that ever needs doing here
// -- the derived set above needs nothing done to it at all -- is the
// mandatory removal from the water: a disqualified player has to leave
// the pool immediately, and without this, their own chip (now
// non-interactive per xgtDqClass/.dqPlayer) would have been the only
// way left to log that removal, stranding them showing "in the water"
// with no tap left that could fix it.
function xgtCheckDisqualification(ev) {
  if (ev.action !== 'exclusion' || !ev.outcome) return;
  var who = xgtWhoCommittedFoul(ev);
  if (!who) return;
  var normSide = xgtDqSide(who.side);
  // Already flagged by an earlier event -- nothing new to announce or
  // remove. Checked against everything EXCEPT the event just pushed,
  // so this only ever fires on the actual crossing, not on every
  // subsequent foul this same player commits afterward.
  if (xgtDisqualifiedSet(normSide, S.events.slice(0, -1))[who.number]) return;
  if (!xgtDisqualifiedSet(normSide)[who.number]) return;
  var waterArr = normSide === 'opp' ? S.oppWater : S.water;
  var i = waterArr.indexOf(who.number);
  if (i >= 0) {
    waterArr.splice(i, 1);
    commit({ actor: { side: normSide, number: who.number },
             context: { kind: 'presence', dir: 'out', trackingMode: S.trackingMode, dc: null,
                        note: 'auto-removed \u2014 disqualified' } });
  }
  toast('#' + who.number + ' disqualified \u2014 no longer eligible');
}
function commit(partial) {
  var ev = makeEvent(partial);
  S.events.push(ev); S.undone.length = 0;
  xgtCheckDisqualification(ev);
  save(); render();
  return ev;
}
function applyPresence(e, forward) {
  if (S.trackingMode !== 'coach' || e.context.kind !== 'presence') return;
  var going = forward ? e.context.dir === 'in' : e.context.dir !== 'in';
  var i = S.water.indexOf(e.actor.number);
  if (going) { if (i < 0) { S.water.push(e.actor.number); S.water.sort(function (a, b) { return a - b; }); } }
  else if (i >= 0) S.water.splice(i, 1);
}
function undoLast() {
  if (!S.events.length) return;
  var e = S.events.pop(); applyPresence(e, false); S.undone.push(e);
  save(); render(); toast('Undone — ' + describe(e));
}
function redoLast() {
  if (!S.undone.length) return;
  var e = S.undone.pop(); applyPresence(e, true); S.events.push(e);
  save(); render(); toast('Restored — ' + describe(e));
}
// Called right as a player is tapped back "in" -- checks whether their
// own most recent presence change (going backward through S.events) was
// an "out" for this exact same player, with nobody else on the same
// side having subbed IN since. If so, this reads as a mis-tap being
// corrected, not a real substitution, per direct feedback ("a user
// might hit the wrong cap number every once in a while") -- explicitly
// covers a flying substitution too, where real time (and other events)
// can pass in between without another player ever having entered the
// water. Rather than logging both events, which cancel out to nothing
// real happening, the prior "out" is removed entirely -- the caller
// should NOT also commit a fresh "in" when this returns true, since
// there's nothing left to log. Deliberately does NOT disqualify on
// another player going OUT in between (only IN matters, per the exact
// wording of the request), and does NOT walk past the first
// presence event found for a DIFFERENT player -- this only asks "did
// the water genuinely change since this player left", not attempt to
// reconstruct the fuller history.
function xgtUndoAccidentalResub(side, number) {
  for (var i = S.events.length - 1; i >= 0; i--) {
    var e = S.events[i];
    if (!e.context || e.context.kind !== 'presence' || !e.actor || e.actor.side !== side) continue;
    if (e.actor.number === number) {
      if (e.context.dir === 'out') { S.events.splice(i, 1); return true; }
      return false; // this player's own most recent presence change wasn't an "out" -- not the pattern described
    }
    if (e.context.dir === 'in') return false; // a different player genuinely subbed in since -- a real substitution happened, leave both events alone
  }
  return false;
}
// Deliberately excludes shootout-tagged events (context.shootout===true)
// -- this feeds BOTH the live stats panel AND scoreOf() (the main
// 4-quarter score, including what gets cloud-synced as finalScore), so
// excluding shootout attempts here in one place correctly keeps them out
// of regular shooting-percentage stats AND out of the main game score at
// once, matching "a shootout's score is separate from the four-quarter
// score" -- rather than needing two separate fixes that could drift out
// of sync with each other.
function actionEvents() { return S.events.filter(function (e) { return e.context.kind === 'action' && !e.context.shootout; }); }
function scoreOf() {
  var h = 0, a = 0;
  actionEvents().forEach(function (e) {
    var t = treeFor(e);
    var act = null, out = null, i;
    for (i = 0; i < t.length; i++) if (t[i].id === e.action) act = t[i];
    if (act && act.children) for (i = 0; i < act.children.length; i++) if (act.children[i].id === e.outcome) out = act.children[i];
    if (!out || !out.scores) return;
    if (out.scores === 'opp' || (e.actor && e.actor.side === 'opp')) a++; else h++;
  });
  return [h, a];
}
function inWater(num) {
  // S.water is only a real, maintained array in team mode -- everywhere
  // else (single-player focus, including coach+field/goalkeeper now)
  // presence is tracked by scanning individual in/out events instead,
  // same as parent mode always did.
  if (S.trackingMode === 'coach' && S.playerRole === 'team') return S.water.indexOf(num) >= 0;
  var v = false;
  S.events.forEach(function (e) { if (e.context.kind === 'presence' && e.actor.number === num) v = e.context.dir === 'in'; });
  return v;
}
function waterSeconds(num) {
  var total = 0, open = null;
  function elapsed(e) { return (e.quarter - 1) * QLEN + (QLEN - e.gameClock); }
  S.events.forEach(function (e) {
    if (e.context.kind !== 'presence' || e.actor.number !== num) return;
    if (e.context.dir === 'in') open = elapsed(e);
    else if (open != null) { total += elapsed(e) - open; open = null; }
  });
  if (open != null) total += ((S.q - 1) * QLEN + (QLEN - S.clock)) - open;
  return Math.max(0, total);
}
function describe(e) {
  var c = e.context;
  if (c.kind === 'clock')    return 'Clock corrected to Q' + e.quarter + ' ' + fmt(e.gameClock);
  if (c.kind === 'presence') return '#' + e.actor.number + ' ' + (c.dir === 'in' ? 'in the water' : 'out');
  var pl = e.goalPlacement ? ' · ' + e.goalPlacement.label : '';
  var zn = e.fieldZoneName ? ' · ' + e.fieldZoneName : '';
  if (c.tree === 'gk') {
    if (e.actor && e.actor.side === 'us') return '#' + e.actor.number + ' — ' + (e.outcomeLabel || e.actionLabel) + zn;
    return (e.fieldZoneName || '?') + ' → ' + (e.variantLabel || e.actionLabel) + ' → ' + (e.outcomeLabel || '—') + pl;
  }
  var who = e.actor.side === 'opp' ? 'Opponent' : (e.actor.number != null ? '#' + e.actor.number : 'Team-mate');
  return who + ' — ' + (e.outcomeLabel || e.actionLabel) + (c.dc ? ' (' + c.dc + ')' : '') + zn + pl;
}

/* Manual correction, reachable from the stats log -- deliberately not a
   toggle to keep it available always right now (a coach fixing a
   mis-tap during a live game is exactly the case this exists for), but
   built as a single, isolated entry point so gating it behind a future
   "official game" mode later only means adding one guard here, not
   restructuring how editing works. */
function openEditEvent(eventId) {
  var e = S.events.filter(function (ev) { return ev.eventId === eventId; })[0];
  if (!e) return;
  var siblings = [];
  if (e.context.kind === 'action') {
    var t = treeFor(e);
    for (var i = 0; i < t.length; i++) { if (t[i].id === e.action) { siblings = t[i].children || []; break; } }
  }
  sheetEl().innerHTML = head('Edit entry', 'Q' + e.quarter + ' ' + fmt(e.gameClock) + ' · ' + describe(e), null) +
    (siblings.length ? '<span class="xgtLbl">Change outcome</span><div class="xgtOpts">' +
      siblings.map(function (o) {
        return '<button class="xgtOpt ' + o.cls + '" data-oc="' + o.id + '"><span class="dot"></span>' + o.label + '</button>';
      }).join('') + '</div><p class="xgtNote">Changing the outcome clears any recorded goal placement for this entry, since it may no longer apply.</p>'
      : '<p class="xgtNote">This entry has no alternate outcome to switch to.</p>') +
    '<div style="height:14px"></div>' +
    '<button class="xgtBtn" id="xgtDeleteEntry" style="background:#e53935;color:#fff;border-color:transparent">Delete this entry</button>';
  wire(null);
  Array.prototype.forEach.call(sheetEl().querySelectorAll('.xgtOpt'), function (b) {
    b.addEventListener('click', function () {
      var o = null;
      for (var j = 0; j < siblings.length; j++) { if (siblings[j].id === b.dataset.oc) { o = siblings[j]; break; } }
      if (!o) return;
      e.outcome = o.id; e.outcomeLabel = o.label; e.goalPlacement = null;
      save(); closeSheet(); render(); openStats();
      toast('Updated — ' + describe(e));
    });
  });
  el('xgtDeleteEntry').onclick = function () {
    var idx = S.events.indexOf(e);
    if (idx >= 0) S.events.splice(idx, 1);
    save(); closeSheet(); render(); openStats();
    toast('Entry deleted');
  };
  openSheet();
}

/* ------------------------------------------------------------- persistence */
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      v: 1, savedAt: new Date().toISOString(),
      game: S.game, trackingMode: S.trackingMode, playerRole: S.playerRole,
      me: S.me, squad: S.squad, water: S.water, keepers: S.keepers, keeperLabels: S.keeperLabels,
      opponentTracked: S.opponentTracked, oppSquad: S.oppSquad, oppWater: S.oppWater, oppKeepers: S.oppKeepers,
      q: S.q, clock: S.clock, seq: S.seq, events: S.events,
      cloudSessionName: S.cloudSessionName, trackScore: S.trackScore, officiallyEnded: S.officiallyEnded
    }));
  } catch (err) { /* private mode / quota — tracking continues in memory */ }
  syncSessionToCloud(); // fire-and-forget -- never blocks or delays the local save above
}
// Cloud sync of the current session, reusing the existing Library/Storage
// pipeline (Milestone 1's XQUIX.Storage / CloudProvider) rather than
// building anything new. A no-op when signed out -- guest/free tracking
// stays fully local, exactly as it always has. CloudProvider.saveItem()
// already handles offline queuing, retry, and local-backup-before-network
// entirely on its own, so this deliberately does nothing beyond calling it:
// no alert on failure (this fires on every commit/undo/redo, and a modal
// popping up mid-game over a transient network blip would be exactly the
// interruption the design was meant to avoid), just a console note for
// debugging, since the underlying system is already queuing a retry.
// Also gated on plan tier, not just sign-in -- storage was previously
// available to any signed-in user regardless of plan, which was a real
// gap: it's meant to be a paid feature. Uses its own gate ("Session
// Cloud Storage"), separate from Multi-Session Stats/Session PDF Export/
// Advanced Tracking Actions -- storage is the foundational capability
// that makes those others possible in the first place (nothing to view
// or export later if nothing gets saved), distinct enough from any of
// them individually to warrant its own row rather than piggybacking on
// one of the existing gates.
function xgtHasCloudStorage() {
  return typeof XQUIX === 'undefined' || !XQUIX.Entitlements || typeof XQUIX.Entitlements.canFunction !== 'function'
    || XQUIX.Entitlements.canFunction('Session Cloud Storage');
}
// Shared by the Options/Menu sheet and the Game Tracker landing screen --
// a Sessions/View Saved Sessions entry only makes sense to show when
// tapping it would actually lead somewhere useful: signed in, the
// underlying cloud-storage gate allowed, and something genuinely saved
// to show. listStoreSync() reads a local cache that may not be warm yet
// on a cold start -- true uncertainty (module not ready) defaults to
// showing the entry rather than risking hiding one that actually has
// content, matching this app's established fail-open convention
// elsewhere.
function xgtShouldShowSessionsEntry() {
  var signedIn = typeof XQUIX !== 'undefined' && XQUIX.Auth && XQUIX.Auth.getCurrentUser();
  return !!(signedIn && xgtHasCloudStorage() && (
    typeof XQUIX === 'undefined' || !XQUIX.StorageProvider || typeof XQUIX.StorageProvider.listStoreSync !== 'function'
    || Object.keys(XQUIX.StorageProvider.listStoreSync('gameTrackerSession')).length > 0
  ));
}
function syncSessionToCloud() {
  if (typeof XQUIX === 'undefined' || !XQUIX.Auth || !XQUIX.Storage || typeof XQUIX.Storage.save !== 'function') return Promise.resolve({ status: 'skipped', reason: 'unavailable' });
  if (!XQUIX.Auth.getCurrentUser()) return Promise.resolve({ status: 'skipped', reason: 'signed-out' });
  if (!xgtHasCloudStorage()) return Promise.resolve({ status: 'skipped', reason: 'no-entitlement' });
  if (!S.cloudSessionName) return Promise.resolve({ status: 'skipped', reason: 'no-session-name' });
  try {
    var sc = scoreOf();
    var hadShootout = shootoutAttempts().length > 0;
    var soTally = hadShootout ? shootoutTally() : null;
    var record = {
      schemaVersion: 1,
      trackingMode: S.trackingMode, playerRole: S.playerRole,
      trackedPlayer: S.me, squad: S.squad, keepers: S.keepers, keeperLabels: S.keeperLabels, water: S.water,
      opponentTracked: S.opponentTracked, oppSquad: S.oppSquad, oppWater: S.oppWater, oppKeepers: S.oppKeepers,
      game: S.game, finalScore: { home: sc[0], away: sc[1] },
      // Read by LibraryStorage.listAssets() specifically as "libraryDescription"
      // (not a generic "description") -- confirmed by reading that function
      // directly rather than assuming, since guessing wrong here would have
      // meant the card silently showing no summary at all.
      libraryDescription: 'Final ' + sc[0] + '–' + sc[1] + (hadShootout ? ' (SO ' + soTally.us + '-' + soTally.them + ')' : '') + ' · ' + S.events.length + ' actions logged',
      shootout: soTally,
      events: S.events
    };
    return XQUIX.Storage.save({ kind: 'gameTrackerSession', name: S.cloudSessionName, record: record, scope: 'personal' })
      .then(function (result) {
        if (result && result.error) {
          console.error('XquiX Game Tracker: cloud session sync failed (queued for retry by CloudProvider):', result.error.message);
          return { status: 'error', message: result.error.message };
        }
        return { status: 'success' };
      })
      .catch(function (err) {
        console.error('XquiX Game Tracker: cloud session sync threw:', err);
        return { status: 'error', message: err && err.message };
      });
  } catch (err) {
    // Defense in depth: even a synchronous throw here (e.g. a malformed
    // or partially-mocked XQUIX.Storage) must never propagate out of
    // save() -- save() is called from commit(), which is called from
    // go() itself during setup, so an uncaught throw here could abort
    // setup entirely and leave the coach stuck mid-flow. Confirmed this
    // exact failure mode while testing: a save() lacking .save (as a
    // function) threw synchronously and interrupted go() before it
    // reached closeSheet()/render() at the end.
    console.error('XquiX Game Tracker: cloud session sync threw synchronously:', err);
    return Promise.resolve({ status: 'error', message: err && err.message });
  }
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (err) { return null; }
}
function clearSaved() { try { localStorage.removeItem(KEY); } catch (err) {} }
// Single source of truth for "start a completely fresh game" -- every
// entry point that starts a new game (the Stats screen's New Game
// button, and the resume prompt's Start a new game instead) calls this,
// rather than each maintaining its own partial reset list. That's
// exactly how this bug happened: the resume prompt's own version reset
// nothing beyond the persisted localStorage copy, and the Stats
// screen's version reset some fields but missed others (the opponent
// roster, the shootout state, and the Q4-ended flag among them) -- a
// coach starting a genuinely new game could still be looking at the
// previous one's score, events, and even mid-shootout state.
// Deliberately leaves alone what genuinely isn't game data: device-
// level display preferences (zoneNumberOverrides), persistent UI
// choices (trackScore), and the tracking-mode/role selection, which a
// coach starting a new game most likely wants to keep rather than
// re-pick every time.
function resetGameState() {
  // One last sync of whatever's about to be discarded, in case the very
  // final events of the old game (right up to this moment) hadn't
  // already been individually synced -- syncSessionToCloud() already
  // runs after every commit() during play, so this is a safety net for
  // the last moment, not the primary save mechanism. Only bothers if
  // there's actually something to save; a session with no events yet
  // has nothing worth writing.
  if (S.events.length) syncSessionToCloud();
  S.game = { date: '', loc: '', home: '', away: '' };
  S.me = { number: null, name: '' };
  S.squad = []; S.water = []; S.keepers = [];
  S.opponentTracked = false; S.oppSquad = []; S.oppWater = []; S.oppKeepers = [];
  S.keeperLabels = {};
  S.q = 1; S.clock = QLEN; S.running = false;
  if (S.tick) { clearInterval(S.tick); S.tick = null; }
  S.events = []; S.undone = []; S.seq = 0;
  S.draft = null;
  S.cloudSessionName = null;
  S.shootoutStartSide = null;
  S.shootoutGoalkeepers = { us: null, them: null };
  S.shootoutRoster = { us: [], them: [] };
  S.shootoutFreeSelection = false;
  S.regulationEnded = false;
  S.officiallyEnded = false;
  S.finishPromptShown = false;
  clearSaved();
}
function restore(d) {
  S.game = d.game; S.trackingMode = d.trackingMode; S.playerRole = d.playerRole;
  S.me = d.me; S.squad = d.squad || []; S.water = d.water || []; S.keepers = d.keepers || [];
  S.keeperLabels = d.keeperLabels || {};
  S.opponentTracked = d.opponentTracked || false;
  S.oppSquad = d.oppSquad || []; S.oppWater = d.oppWater || []; S.oppKeepers = d.oppKeepers || [];
  S.q = d.q; S.clock = d.clock; S.seq = d.seq || 0; S.events = d.events || []; S.undone = [];
  S.cloudSessionName = d.cloudSessionName || null; // preserved so a resumed session keeps updating the SAME cloud record, not a fresh duplicate
  S.trackScore = d.trackScore || false;
  S.officiallyEnded = d.officiallyEnded || false;
  S.finishPromptShown = false;
}

/* ================================================================== styling */
var CSS = [
'#xgtBlock{position:fixed;inset:0;z-index:999980;background:transparent;touch-action:manipulation}',
'#xgtShield{position:fixed;z-index:999981;background:transparent;touch-action:manipulation;',
'  box-shadow:0 0 0 9999px rgba(13,43,43,.45);border-radius:4px}',
// A 3m-radius dome positioned at the far edge of the visible half (a
// real water-polo pool's halfway boundary), for logging actions that
// happened somewhere in the unrendered other half rather than a
// specific tracked position there. Screen-space CSS positioning rather
// than an SVG shape drawn in the board's own rotated/translated
// coordinate space -- positionOppoZone() computes its left/top via the
// exact same boardToClient() math the rest of this module already
// trusts for that, so this stays correct across every board orientation
// without needing its own copy of that transform logic. z-index sits
// above the shield (999981) since it needs its own direct tap handling,
// not the shield's board-coordinate hit-testing.
'#xgtOppoZone{position:fixed;width:130px;height:65px;z-index:999982;',
'  background:rgba(255,255,255,.30);border:1.5px solid rgba(255,255,255,.7);border-top:0;',
'  border-radius:0 0 65px 65px;color:#fff;font-weight:800;font-size:11.5px;letter-spacing:.05em;',
'  cursor:pointer;padding:9px 0 0;display:flex;justify-content:center;text-shadow:0 1px 3px rgba(0,0,0,.5);',
'  touch-action:manipulation}',
'#xgtOppoZone.flash{background:rgba(255,255,255,.55)}',
'#xgtRoot{position:fixed;inset:0;z-index:999983;pointer-events:none;',
'  font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#14235c;-webkit-user-select:none;user-select:none}',
'#xgtRoot *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
'#xgtRoot button{font:inherit;color:inherit;border:0;background:none;cursor:pointer}',
'.xgtPane{pointer-events:auto;background:#fff;border:1px solid #ccd6d6;box-shadow:0 2px 14px rgba(20,35,92,.10)}',
'#xgtTop{position:absolute;top:0;left:0;right:0;display:flex;flex-direction:column;gap:6px;',
'  padding:calc(env(safe-area-inset-top) + 5px) 10px 5px;border-width:0 0 1px}',
'#xgtClockRow{display:flex;align-items:center;justify-content:center;gap:16px;padding-right:38px}', // now a 3-part row (home score / clock / away score) rather than the clock alone -- see xgtScore below for how the score elements join this same row without a second visibility toggle to keep in sync. padding-right reserves exactly #xgtExitBtn's own footprint (32px wide, 6px offset) so the away team's name/score never sits underneath it, regardless of team name length
'#xgtScore{display:contents}', // deliberately not a real box -- its two .tm children become direct flex items of xgtClockRow above when shown (positioned via order, not DOM position, so xgtClock can stay in the middle), and the existing single S.trackScore toggle in render() still shows/hides both at once by switching this to 'none'
'#xgtClock{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:none;order:2}', // middle position, between the two scores
'#xgtTop .tm{flex:1;min-width:0;order:1}',
'#xgtTop .tm .nm{font-size:11px;color:#7c8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'#xgtTop .tm .sc{font-size:42px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1;color:#14235c}', // sized to roughly match the combined height of the stacked quarter+clock beside it, per direct request
'#xgtTop .tm.aw{text-align:right;order:3}',

'#xgtQ{display:block;width:100%;font-size:10px;letter-spacing:.07em;color:#7c8a8a;font-weight:700;padding:1px 6px 2px}',
'#xgtT{font-size:21px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.05}', // color intentionally NOT set here -- #xgtRoot button{color:inherit} outranks a lone #xgtT selector on specificity (ID+element beats ID alone), so the actual color rules live below, qualified the same way
'#xgtRoot #xgtT{color:#c0392b}', // red while stopped -- ID+ID beats #xgtRoot button's ID+element
'#xgtRoot #xgtT.run{color:#2e7d32}', // green while running -- needs the same #xgtRoot qualifier as the rule above, or its extra class alone isn't enough to outrank it
// Moved out of the main button row entirely and into a fixed corner --
// on a phone in portrait, this was previously just one more button
// crowded in among several others and easy to miss when actually
// looking to leave. Matches the same closeToolPanelBtn treatment used
// throughout the rest of this app for "leave this" actions: a filled
// circle, top-right, always in the same place regardless of what else
// is on screen.
'#xgtExitBtn{position:absolute;top:calc(env(safe-area-inset-top) + 6px);right:6px;z-index:5;',
'  width:32px;height:32px;min-width:32px;padding:0;border-radius:50%;',
'  background:#e1e9e9;border:1.5px solid #b7c4c4;color:#1a2424;font-size:15px;font-weight:700;',
'  display:flex;align-items:center;justify-content:center}',
'#xgtExitBtn:active{background:#cfdcdc}',
// Shown only once regulation actually ends (S.regulationEnded) --
// content is filled in by render(), not baked into this rule, since it
// differs depending on whether the score is tied.
'#xgtGameOverBanner{border-radius:12px;padding:14px 12px;margin:8px 0;text-align:center}',
'#xgtGameOverBanner.tied{background:#fff3cd;color:#7a5b00}',
'#xgtGameOverBanner.decided{background:#e1e6e6;color:#124d4d}',
'#xgtGameOverLabel{font-weight:700;font-size:12px;letter-spacing:.06em;text-transform:uppercase;opacity:.85}',
'#xgtGameOverScore{font-weight:800;font-size:26px;line-height:1.25;margin-top:4px;font-variant-numeric:tabular-nums}',
'#xgtGameOverBanner button{margin-top:12px;width:100%;padding-top:15px;padding-bottom:15px;font-size:15px}',
'#xgtBottom{position:absolute;left:0;right:0;bottom:0;border-width:1px 0 0;',
'  padding:8px 10px calc(env(safe-area-inset-bottom) + 8px);display:flex;flex-direction:column;gap:7px;',
'  max-height:58vh;max-height:58dvh;overflow-y:auto;-webkit-overflow-scrolling:touch}',
'#xgtLog{max-height:58px;overflow-y:auto;-webkit-overflow-scrolling:touch}',
'#xgtLog .lr{display:flex;gap:8px;align-items:baseline;padding:4px 0;font-size:12px;color:#124d4d;',
'  border-bottom:1px solid #e1e6e6}',
'#xgtLog .lr:last-child{border-bottom:0}',
'#xgtLog .tm{font-variant-numeric:tabular-nums;color:#7c8a8a;font-size:10.5px;width:50px;flex:none}',
'#xgtLog .mn{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.xgtRow{display:flex;gap:7px;align-items:center;min-width:0}',
// Attached directly to the latest log entry rather than living on
// their own dedicated row -- opacity lives on each button itself, not
// the shared container, so the :active override below can push a
// specific button to full opacity without the parent's opacity
// multiplying it back down.
'.lrActions{display:flex;gap:4px;flex:none}',
'.lrActions button{width:22px;height:22px;padding:0;border-radius:6px;border:1px solid #ccd6d6;background:#fff;',
'  font-size:12px;display:flex;align-items:center;justify-content:center;color:#124d4d;flex:none;opacity:.5}',
'#xgtRoot .lrUndo:active{opacity:1;background:#e53935;color:#fff;border-color:transparent}',
'#xgtRoot .lrRedo:active{opacity:1;background:#2e7d32;color:#fff;border-color:transparent}',
'.xgtWho{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:11px;background:#e1e6e6;',
'  border:1px solid #ccd6d6;flex:1;min-width:0;color:#14235c}',
'.xgtWho .num{font-size:18px;font-weight:750;font-variant-numeric:tabular-nums}',
'.xgtWho .meta{font-size:10.5px;color:#7c8a8a;line-height:1.25;min-width:0}',
'.xgtPill{padding:12px 10px;border-radius:11px;font-size:13px;font-weight:650;border:1px solid #ccd6d6;',
'  background:#e1e6e6;color:#124d4d;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.xgtPill.in{background:#2e7d32;color:#fff;border-color:transparent}',
'.xgtPill.out{background:transparent;color:#7c8a8a}',
'.xgtChips{display:flex;flex-wrap:wrap;gap:6px}',
'.xgtChip{min-width:40px;height:40px;padding:0 10px;border-radius:10px;background:#e1e6e6;',
'  border:1px solid #ccd6d6;font-weight:650;font-variant-numeric:tabular-nums;',
'  display:flex;align-items:center;justify-content:center;color:#124d4d}',
// Live "in the water" roster bar specifically, not the one-time setup
// screens (squad/goalkeeper selection), where the larger, easier-to-hit
// size stays exactly as it was. During live tracking, per direct
// feedback, the field itself is the priority -- these chips are
// tapped often but only need to be legible, not prominent, and the
// smaller footprint leaves more room for the field above them.
'#xgtRoot .xgtChip{min-width:28px;height:28px;padding:0 6px;font-size:13px}',
'#xgtSheet .xgtChip[aria-pressed="true"]{background:#1b7373;color:#fff;border-color:transparent}',
'#xgtRoot .xgtChip.water, #xgtSheet .xgtChip.water{background:#2e7d32;color:#fff;border-color:transparent}', /* #xgtSheet alone isn\'t enough: renderBar() renders these chips into #xgtBar, which is inside #xgtRoot (NOT #xgtSheet -- confirmed these are separate containers), and #xgtRoot button{background:none} outranks a plain two-class rule by specificity. Both ID scopes are needed to cover both locations these chips actually render in. */
// Phase F: goalie designation -- solid fill in the setup sheet (nothing
// else competes for that chip's background there), an inset ring in the
// live bar instead (has to coexist with the green water fill, which
// already owns the chip's actual background there).
'#xgtSheet .xgtChip.goalie{background:#c0392b;color:#fff;border-color:transparent}',
'#xgtRoot .xgtChip.goalie{box-shadow:inset 0 0 0 2px #c0392b}',
// Phase E: live scoreboard badges + opponent quick-tap goal/foul buttons
// Both rosters always visible now, side by side, rather than a toggle
// that only ever showed one at a time -- own team left, opponent
// right. Each column wraps its own chips independently, so a fuller
// roster on one side doesn't push the other side's chips around.
'.xgtBarSplit{display:flex;gap:10px;align-items:flex-start}',
'.xgtBarCol{flex:1;min-width:0}',
// A narrow, fixed-width divider between the two roster columns rather
// than competing for space with either -- the side borders are what
// actually read as "a natural separation of both teams" visually,
// with Options/Stats living inside that same divider since it needs
// to be somewhere, and this is the one place already structurally
// between the two teams.
'.xgtBarUtil{display:flex;flex-direction:column;gap:6px;flex:none;padding:2px 8px;border-left:1px solid #e1e6e6;border-right:1px solid #e1e6e6;justify-content:center}',
'.xgtBarUtil button{font-size:10.5px;font-weight:650;padding:6px 9px;border-radius:8px;background:#e1e6e6;border:1px solid #ccd6d6;color:#124d4d;white-space:nowrap}',
'.xgtChipWrap{position:relative;display:inline-flex;flex-direction:column;align-items:center;gap:3px}',
'.xgtChipBadges{position:absolute;top:-6px;right:-6px;display:flex;gap:2px;pointer-events:none}',
'.xgtBadgeGoal,.xgtBadgeFoul{font-size:9px;font-weight:800;min-width:14px;height:14px;border-radius:7px;color:#fff;display:flex;align-items:center;justify-content:center;padding:0 2px;line-height:1}',
'.xgtBadgeGoal{background:#1b7373}',
'.xgtBadgeFoul{background:#c0392b}', /* red, not teal -- deliberately the more attention-getting color, since several water polo rule sets disqualify a player after a set number of personal fouls and this is meant to be glanceable */

/* scrim + sheet */
'#xgtScrim{position:fixed;inset:0;z-index:999985;background:rgba(13,43,43,.45);opacity:0;pointer-events:none;transition:opacity .18s}',
'#xgtScrim.on{opacity:1;pointer-events:auto}',
'#xgtSheet{position:fixed;left:0;right:0;bottom:0;z-index:999986;max-width:520px;margin:0 auto;background:#fff;',
'  border-radius:20px 20px 0 0;border-top:1px solid #ccd6d6;color:#14235c;box-shadow:0 -6px 30px rgba(20,35,92,.14);',
'  font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;',
'  transform:translateY(102%);transition:transform .22s cubic-bezier(.2,.8,.25,1);',
'  padding:8px 14px calc(env(safe-area-inset-bottom) + 14px);max-height:90vh;overflow-y:auto;-webkit-user-select:none;user-select:none}',
'#xgtSheet.on{transform:translateY(0)}',
'#xgtSheet *{box-sizing:border-box}',
'#xgtSheet button{font:inherit;color:inherit;border:0;background:none;cursor:pointer}',
'.xgtGrab{width:38px;height:4px;border-radius:2px;background:#ccd6d6;margin:4px auto 12px}',
'.xgtHd{display:flex;align-items:center;gap:10px;margin-bottom:12px}',
'.xgtHd .z{font-size:16px;font-weight:700;color:#14235c}',
'.xgtHd .cr{font-size:11.5px;color:#7c8a8a}',
'.xgtIcon{padding:8px 10px;border-radius:9px;background:#e1e6e6;border:1px solid #ccd6d6;font-size:13px;color:#124d4d}',
'.xgtOpts{display:grid;grid-template-columns:1fr 1fr;gap:9px}',
'.xgtOpts.one{grid-template-columns:1fr}',
'.xgtOpt{padding:16px 13px;border-radius:14px;background:#e1e6e6;border:1px solid #ccd6d6;color:#124d4d;',
'  font-weight:650;font-size:15px;text-align:left;display:flex;align-items:center;gap:10px;min-height:58px}',
'#xgtSheet .xgtOpt:active{background:#1b7373;color:#fff}',
'.xgtOpt:active .sub{color:#e1e6e6}',
'.xgtOpt .dot{width:9px;height:9px;border-radius:50%;flex:none;background:#7c8a8a}',
'.xgtOpt .sub{display:block;font-size:11px;font-weight:500;color:#7c8a8a;margin-top:2px}',
'.xgtOpt.g .dot{background:#2e7d32}.xgtOpt.w .dot{background:#ffcc00}',
'.xgtOpt.s .dot{background:#ff8a5c}.xgtOpt.c .dot{background:#e53935}.xgtOpt.b .dot{background:#1b7373}',
/* Segment control (Field Player / Goalkeeper / Team, Parent / Coach, etc.):
   a light, low-contrast TRACK with a solid, high-contrast PRESSED state --
   the previous dark-teal-on-dark-teal version made the selected option
   hard to distinguish, which is exactly the "no confirmation of my
   selection" issue this fixes. */
'.xgtSeg{display:flex;background:#e1e6e6;border:1px solid #ccd6d6;border-radius:12px;padding:3px;gap:3px;margin-bottom:11px}',
'.xgtSeg button{flex:1;padding:10px 6px;border-radius:9px;font-size:13px;font-weight:600;color:#54605f}',
'#xgtSheet .xgtSeg button[aria-pressed="true"]{background:#1b7373;color:#fff;box-shadow:0 1px 4px rgba(20,35,92,.25)}',
'#xgtStats .xgtSeg button[aria-pressed="true"]{background:#1b7373;color:#fff;box-shadow:0 1px 4px rgba(20,35,92,.25)}',
'.xgtNums{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}',
'.xgtNum{min-height:60px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:750;color:#124d4d;',
'  font-variant-numeric:tabular-nums;border-radius:14px;background:#e1e6e6;border:1px solid #ccd6d6}',
'#xgtSheet .xgtNum:active{background:#1b7373;color:#fff}',
// Shootout shooter chips: three progressively darker shades marking how
// many times THIS specific player has already shot in the current
// shootout, cycling back to shade 1 past a 4th shot (round 4 -- 15
// total attempts across 5 shooters -- reuses shade 1 rather than
// needing a 4th color, per confirmed scope).
'.xgtNum.soShot1{background:#a9c2c2;border-color:#8fb0b0}',
'.xgtNum.soShot2{background:#4f7a7a;color:#fff;border-color:#3f6363}',
'.xgtNum.soShot3{background:#0d3838;color:#fff;border-color:#092a2a}',
// Marks who's up next in the established order -- enforced by default
// (the actual blocking is the disabled attribute set in drawMain()
// itself, not this ring), unless free selection is on, in which case
// this ring is purely informational since every chip is tappable
// again. Layers over any of the three shade classes above, so it
// reads clearly whether this is someone's 1st, 2nd, or 3rd trip to
// the line.
'.xgtNum.soSuggested{box-shadow:0 0 0 3px #e0a72c;animation:soSuggestPulse 1.6s ease-in-out infinite}',
'@keyframes soSuggestPulse{0%,100%{box-shadow:0 0 0 3px #e0a72c}50%{box-shadow:0 0 0 5px #f0c15c}}',
// The actual block -- visibly inert rather than just quietly ignoring
// taps, since a disabled control that still looked fully normal is
// what read as "nothing is happening" before.
'.xgtNum:disabled{background:#e1e6e6 !important;color:#8a9898 !important;border-color:#ccd6d6 !important;cursor:not-allowed;animation:none;box-shadow:none !important;background-image:repeating-linear-gradient(135deg,rgba(138,152,152,.18) 0 4px,transparent 4px 10px)}',
// Fixed position label ("1st", "2nd"...) marking this player's spot in
// the order round 1 established, regardless of how many times they've
// since shot -- distinct from the shade classes above, which track
// shot count, not shooting position.
'.xgtNum{position:relative}',
'.soOrdinal{position:absolute;top:-8px;left:-6px;background:#1b7373;color:#fff;font-size:10px;font-weight:800;padding:2px 5px;border-radius:8px;line-height:1}',
// Same color language as #xgtGameOverBanner.decided (a settled, no-
// longer-live state) -- kept as its own class rather than reusing that
// ID-scoped rule, since this banner lives inside the shootout sheet
// itself, not the main tracker screen behind it.
'.soDecidedBanner{border-radius:10px;padding:9px 12px;margin:0 0 12px;text-align:center;font-weight:700;font-size:14px;background:#e1e6e6;color:#124d4d}',
// One class, applied to whatever element (a single button, or a wrap
// containing several -- e.g. the water bar's chip plus its adjacent
// +G/+F quick buttons) needs to stop being a tap target once a player
// is disqualified. pointer-events:none blocks every descendant too, so
// this never needs touching each render site's own click-wiring loop
// to keep it non-interactive -- the loop can stay exactly as it was.
'.dqPlayer{opacity:.5;pointer-events:none}',
// Distinct marker for the two disqualification reasons specific
// enough to call out on their own (Excl.+Substitution / Brutality),
// on top of the shared 50% opacity every disqualified player already
// gets -- top-left corner, opposite the goal/foul count badges
// (top-right), so the two never collide on the same chip.
'.xgtChip.dqExclSub,.xgtChip.dqBrutality,.xgtChip.dqRedCard,.xgtNum.dqExclSub,.xgtNum.dqBrutality,.xgtNum.dqRedCard{position:relative}',
'.xgtChip.dqExclSub::after,.xgtChip.dqBrutality::after,.xgtChip.dqRedCard::after,.xgtNum.dqExclSub::after,.xgtNum.dqBrutality::after,.xgtNum.dqRedCard::after{position:absolute;top:-6px;left:-6px;width:15px;height:15px;',
'  border-radius:50%;background:#c0392b;color:#fff;font-size:9.5px;font-weight:800;display:flex;',
'  align-items:center;justify-content:center;line-height:1}',
'.xgtChip.dqExclSub::after,.xgtNum.dqExclSub::after{content:"S"}',
'.xgtChip.dqBrutality::after,.xgtNum.dqBrutality::after{content:"X"}',
'.xgtChip.dqRedCard::after,.xgtNum.dqRedCard::after{content:"R"}',
'.xgtBtn{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 16px;border-radius:12px;',
'  background:#e1e6e6;border:1px solid #ccd6d6;font-weight:600;width:100%;color:#124d4d}',
'#xgtRoot .xgtBtn.pri{background:#1b7373;border-color:transparent;color:#fff}',
'.xgtField{width:100%;padding:11px 12px;border-radius:10px;background:#fff;border:1px solid #ccd6d6;',
'  color:#14235c;outline:none;margin-bottom:10px;font:inherit}',
'.xgtField:focus{border-color:#1b7373}',
'.xgtLbl{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#7c8a8a;font-weight:650;margin:0 0 6px}',
'.xgtNote{font-size:12px;color:#7c8a8a;line-height:1.5}',
'.xgtErr{display:none;margin:0 0 10px;padding:10px 12px;border-radius:11px;font-size:13px;font-weight:600;color:#a12a26;',
'  background:rgba(229,57,53,.10);border:1px solid #e53935}',
'.xgtErr.on{display:block}',
'.xgtGoal{width:100%;height:auto;display:block;margin:2px 0 10px;touch-action:manipulation}',
// Default (non-frame) tap zones -- a light, visible boundary and a
// pale fill against the dark teal background, replacing the previous
// dark-navy-on-dark-teal stroke that read as almost no boundary at
// all. Kept as its own distinct treatment from the frame zones below
// (lighter fill here) so "inside the cage" and "the frame itself"
// read as two different kinds of area, not just two shapes of the
// same thing.
'.gz .gh{fill:rgba(255,255,255,.16);stroke:rgba(255,255,255,.5);stroke-width:1.5}',
'.gz:active .gh,.gz.flash .gh{fill:#1b7373;opacity:.9}',
'.gz:active text,.gz.flash text{fill:#fff}',
// Frame (post/crossbar) sub-zones carry no fill or stroke of their
// own at rest -- the single continuous outline drawn separately in
// buildGoalSvg() (see .gzFrameOutline) is what actually reads as the
// goal frame, so the three tap targets underneath it (left post,
// crossbar, right post) never show a seam between each other. Only
// which one was actually tapped shows through, via the active state
// below.
'.gz.frame .gh{fill:transparent;stroke:none}',
'.gz.frame:active .gh,.gz.frame.flash .gh{fill:#e53935}',
// Same light color as the boundaries above, per confirmed direction --
// this was previously #124d4d, the exact same color as the SVG's own
// background fill, which is why the labels were never actually
// readable rather than merely low-contrast.
'.gz text{pointer-events:none;font-size:12px;font-weight:700;fill:rgba(255,255,255,.92);opacity:1}',
'.gz.sm text{font-size:10px}',
// Sharp corners, matching the new frame outline -- rx removed so
// nothing in the goal reads as round-edged.
'.gzFrameOutline{fill:rgba(255,255,255,.08);stroke:rgba(255,255,255,.65);stroke-width:1.5}',
'.xgtDead{fill:rgba(124,138,138,.20);stroke:rgba(255,255,255,.5);stroke-width:1.5;stroke-dasharray:5 5}',
'.gz.block .gh{fill:rgba(255,204,0,.22);stroke:#c99700;stroke-width:2;stroke-dasharray:6 5}',
'.gz.block text{font-size:11px;fill:#ffe9a8}',
'.gz.block:active .gh{fill:#ffcc00;stroke:#c99700}',
'.gz.block:active text{fill:#14235c}',
'.xgtTdisp{font-size:42px;font-weight:750;font-variant-numeric:tabular-nums;text-align:center;margin:2px 0 10px;color:#14235c}',
'.xgtTgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:9px}',
'.xgtStep{padding:15px 6px;border-radius:12px;background:#e1e6e6;border:1px solid #ccd6d6;color:#124d4d;',
'  font-weight:700;font-variant-numeric:tabular-nums;font-size:15px}',
'#xgtSheet .xgtStep:active{background:#1b7373;color:#fff}',
/* toast */
'#xgtToast{position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top) + 108px);max-width:496px;margin:0 auto;',
'  z-index:999987;background:#14235c;border:1px solid #14235c;border-radius:12px;padding:10px 12px;',
'  font:13px/1.35 system-ui,sans-serif;color:#fff;opacity:0;transform:translateY(-8px);pointer-events:none;transition:.2s}',
'#xgtToast.on{opacity:1;transform:translateY(0)}',
/* stats -- explicitly requested lighter, matching the rest of this pass */
'#xgtStats{position:fixed;inset:0;z-index:999984;background:#f2f5f5;color:#14235c;overflow-y:auto;display:none;',
'  font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:calc(env(safe-area-inset-top) + 10px) 12px 40px}',
'#xgtStats.on{display:block}',
'#xgtStats h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:#7c8a8a;margin:16px 0 8px}',
'.xgtCard{background:#fff;border:1px solid #d5dede;border-radius:14px;padding:12px;margin-bottom:10px}',
// Portrait: 4-wide grid, wraps into as many rows as needed. Landscape:
// switches to flex so every tile fits in one row regardless of count,
// rather than a fixed column count that would either waste width or
// wrap unnecessarily on a wide screen.
'.xgtTiles{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px}',
'@media (orientation:landscape){.xgtTiles{display:flex;flex-wrap:nowrap}.xgtTiles .xgtTile{flex:1;min-width:0}}',
'.xgtTile{background:#fff;border:1px solid #d5dede;border-radius:10px;padding:7px 5px;text-align:center}',
'.xgtTile .v{font-size:18px;font-weight:750;line-height:1.05;color:#124d4d}',
'.xgtTile .k{font-size:8px;color:#7c8a8a;font-weight:600;margin-top:2px;line-height:1.15}',
// Player overview: tiles instead of full-width table rows -- 3-wide
// portrait, 6-wide landscape.
'.xgtPlayerTiles{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:10px}',
'@media (orientation:landscape){.xgtPlayerTiles{grid-template-columns:repeat(6,1fr)}}',
'.xgtPlayerTile{background:#fff;border:1px solid #d5dede;border-radius:10px;padding:8px 4px;display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;font-family:inherit}',
'.xgtPlayerTile.goalie{box-shadow:inset 0 0 0 2px #c0392b}',
'.xgtPlayerTile .num{font-size:16px;font-weight:750;color:#124d4d}',
'.xgtPlayerTile .pstats{display:flex;gap:5px;font-size:9.5px;color:#7c8a8a;font-weight:700}',
'.xgtPlayerTile .pstats .g{color:#1b7373}',
'.xgtPlayerTile .pstats .f{color:#c0392b}',
'#xgtStats table{width:100%;border-collapse:collapse;font-size:12.5px}',
'#xgtStats th{text-align:left;font-size:10px;text-transform:uppercase;color:#7c8a8a;padding:6px 4px;border-bottom:1px solid #ccd6d6}',
'#xgtStats td{padding:7px 4px;border-bottom:1px solid #e1e6e6;font-variant-numeric:tabular-nums;color:#14235c}',
'.xgtGp{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:#e1e6e6;padding:6px;border-radius:10px;',
'  border:2px solid #ccd6d6}',
'.xgtGpc{aspect-ratio:1.6;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;',
'  font-size:16px;font-weight:750;font-variant-numeric:tabular-nums;color:#124d4d}',
'.xgtGpc span{font-size:8px;font-weight:600;opacity:.75;margin-top:1px;text-align:center}',
/* zone overlay inside Studio's own zones svg -- left as light-on-dark
   deliberately, since this sits on top of Studio's own water-colored
   field rendering, not on the tracker's own light UI chrome. */
'.xgtZone{fill:rgba(255,255,255,.10);stroke:rgba(255,255,255,.85);stroke-width:1.6;vector-effect:non-scaling-stroke}',
'.xgtZone.xgtFlash{fill:#1b7373;fill-opacity:.85}',
'.xgtZoneLabel{text-anchor:middle;dominant-baseline:central;fill:#fff;paint-order:stroke;stroke:rgba(13,43,43,.55);stroke-width:.22;',
'  stroke-linejoin:round;font-family:system-ui,sans-serif}',
'.xgtZoneNum{font-size:1.3px;font-weight:800}',
/* launcher */
// Phone landscape specifically (max-height, not max-width -- a tablet or
// desktop turned sideways still has plenty of vertical room and doesn't
// need this). Total chrome height (top clock/score/util row + bottom
// log/undo/roster) measured at ~308px against a real phone's ~390px
// landscape viewport -- xgtViewportHeight()'s own 220px floor then kept
// the field's computed area larger than what was actually left over,
// so the bottom chrome panel physically overlapped the field's own
// space instead of sitting cleanly below it. The log strip is the
// single most compactable piece here: purely informational, not
// interactive, and its content (what just happened) is already
// available via the undo button's own label right next to it -- hiding
// it recovers real vertical room without losing any actual capability.
'@media (orientation: landscape) and (max-height: 500px) {',
'  #xgtLog{display:none}',
'  #xgtBottom{padding-top:5px;padding-bottom:calc(env(safe-area-inset-bottom) + 5px);gap:4px}',
'}'
].join('\n');

function injectCss() {
  if (el('xgtStyle')) return;
  var st = document.createElement('style');
  st.id = 'xgtStyle'; st.textContent = CSS;
  document.head.appendChild(st);
}

/* ==================================================================== chrome */
function buildChrome() {
  if (el('xgtRoot')) return;
  var block = document.createElement('div'); block.id = 'xgtBlock';
  var shield = document.createElement('div'); shield.id = 'xgtShield';
  var oppoZone = document.createElement('button'); oppoZone.id = 'xgtOppoZone';
  oppoZone.type = 'button'; oppoZone.textContent = 'OPPO';
  oppoZone.setAttribute('aria-label', 'Action happened in the opposite half of the pool');
  var root = document.createElement('div'); root.id = 'xgtRoot';
  root.innerHTML =
    '<div class="xgtPane" id="xgtTop">' +
      '<button id="xgtExitBtn" aria-label="Exit Game Tracker">\u2715</button>' +
      '<div id="xgtClockRow">' +
        '<div id="xgtScore">' +
          '<div class="tm"><div class="nm" id="xgtHn">My team</div><div class="sc" id="xgtHs">0</div></div>' +
          '<div class="tm aw"><div class="nm" id="xgtAn">Opponent</div><div class="sc" id="xgtAs">0</div></div>' +
        '</div>' +
        '<div id="xgtClock"><button id="xgtQ">Q1 ✎</button><button id="xgtT">8:00</button></div>' +
      '</div>' +
      '<div id="xgtGameOverBanner" style="display:none"></div>' +
    '</div>' +
    '<div class="xgtPane" id="xgtBottom">' +
      '<div id="xgtLog"></div>' +
      '<div id="xgtBar"></div>' +
    '</div>';
  var scrim = document.createElement('div'); scrim.id = 'xgtScrim';
  var sheet = document.createElement('div'); sheet.id = 'xgtSheet';
  var toastEl = document.createElement('div'); toastEl.id = 'xgtToast';
  var stats = document.createElement('div'); stats.id = 'xgtStats';
  document.body.appendChild(block); document.body.appendChild(shield); document.body.appendChild(oppoZone); document.body.appendChild(root);
  block.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); }, false);
  block.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, false);
  document.body.appendChild(scrim); document.body.appendChild(sheet);
  document.body.appendChild(toastEl); document.body.appendChild(stats);

  /* the shield is the ONLY thing Studio's board competes with — it wins,
     so no Studio tool can fire while tracking is on */
  shield.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); }, false);
  shield.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    var b = screenToBoard(e.clientX, e.clientY);
    if (!b) return;
    var z = hitZone(b.x, b.y);
    if (!z) return;
    flashZone(z);
    if (navigator.vibrate) navigator.vibrate(8);
    if (S.editingZoneNumbers) { promptZoneNumberEdit(z); return; }
    openZone(z, b);
  }, false);
  // Direct tap handling rather than routing through the shield's own
  // board-coordinate hit-testing -- this element is positioned in plain
  // screen-space (see positionOppoZone()), not the board's own rotated/
  // translated coordinate system, so its own native click event is the
  // simpler, more robust source of truth for "was this tapped" than
  // trying to replicate that transform math a second time just to
  // detect hits inside its shape.
  oppoZone.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); }, false);
  oppoZone.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    // Renumbering doesn't map cleanly onto OPPO's non-numeric label, and
    // the coach is unlikely to want to rename it anyway -- a no-op here
    // rather than trying to fold it into promptZoneNumberEdit()'s
    // numeric-renumbering flow.
    if (S.editingZoneNumbers) return;
    oppoZone.classList.add('flash');
    setTimeout(function () { oppoZone.classList.remove('flash'); }, 220);
    if (navigator.vibrate) navigator.vibrate(8);
    // Nominal board position only, for openZone()'s existing
    // fieldCoordinates computation to run unchanged -- the fieldZone id
    // ('oppo') itself is what marks this as "position not meaningfully
    // known," not these numbers, so nothing downstream should ever treat
    // them as a real, precise shot location.
    openZone('oppo', { x: 14.5, y: 12 });
  }, false);

  el('xgtQ').onclick = openClock;
  el('xgtT').onclick = toggleClock;
  el('xgtExitBtn').onclick = function () { API.close(); };
  scrim.addEventListener('click', function () {
    var f = S.onScrim; if (f) { S.onScrim = null; f(); } else closeSheet();
  });
}
/* Tracks the currently VISIBLE portion of #stageWrap, not a fixed
   half-field bounding box -- #stageWrap's own screen position/size stay
   constant while scrolling (only its CONTENT scrolls inside it, via
   native scrollTop), so this correctly follows whatever the coach has
   scrolled to without needing to know where that is. */
/* Widens the field view to also show the colored deck margin bands on
   each side (2m of decorative color-coded area beyond the playable
   pool, which Studio's own Front Court sizing deliberately excludes
   elsewhere to maximize the playable area's screen space -- correct
   for other uses, but the coach specifically wants these visible here
   since they help with reading the field). Widens all four of Studio's
   own field SVG viewBoxes symmetrically (2 units added on each side,
   0 to 24 instead of 2 to 22) and correspondingly widens #board's own
   CSS width to preserve the pool's actual on-screen scale -- capped at
   the available screen width so this can only make the pool appear
   very slightly smaller on narrow screens, never overflow off-screen.
   Board/zone/arrow/shot-block rotation transforms are untouched: they
   apply to the rotated group, not the viewBox, so widening the visible
   window into that already-rotated content doesn't need to change them. */
var _fieldViewWidened = false;
function showFullVenueWidth() {
  if (!frontCourtActive || _fieldViewWidened) return;
  var board = document.getElementById('board');
  if (!board || typeof fieldSvg === 'undefined' || !fieldSvg) return;
  var svgs = [fieldSvg, (typeof fieldZonesSvg !== 'undefined' ? fieldZonesSvg : null),
              (typeof arrows !== 'undefined' ? arrows : null), (typeof shotBlockSvg !== 'undefined' ? shotBlockSvg : null)];
  var vb = (fieldSvg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  if (vb.length !== 4) return;
  var oldW = vb[2];
  var newW = (typeof M !== 'undefined' && M.H) ? M.H : (oldW + 4); // fall back to +4 (2 each side) if M isn't reachable for some reason
  if (newW <= oldW) return;
  svgs.forEach(function (svgEl) {
    if (!svgEl) return;
    var v = (svgEl.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    if (v.length !== 4) return;
    svgEl.setAttribute('viewBox', '0 ' + v[1] + ' ' + newW + ' ' + v[3]);
  });
  var oldBoardW = parseFloat(board.style.width) || 0;
  if (oldBoardW > 0) {
    board.dataset.xgtOrigWidth = board.style.width;
    var scale = newW / oldW;
    // Capped against #stageWrap's own actual available width, not the
    // raw window width -- stageWrap can sit narrower than the full
    // viewport (page padding, sidebar space on wider layouts), and it
    // clips overflow rather than scrolling horizontally, so a cap based
    // on window.innerWidth alone let the widened board run past
    // stageWrap's real right edge, cropping that side's band off.
    var wrapEl = document.getElementById('stageWrap');
    var maxW = wrapEl ? wrapEl.getBoundingClientRect().width : (window.innerWidth - 14);
    board.style.width = Math.min(oldBoardW * scale, maxW) + 'px';
  }
  _fieldViewWidened = true;
}
function restoreVenueWidth() {
  if (!_fieldViewWidened) return;
  var board = document.getElementById('board');
  if (board && board.dataset.xgtOrigWidth) { board.style.width = board.dataset.xgtOrigWidth; delete board.dataset.xgtOrigWidth; }
  _fieldViewWidened = false;
  // The viewBoxes themselves don't need restoring here -- the very next
  // toggleFrontCourt()/fitBoardToScreen() call (which happens on close,
  // restoring whatever Front Court state was active before) sets them
  // correctly from scratch regardless of what this left behind.
}
function positionShield() {
  // #stageWrap uses position:relative in Studio's own normal (non-
  // tracker) layout, starting near the top of the page under Studio's
  // own slim header -- it has no idea the tracker's own top chrome bar
  // now overlays the first ~150px of that. viewportHeight() above
  // already corrected #stageWrap's SIZE for this, but never its
  // POSITION, leaving its top portion hidden behind the tracker's chrome
  // and an equal-sized dead gap of empty space at the bottom instead.
  // top on position:relative is an offset FROM wherever the element
  // would normally sit, not an absolute target -- so this briefly clears
  // any existing offset to measure the true baseline position first,
  // then computes exactly how far down it needs to move to start right
  // where the chrome ends, rather than guessing a fixed number.
  var wrap = document.getElementById('stageWrap');
  if (wrap) {
    if (S.active) {
      var topBar = el('xgtTop');
      var chromeH = topBar ? topBar.getBoundingClientRect().height : 0;
      var hadOffset = wrap.style.top;
      wrap.style.top = '';
      var baselineTop = wrap.getBoundingClientRect().top;
      var needed = chromeH - baselineTop;
      wrap.style.top = Math.max(0, needed) + 'px';
    } else if (wrap.style.top) {
      wrap.style.top = '';
    }
  }
  var sh = el('xgtShield');
  if (!sh || !wrap) return;
  var r = wrap.getBoundingClientRect();
  sh.style.left = r.left + 'px'; sh.style.top = r.top + 'px';
  sh.style.width = r.width + 'px'; sh.style.height = r.height + 'px';
  // Same "keyhole" clip-path technique Studio's own spotlight overlay
  // already uses for this exact problem (see
  // updateSpotlightOverlayScrollGap): without it, the shield -- built
  // specifically to swallow every pointer event so no Studio tool can
  // fire during tracking -- would also swallow Studio's own legitimate
  // scroll-drag zones underneath it, and swiping to scroll would
  // silently do nothing. Carving these two strips out of the shield's
  // hit-test region lets pointer events pass through to Studio's real
  // scroll zones there, while the rest of the shield still captures
  // every tap for zone selection as before.
  var leftZone = document.getElementById('fcScrollZoneLeft'), rightZone = document.getElementById('fcScrollZoneRight');
  if (leftZone && rightZone && leftZone.style.display === 'block') {
    var leftW = leftZone.getBoundingClientRect().width, rightW = rightZone.getBoundingClientRect().width;
    sh.style.clipPath = 'inset(0 ' + rightW + 'px 0 ' + leftW + 'px)';
  } else {
    sh.style.clipPath = '';
  }
  // #xgtBlock sits directly beneath the shield, full-viewport, for the
  // same reason (blocking everything outside the field area too) --
  // needs the identical gap cut into it, or it would swallow the drag
  // on its own even with the shield's own hole already in place.
  var block = el('xgtBlock');
  if (block) block.style.clipPath = sh.style.clipPath;
  positionOppoZone();
}
// Screen-space positioning for the OPPO dome, computed via the exact
// same board->screen math boardToClient() already uses elsewhere in this
// module -- verified empirically against the live rotate/translate
// transform before this was written, rather than derived from the
// transform algebra by inspection, since getting this wrong would put
// the marker somewhere visually nonsensical without necessarily causing
// any error to surface.
function positionOppoZone() {
  var oz = el('xgtOppoZone');
  if (!oz) return;
  var c = boardToClient(14.5, 12); // the far edge, centred on the visible half's width
  if (!c) { oz.style.display = 'none'; return; }
  oz.style.display = S.active ? 'flex' : 'none';
  oz.style.left = (c.x - 65) + 'px'; // 130px wide, centred on c.x
  oz.style.top = c.y + 'px'; // flat top edge sits at the boundary; the dome bulges downward into the visible half
}
function onViewportChange() {
  // A real resize/orientation change re-runs Studio's own sizing (via
  // the same settle-in path open() uses), which resets the viewBoxes to
  // their normal, un-widened state -- re-widen afterward so rotating
  // the device doesn't quietly lose the deck bands.
  if (S.active && window.MIZE && window.MIZE.Field && window.MIZE.Field.fitBoardToScreen) {
    try { window.MIZE.Field.fitBoardToScreen(); } catch (err) {}
    _fieldViewWidened = false;
    showFullVenueWidth();
    xgtCorrectStageWrapOverlap();
    // Studio's own general resize handler (unrelated to this module,
    // fires on the same 'resize' event) debounces its own
    // fitBoardToScreen() call by 150ms -- that later call re-applies
    // Studio's internal 220px floor and silently overwrites the
    // correction just above. Confirmed directly: without this, the
    // correction visibly took effect for a moment and then reverted a
    // beat later. Re-applying once more after that debounce window has
    // had time to settle makes this correction the one that's actually
    // still in effect once everything's done moving, rather than a
    // race that depends on exactly which handler happens to run last.
    setTimeout(xgtCorrectStageWrapOverlap, 220);
  }
  positionShield();
}
var shieldTick = null;
function watchShield(on) {
  clearInterval(shieldTick);
  var wrap = document.getElementById('stageWrap');
  if (!on) {
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('orientationchange', onViewportChange);
    if (wrap) wrap.removeEventListener('scroll', positionShield);
    return;
  }
  positionShield();
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);
  // Native scroll (Front Court's own drag-to-scroll, see
  // wireFrontCourtScrollZoneDrag) doesn't move #stageWrap itself, so the
  // shield's position never actually needs to change on scroll -- this
  // listener exists for the rare case something else nudges scroll
  // programmatically. The poll below is the real safety net for
  // anything neither this nor resize/orientationchange catches (Studio
  // re-fitting the board on its own schedule, for instance).
  if (wrap) wrap.addEventListener('scroll', positionShield);
  shieldTick = setInterval(positionShield, 700);
}
function removeChrome() {
  watchShield(false);
  ['xgtBlock', 'xgtShield', 'xgtOppoZone', 'xgtRoot', 'xgtScrim', 'xgtSheet', 'xgtToast', 'xgtStats'].forEach(function (id) {
    var n = el(id); if (n) n.remove();
  });
}
var toastT = null;
function toast(msg) {
  var t = el('xgtToast'); if (!t) return;
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 1900);
}

/* ===================================================================== sheet */
function sheetEl() { return el('xgtSheet'); }
function openSheet() { sheetEl().classList.add('on'); el('xgtScrim').classList.add('on'); }
function closeSheet() {
  sheetEl().classList.remove('on'); el('xgtScrim').classList.remove('on');
  S.draft = null; S.onScrim = null;
}
function head(title, crumb, backFn) {
  return '<div class="xgtGrab"></div><div class="xgtHd">' +
    (backFn ? '<button class="xgtIcon" id="xgtBack">‹</button>' : '') +
    '<div style="flex:1;min-width:0"><div class="z">' + title + '</div><div class="cr">' + crumb + '</div></div>' +
    '<button class="xgtIcon" id="xgtX">✕</button></div>';
}
function wire(backFn) {
  var b = el('xgtBack'); if (b) b.onclick = backFn;
  el('xgtX').onclick = closeSheet;
}

// Personal Foul (any variant -- regular exclusion, exclusion+substitution,
// penalty, or brutality all share the same action:'exclusion', per real
// water polo rules where all of these are sub-types of one foul category)
// and Goal both genuinely stop play; everything else doesn't.
function xgtStopsPlay(action, outcome, blockResult) { return action === 'exclusion' || outcome === 'goal' || blockResult === 'gk_out' || blockResult === 'fp_out'; }
function openZone(zoneId, board) {
  // Blocks the one entry point both the main shield and the OPPO zone
  // funnel through -- covers both without needing the same guard
  // duplicated at each call site. Roster-based foul logging (renderBar)
  // deliberately stays available even here; only field-position
  // tracking is blocked, since there's no meaningful "where on the
  // field" once regulation is over.
  if (S.regulationEnded) { toast('Regulation is over \u2014 log any post-game fouls from the roster below, or continue to the shootout.'); return; }
  var z = zoneById(zoneId);
  // The clock is deliberately NOT paused here. An earlier version of
  // this paused immediately on every tap and resumed once logging
  // finished -- correct for a goal or foul, but it meant something like
  // a blocked shot (which never actually stops play) still lost however
  // many real seconds the coach spent picking "Shot" then "Blocked",
  // however brief. Instead, just the clock value AT this exact moment
  // is remembered on the draft; the clock itself keeps running,
  // untouched, for the entire selection sequence, however long it
  // takes. Once the outcome is actually known, commitDraft() below
  // decides: for a stopping outcome, the displayed clock jumps back to
  // this remembered value and stops there -- an accurate correction for
  // the moment the goal/foul actually happened, not whenever the coach
  // finished entering the details. For anything else, nothing happens
  // at all -- the clock was already right the whole time.
  S.draft = {
    clockAtTapTime: S.clock,
    fieldZone: z.id,
    fieldZoneName: zoneNum(z), // per-device-overridable display number -- see zoneNum
    fieldCoordinates: {
      bx: +board.x.toFixed(2), by: +board.y.toFixed(2),                 // board metres
      fx: +(board.x - 2).toFixed(2), fy: +(board.y - 2).toFixed(2),     // field-of-play metres
      nx: +((board.x - 2) / 25).toFixed(4), ny: +((board.y - 2) / 20).toFixed(4),
      space: 'MIZE.Field', zoneSet: 'offense+outer'
    },
    // Field-player/goalkeeper (coach or parent) now both mean "track one
    // specific player" -- the tracked player IS the actor for every event,
    // same as parent mode always worked. Only "team" mode has a real squad
    // to ask "who did this" about. This used to only check
    // trackingMode==='parent', which was correct back when coach+field
    // meant squad tracking -- now that coach+field is single-player too,
    // singlePlayerMode() is what keeps this correct for both cases
    // without duplicating the actor-setup logic.
    actor: singlePlayerMode()
      ? { side: S.playerRole === 'goalkeeper' ? 'opp' : 'us', number: S.me.number }
      : null,
    useGkTree: singlePlayerMode() && S.playerRole === 'goalkeeper',
    goalkeeper: (singlePlayerMode() && S.playerRole === 'goalkeeper') ? S.me.number : null,
    targetGoal: (singlePlayerMode() && S.playerRole === 'goalkeeper') ? 'own' : 'opponent',
    action: null, outcome: null, dc: 'drawn', goalPlacement: null
  };
  openSheet();
  // Only "team" mode has a real squad to pick from now -- field-player/
  // goalkeeper (coach or parent) track one specific player, so there's no
  // "who did this" choice to make; the tracked player IS the actor.
  if (S.trackingMode === 'coach' && S.playerRole === 'team') stepPlayer(); else stepAction();
}

function stepPlayer() {
  var oppTracked = S.opponentTracked;
  var ourNums = S.water;
  var oppNums = oppTracked ? S.oppWater : [];
  // A disqualified player is auto-removed from the water the instant
  // it happens (see xgtCheckDisqualification), so in practice they
  // wouldn't appear in these lists at all -- this stays purely as a
  // defensive backstop for whatever edge case might leave a number
  // here anyway.
  var ourDq = xgtDisqualifiedSet('us'), oppDq = xgtDisqualifiedSet('opp');
  sheetEl().innerHTML = head('Zone ' + S.draft.fieldZoneName, 'Who?', null) +
    '<span class="xgtLbl">' + xgtTeamLabel('us') + '</span>' +
    '<div class="xgtNums">' + (ourNums.length
      ? ourNums.map(function (n) { return '<button class="xgtNum' + xgtDqClass(ourDq, n) + '" data-us-n="' + n + '">' + xgtKeeperLabel(n) + '</button>'; }).join('')
      : '<p class="xgtNote" style="margin:2px 0">No players currently in the water.</p>') + '</div>' +
    '<span class="xgtLbl" style="margin-top:10px;display:block">' + xgtTeamLabel('opp') + '</span>' +
    (oppTracked
      ? '<div class="xgtNums">' + (oppNums.length
          ? oppNums.map(function (n) { return '<button class="xgtNum' + xgtDqClass(oppDq, n) + '" data-opp-n="' + n + '">' + n + '</button>'; }).join('')
          : '<p class="xgtNote" style="margin:2px 0">No opponent players currently in the water.</p>') + '</div>'
      : '<button class="xgtOpt c" id="xgtOpp" style="width:100%"><span class="dot"></span>' + xgtTeamLabel('opp', 'full') + '</button>') +
    '<div style="height:9px"></div>' +
    '<button class="xgtBtn" id="xgtBenchExclusionBtn" style="width:100%">Bench exclusion (referee only)</button>';
  wire(null);
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-us-n]'), function (b) {
    b.onclick = function () { selectTeamActor('us', +b.dataset.usN); };
  });
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-opp-n]'), function (b) {
    b.onclick = function () { selectTeamActor('opp', +b.dataset.oppN); };
  });
  var oppBtn = el('xgtOpp');
  if (oppBtn) oppBtn.onclick = function () { selectTeamActor('opp', null); };
  el('xgtBenchExclusionBtn').onclick = stepBenchExclusion;
}

// Single point where a team-mode actor gets fully set up, regardless of
// which side or whether they were tapped from the water grid or the
// generic Opponent fallback (used when detailed opponent tracking isn't
// enabled). Team mode always uses the unified FIELD_PLAYER_ACTIONS tree
// now, for either side -- useGkTree stays false here deliberately, so
// stepAction()'s existing useGkTree actor-overwrite (still needed,
// untouched, for single-player goalkeeper-tracking mode) never fires for
// team-mode events and doesn't fight with the actor already set here.
function selectTeamActor(side, number) {
  S.draft.actor = { side: side, number: number };
  S.draft.useGkTree = false;
  // Whichever side is acting, the OTHER side's current keeper is the one
  // actually facing this action -- e.g. our player shooting faces their
  // keeper, not ours -- so shot outcomes attribute to the right
  // goalkeeper's stats automatically.
  S.draft.goalkeeper = currentKeeper(side === 'us' ? 'opp' : 'us');
  S.draft.targetGoal = side === 'us' ? 'opponent' : 'own';
  stepAction();
}

// Referee-only edge case: a player can be excluded from the bench
// (unsportsmanlike conduct, bench-area misconduct) without having been
// in the water for this play at all. Deliberately its own path rather
// than folded into the water-only grids above -- a bench player can only
// ever be committing a foul, never drawing one, and isn't a valid actor
// for shot/steal/turnover in the first place. Skips straight to the
// existing outcome step (stepOutcome) rather than through stepAction()'s
// action-type picker, since which action type applies here is never in
// question.
function stepBenchExclusion() {
  var ourBench = S.squad.filter(function (n) { return S.water.indexOf(n) < 0; });
  var oppBench = S.opponentTracked ? S.oppSquad.filter(function (n) { return S.oppWater.indexOf(n) < 0; }) : [];
  var ourDq = xgtDisqualifiedSet('us'), oppDq = xgtDisqualifiedSet('opp');
  sheetEl().innerHTML = head('Zone ' + S.draft.fieldZoneName, 'Bench exclusion \u2014 who?', stepPlayer) +
    '<p class="xgtNote" style="margin:0 0 8px">For referee-issued exclusions on a player who wasn\u2019t in the water for this play.</p>' +
    '<span class="xgtLbl">' + xgtTeamLabel('us') + '</span>' +
    '<div class="xgtNums">' + (ourBench.length
      ? ourBench.map(function (n) { return '<button class="xgtNum' + xgtDqClass(ourDq, n) + '" data-bench-us="' + n + '">' + xgtKeeperLabel(n) + '</button>'; }).join('')
      : '<p class="xgtNote" style="margin:2px 0">No bench players.</p>') + '</div>' +
    '<span class="xgtLbl" style="margin-top:10px;display:block">' + xgtTeamLabel('opp') + '</span>' +
    (S.opponentTracked
      ? '<div class="xgtNums">' + (oppBench.length
          ? oppBench.map(function (n) { return '<button class="xgtNum' + xgtDqClass(oppDq, n) + '" data-bench-opp="' + n + '">' + n + '</button>'; }).join('')
          : '<p class="xgtNote" style="margin:2px 0">No opponent bench players.</p>') + '</div>'
      // No opponent roster entered at all -- fall back to a manual
      // number entry, the same pattern used elsewhere in this module
      // when there's no known squad to pick from (assist entry,
      // shootout shooter number).
      : '<div class="xgtRow"><input class="xgtField" id="xgtBenchOppNum" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" placeholder="#" style="flex:0 0 90px;text-align:center;font-size:19px;font-weight:700"></div>' +
        '<button class="xgtBtn pri" id="xgtBenchOppOk" style="margin-top:8px">Confirm</button>');
  wire(stepPlayer);
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-bench-us]'), function (b) {
    b.onclick = function () { commitBenchExclusion('us', +b.dataset.benchUs); };
  });
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-bench-opp]'), function (b) {
    b.onclick = function () { commitBenchExclusion('opp', +b.dataset.benchOpp); };
  });
  var oppOk = el('xgtBenchOppOk');
  if (oppOk) oppOk.onclick = function () {
    var n = parseInt((el('xgtBenchOppNum').value || ''), 10);
    commitBenchExclusion('opp', n || null);
  };
}
function commitBenchExclusion(side, number) {
  S.draft.actor = { side: side, number: number };
  S.draft.useGkTree = false;
  S.draft.goalkeeper = currentKeeper(side === 'us' ? 'opp' : 'us');
  S.draft.targetGoal = side === 'us' ? 'opponent' : 'own';
  S.draft.action = 'exclusion'; S.draft.actionLabel = 'Personal Foul';
  S.draft.dc = 'committed'; // a bench player can only ever be committing the foul, never drawing one -- pre-set as the sensible default, though still visible/changeable on the outcome screen's own dc toggle like any other exclusion
  stepOutcome();
}

function stepAction() {
  var gk = S.playerRole === 'goalkeeper', t = tree();
  // Back only makes sense if stepPlayer() is actually where we came from
  // -- true only in team mode now (was "any coach mode" back when
  // coach+field meant squad tracking too).
  var back = (S.trackingMode === 'coach' && S.playerRole === 'team') ? stepPlayer : null;
  var crumb = gk ? ('Opponent action from here — #' + S.me.number + ' in goal')
    : ((S.draft.actor.side === 'opp'
        ? (S.draft.actor.number != null ? 'Opponent #' + S.draft.actor.number : 'Opponent')
      : (S.trackingMode === 'parent' ? '#' + S.me.number + (S.me.name ? ' ' + S.me.name : '') : '#' + S.draft.actor.number)) + ' — what happened?');
  var attr = '';
  // Same Mine/Team-mate/Opponent attribution parent mode always had --
  // now also offered for coach+field/goalkeeper, since those are the
  // same "single tracked player, but the rest of the game still
  // happens" situation parent mode already handles this way. "Team-mate"
  // is just a generic marker (no squad lookup involved), so this
  // extends safely to a coach with no roster entered at all.
  if (singlePlayerMode() && !gk) {
    attr = '<div class="xgtSeg" id="xgtAttr">' +
      '<button data-a="us" aria-pressed="' + (S.draft.actor.side === 'us') + '">#' + S.me.number + ' mine</button>' +
      '<button data-a="team" aria-pressed="' + (S.draft.actor.side === 'team') + '">Team-mate</button>' +
      '<button data-a="opp" aria-pressed="' + (S.draft.actor.side === 'opp') + '">' + xgtTeamLabel('opp', 'full') + '</button></div>';
  }
  sheetEl().innerHTML = head('Zone ' + S.draft.fieldZoneName, crumb, back) + attr +
    '<div class="xgtOpts">' + t.map(function (a) {
      return '<button class="xgtOpt ' + a.cls + '" data-a="' + a.id + '"><span class="dot"></span><span>' + a.label +
        (a.sub ? '<span class="sub">' + a.sub + '</span>' : '') + '</span></button>';
    }).join('') + '</div>';
  wire(back);
  var seg = el('xgtAttr');
  if (seg) Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
    b.onclick = function () {
      S.draft.actor = { side: b.dataset.a, number: b.dataset.a === 'us' ? S.me.number : null };
      stepAction();
    };
  });
  Array.prototype.forEach.call(sheetEl().querySelectorAll('.xgtOpts [data-a]'), function (b) {
    b.onclick = function () {
      var act = null, i;
      for (i = 0; i < t.length; i++) if (t[i].id === b.dataset.a) act = t[i];
      S.draft.action = act.id; S.draft.actionLabel = act.label;
      S.draft.variant = null; S.draft.variantLabel = null;
      if (S.draft.useGkTree) {
        // Steals, exclusions and turnovers here are the keeper's own; a shot
        // belongs to the opponent who took it.
        var own = (act.id !== 'shot');
        var num = S.draft.goalkeeper != null ? S.draft.goalkeeper : S.me.number;
        S.draft.actor = own ? { side: 'us', number: num } : { side: 'opp', number: null };
      }
      if (act.terminal) {
        S.draft.outcome = act.id; S.draft.outcomeLabel = act.label;
        if (!act.dc) S.draft.dc = null;
        finish();
      } else if (act.variants) stepVariant();
      else stepOutcome();
    };
  });
}

function stepVariant() {
  var t = tree(), a = null, i;
  for (i = 0; i < t.length; i++) if (t[i].id === S.draft.action) a = t[i];
  sheetEl().innerHTML = head('Zone ' + S.draft.fieldZoneName, a.label + ' — what kind?', stepAction) +
    '<div class="xgtOpts">' + a.variants.map(function (v) {
      return '<button class="xgtOpt ' + v.cls + '" data-v="' + v.id + '"><span class="dot"></span>' + v.label + '</button>';
    }).join('') + '</div>';
  wire(stepAction);
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-v]'), function (b) {
    b.onclick = function () {
      var v = null, j;
      for (j = 0; j < a.variants.length; j++) if (a.variants[j].id === b.dataset.v) v = a.variants[j];
      S.draft.variant = v.id; S.draft.variantLabel = v.label;
      stepOutcome();
    };
  });
}

function stepOutcome() {
  var t = tree(), a = null, i;
  for (i = 0; i < t.length; i++) if (t[i].id === S.draft.action) a = t[i];
  // Always the player tapped first who committed it -- no "drawn by /
  // committed by" choice anymore, per confirmed direction. The
  // counterpart step right after this (stepFoulCounterpart) always
  // asks who drew it instead, since that's the only direction left
  // that ever needs a second player at all.
  if (a.dc) S.draft.dc = 'committed';
  var back = a.variants ? stepVariant : stepAction;
  sheetEl().innerHTML = head('Zone ' + S.draft.fieldZoneName,
      (S.draft.variantLabel ? S.draft.variantLabel : a.label) + ' — outcome', back) +
    '<div class="xgtOpts ' + (a.children.length < 3 ? 'one' : '') + '">' + a.children.map(function (c) {
      return '<button class="xgtOpt ' + c.cls + '" data-s="' + c.id + '"><span class="dot"></span><span>' + c.label +
        (c.sub ? '<span class="sub">' + c.sub + '</span>' : '') + '</span></button>';
    }).join('') + '</div>';
  wire(back);
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-s]'), function (b) {
    b.onclick = function () {
      var c = null, j;
      for (j = 0; j < a.children.length; j++) if (a.children[j].id === b.dataset.s) c = a.children[j];
      S.draft.outcome = c.id; S.draft.outcomeLabel = c.label;
      S.draft.scores = c.scores || null; // captured here since c (the matched tree node) isn't available later at finish() -- this is the source of truth for "did this represent OUR team scoring" (field-player shot->goal has scores:'us'; goalkeeper shot->goal has scores:'opp', since that's the OPPONENT scoring on our tracked keeper)
      if (!a.dc) S.draft.dc = null;
      if (c.placement) stepPlacement(c); else finish();
    };
  });
}

function buildGoalSvg(mode, noBlock) {
  var G = GOALG, miss = mode === 'miss';
  var targets = miss ? MISS_TARGETS : IN_TARGETS;
  if (miss && noBlock) targets = targets.filter(function (t) { return !t.block; });
  var box = miss ? '24 0 552 294' : '130 86 340 130';
  var cells = targets.map(function (t) {
    var cx = t.x + t.w / 2, cy = t.y + t.h / 2, label;
    if (t.rot) {
      label = '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" transform="rotate(-90 ' + cx + ' ' + cy + ')">' + t.svg + '</text>';
    } else if (Object.prototype.toString.call(t.svg) === '[object Array]') {
      label = '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle">' +
        t.svg.map(function (line, i) {
          return '<tspan x="' + cx + '" dy="' + (i === 0 ? '-0.1em' : '1.2em') + '">' + line + '</tspan>';
        }).join('') + '</text>';
    } else {
      label = '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle">' + t.svg + '</text>';
    }
    return '<g class="gz ' + (t.frame ? 'frame' : '') + (t.block ? ' block' : '') + ' ' + (t.sm ? 'sm' : '') +
      '" data-p="' + t.id + '" data-l="' + t.label + '">' +
      '<rect class="gh" x="' + (t.x + 1.5) + '" y="' + (t.y + 1.5) + '" width="' + (t.w - 3) + '" height="' + (t.h - 3) + '" rx="5"/>' + label + '</g>';
  }).join('');
  // Finer mesh -- 16 columns x 8 rows, previously 8x4 -- a visually
  // smaller net weave, per confirmed direction.
  var net = '<g opacity="' + (miss ? '.3' : '.45') + '" stroke="rgba(255,255,255,.55)" stroke-width=".8">';
  for (var i = 1; i <= 15; i++) net += '<line x1="' + (G.mouth.x + i * G.mouth.w / 16) + '" y1="' + G.mouth.y + '" x2="' + (G.mouth.x + i * G.mouth.w / 16) + '" y2="' + (G.mouth.y + G.mouth.h) + '"/>';
  for (i = 1; i <= 7; i++) net += '<line x1="' + G.mouth.x + '" y1="' + (G.mouth.y + i * G.mouth.h / 8) + '" x2="' + (G.mouth.x + G.mouth.w) + '" y2="' + (G.mouth.y + i * G.mouth.h / 8) + '"/>';
  net += '</g>';
  // One continuous ring -- the outer frame rectangle minus the inner
  // mouth rectangle, evenodd -- rather than three separate rounded
  // rects (left post/crossbar/right post) each with their own border.
  // Both rects share the same bottom edge (a goal has no bottom bar),
  // so this naturally comes out U-shaped with no extra logic needed.
  // Used for both modes: in "miss" mode it sits UNDER the three
  // (now invisible-by-default, see .gz.frame .gh) post/crossbar tap
  // targets, so the frame reads as one rectangular, sharp-edged shape
  // with no seam between them -- only the active/flash state on tap
  // reveals which specific zone was actually hit. In "in" mode it's
  // still purely decorative, same as before, just sharp-cornered now
  // instead of three separately rounded pieces.
  var frameOutline = '<path class="gzFrameOutline" fill-rule="evenodd" d="M' +
    G.frame.x + ',' + G.frame.y + ' H' + (G.frame.x + G.frame.w) + ' V' + (G.frame.y + G.frame.h) + ' H' + G.frame.x + ' Z M' +
    G.mouth.x + ',' + G.mouth.y + ' H' + (G.mouth.x + G.mouth.w) + ' V' + (G.mouth.y + G.mouth.h) + ' H' + G.mouth.x + ' Z"/>';
  // when the in-cage target is suppressed, show the inert panel again so the
  // frame still reads as a cage rather than a hole
  var dead = (miss && noBlock)
    ? '<rect class="xgtDead" x="' + G.mouth.x + '" y="' + G.mouth.y + '" width="' + G.mouth.w +
      '" height="' + G.mouth.h + '"/><text x="300" y="' + (G.mouth.y + G.mouth.h / 2 + 4) +
      '" text-anchor="middle" font-size="11" font-weight="700" fill="#d5dede" opacity=".7">CAGE</text>'
    : '';
  return '<svg class="xgtGoal" viewBox="' + box + '" preserveAspectRatio="xMidYMid meet">' +
    '<rect x="0" y="0" width="600" height="400" fill="#124d4d"/>' +
    '<line x1="30" y1="' + G.waterY + '" x2="570" y2="' + G.waterY + '" stroke="rgba(255,255,255,.55)" stroke-width="2.5" opacity=".7"/>' +
    net + frameOutline + dead + cells + '</svg>';
}
function stepPlacement(c) {
  var miss = c.placement === 'miss';
  // A penalty is strictly one-on-one by rule -- no field defender can
  // legally be involved, same reasoning as useGkTree's goalkeeper-
  // tracking mode already gets right (that tree has its own dedicated
  // "Defender Block" outcome instead, making the miss-grid's in-cage
  // option redundant there too).
  var noBlock = !!(S.draft.useGkTree || S.draft.variant === 'penalty');
  sheetEl().innerHTML = head('Zone ' + S.draft.fieldZoneName,
      miss ? (c.label + ' — where did it miss?') : (c.label + ' — where in the goal?'), stepOutcome) +
    '<p class="xgtNote" style="margin:0 0 6px">' + (miss
      ? (noBlock
          ? 'Tap where it went — post, bar, wide or short.'
          : 'Tap where the ball went — post, bar, or wide. If a field player blocked it on the way in, tap inside the cage.')
      : 'Roughly where in the goal? Skip if you are not sure — speed beats completeness.') + '</p>' +
    buildGoalSvg(miss ? 'miss' : 'in', noBlock) +
    '<button class="xgtBtn" id="xgtSkip">Skip placement</button>';
  wire(stepOutcome);
  Array.prototype.forEach.call(sheetEl().querySelectorAll('.gz'), function (g) {
    g.addEventListener('click', function () {
      g.classList.add('flash');
      if (navigator.vibrate) navigator.vibrate(8);
      S.draft.goalPlacement = { grid: miss ? 'miss' : '3x3', area: g.dataset.p, label: g.dataset.l };
      setTimeout(finish, 90);
    });
  });
  el('xgtSkip').onclick = finish;
}
function finish() {
  var d = S.draft;
  var isTeamMode = S.trackingMode === 'coach' && S.playerRole === 'team';
  // Paid-tier only. Fires for a goal scored by EITHER side now, not just
  // "us" -- !d.useGkTree is the correct source of truth here, not
  // d.scores, since team mode's unified FIELD_PLAYER_ACTIONS tree always
  // carries scores:'us' on its goal node regardless of which side
  // actually scored (actor.side is what actually distinguishes them, the
  // same way scoreOf() already treats it as authoritative). useGkTree
  // stays true only for single-player goalkeeper-tracking mode's "the
  // untracked opponent scored on our known keeper" case, where there's
  // no opponent roster to meaningfully ask about anyway -- excluded here
  // exactly as before. variant!=='penalty' excluded too -- a penalty is
  // a direct, unassisted attempt by rule, so there's genuinely no
  // assist question to ask. The guard flag prevents stepAssist()'s own
  // buttons -- which call finish() again once an assist is picked or
  // skipped -- from re-triggering this same prompt.
  if (d.outcome === 'goal' && !d.useGkTree && d.variant !== 'penalty' && xgtHasAdvancedActions() && !d.assistStepShown) {
    d.assistStepShown = true;
    stepAssist();
    return;
  }
  // Team mode only, matching this whole redesign's confirmed scope.
  // Fires for any personal-foul outcome regardless of how it was
  // reached, including the referee-only bench-exclusion path, since a
  // bench exclusion still earns a specific opposing player a power play
  // just the same as one drawn in open play. This includes Penalty and
  // Brutality -- who EARNED the penalty (their own personal-foul stats,
  // who drew it) and who actually SHOOTS the resulting penalty are two
  // separate facts, not one: the shooter isn't necessarily the player
  // who was fouled. A prior version of this skipped this step for
  // Penalty/Brutality on the mistaken assumption that the shooter
  // screen made it redundant -- it doesn't. What actually makes this
  // "automatic" is that finish() still auto-continues straight into
  // the penalty shot flow the moment this step is done, rather than
  // requiring the coach to separately go find and open that screen.
  if (isTeamMode && d.action === 'exclusion' && xgtHasAdvancedActions() && !d.foulCounterpartStepShown) {
    d.foulCounterpartStepShown = true;
    stepFoulCounterpart();
    return;
  }
  // Universal -- any blocked shot or field-defender deflection, either
  // side, either tracking mode. Deliberately fires BEFORE the
  // goalkeeper-possession step below, which only makes sense once it's
  // known the ball actually stayed with our own keeper -- if it went
  // out, or a field defender (not the keeper) made the block, there's
  // no possession/outlet-pass question to ask at all. Covers both
  // 'blocked' and 'def_block' -- the goalkeeper-tracking tree already
  // distinguishes which one made the save via those two separate
  // outcome values, so stepBlockResult() only asks "did it go out"
  // there; the field-player/team-mode tree has no such distinction
  // (only 'blocked' exists), so it asks both "who" and "did it go out"
  // together. See stepBlockResult() itself for exactly which question
  // gets shown, and why.
  if (d.action === 'shot' && (d.outcome === 'blocked' || d.outcome === 'def_block') && xgtHasAdvancedActions() && !d.blockResultStepShown) {
    d.blockResultStepShown = true;
    stepBlockResult();
    return;
  }
  // "What happens to the ball next" is just as open a question whether
  // the block was made by the goalkeeper or a field defender, and
  // whether it was our shot or theirs that got kept in play -- the
  // ball didn't go out and didn't cleanly reach either team in any of
  // these cases. Previously scoped "own-team-only" (only fired for our
  // own keeper's save against their shot), which left three of the
  // four shooter/blocker combinations with no follow-up at all. Per
  // confirmed direction, this now fires for all of them alike.
  //
  // A shot that hits the post or crossbar is exactly as live as a save
  // that's kept in play -- it didn't go out and didn't cleanly reach
  // the other team either, so what happens to it next is just as open
  // a question, in either shooting direction.
  var keptInPlay = d.outcome === 'blocked' && (d.blockResult === 'gk_in' || d.blockResult === 'fp_in');
  var hitFrame = d.action === 'shot' && d.outcome === 'missed' && d.goalPlacement &&
    ['post_left', 'crossbar', 'post_right'].indexOf(d.goalPlacement.area) >= 0;
  if (isTeamMode && (keptInPlay || hitFrame) && xgtHasAdvancedActions() && !d.possessionStepShown) {
    d.possessionStepShown = true;
    stepPossession();
    return;
  }
  if (isTeamMode && d.possession === 'rebound_own' && !d.reboundFollowupShown) {
    d.reboundFollowupShown = true;
    stepReboundFollowup();
    return;
  }
  // Outlet-pass tracking keeps its own, separate, deliberate
  // own-team-only scope even though the possession question above no
  // longer does -- it's specifically about OUR keeper's own outlet-pass
  // patterns, so it still only fires when actor.side==='opp' (their
  // shot, our keeper actually the one holding it), regardless of which
  // direction the possession question itself just fired for.
  var goalieHasBall = (d.possession === 'goalie' || (d.possession === 'rebound_own' && d.reboundFollowup === 'pass_back')) && d.actor.side === 'opp';
  // A goalkeeper steal gives our keeper the ball just as a save does,
  // and the outlet-pass question is the same: where does it go from here?
  // goalieHasBall cannot fire for steal because a steal sets actor.side
  // to 'us' (the keeper is our player who made the steal), not 'opp',
  // so steal needs its own trigger. Two cases:
  //   1. Single-player goalkeeper mode (useGkTree=true): every action in
  //      the GK tree that isn't 'shot' belongs to our keeper by definition,
  //      so steal always means our keeper got the ball.
  //   2. Team mode (useGkTree=false): the actor could be any player on
  //      either side, so check explicitly that it is our own keeper via
  //      currentKeeper('us'). Opponent goalkeeper steals are excluded --
  //      their keeper's outlet patterns aren't what we're tracking here.
  var goalieStole = d.action === 'steal' && (
    d.useGkTree ||
    (d.actor && d.actor.side === 'us' && d.actor.number === currentKeeper('us'))
  );
  var zone = d.fieldZone, zoneName = d.fieldZoneName;
  commitDraft();
  // Chained AFTER the blocked-shot event above has already committed,
  // not folded into it -- opens a fresh, independent draft/commit cycle
  // for the outlet pass itself, so it gets its own real timestamp at
  // whatever moment the coach actually finishes selecting it, rather
  // than inheriting the block's. See openOutletPass() for why this
  // matters (the eventual 3-second-window analysis this is captured
  // for).
  if (goalieHasBall || goalieStole) openOutletPass(zone, zoneName);
}
function commitDraft() {
  var d = S.draft;
  closeSheet();
  // Rewind BEFORE commit(), not after -- commit() stamps the event with
  // whatever S.clock currently holds, so the correction has to happen
  // first for the event itself to carry the right time, not just the
  // display. For a stopping outcome, this jumps the clock back to
  // whatever it was the instant the coach first tapped the zone (see
  // openZone()) and stops it there; for anything else, S.clock is left
  // exactly as it is, since it's already been ticking accurately the
  // whole time and never needed touching at all.
  if (xgtStopsPlay(d.action, d.outcome, d.blockResult)) {
    S.clock = d.clockAtTapTime;
    if (S.running) { S.running = false; clearInterval(S.tick); }
    paintClock();
  }
  var ev = commit({
    actor: d.actor, fieldZone: d.fieldZone, fieldZoneName: d.fieldZoneName,
    fieldCoordinates: d.fieldCoordinates,
    action: d.action, actionLabel: d.actionLabel,
    variant: d.variant || null, variantLabel: d.variantLabel || null,
    outcome: d.outcome, outcomeLabel: d.outcomeLabel,
    goalkeeper: d.goalkeeper || null, targetGoal: d.targetGoal || null,
    goalPlacement: d.goalPlacement, assist: d.assist != null ? d.assist : null,
    foulCounterpart: d.foulCounterpart || null,
    possession: d.possession || null, reboundFollowup: d.reboundFollowup || null,
    blockResult: d.blockResult || null,
    context: { kind: 'action', trackingMode: S.trackingMode, dc: d.dc || null,
               tree: d.useGkTree ? 'gk' : 'field', note: null }
  });
  if (navigator.vibrate) navigator.vibrate([6, 28, 6]);
  // A Penalty or a Brutality foul both guarantee a penalty shot as the
  // very next action -- opens straight into logging it rather than
  // leaving the coach to find their own way there, since it's not
  // actually optional what happens next.
  if (ev.action === 'exclusion' && (ev.outcome === 'penalty' || ev.outcome === 'brutality')) {
    var fouledSide = xgtFouledSide(ev);
    if (fouledSide) openRegularPenalty(fouledSide);
  }
}
// Which side actually gets the resulting penalty shot: the side that
// DREW the foul. Only the side itself is needed here, not the specific
// drawing player -- any player from that side's water roster may
// legally take the shot, and the foul-counterpart step can be skipped
// entirely (leaving the specific player unknown) without that mattering.
function xgtFouledSide(ev) {
  if (!ev.actor) return null;
  if (ev.context && ev.context.dc === 'drawn') return ev.actor.side;
  if (ev.context && ev.context.dc === 'committed') return ev.actor.side === 'us' ? 'opp' : 'us';
  return null;
}
// Only the shooter-selection screen is bespoke here -- everything
// after that hands off entirely to the SAME pipeline a normal field-
// zone-tapped shot goes through: stepOutcome() -> stepPlacement() ->
// finish()'s full chain (assist/block-result/possession/rebound) ->
// commitDraft(). Deliberately NOT a simplified, standalone copy of
// that logic the way the shootout's own openShootout() is -- that
// gets away with it only because a shootout attempt has no live-ball
// aftermath to ask about at all; a penalty during regular play very
// much does (a save that's kept in play, or a post/crossbar hit,
// still needs "what happens next" resolved exactly like any other
// shot). variant:'penalty' on the draft is what the small, targeted
// checks in stepPlacement()/stepBlockResult()/finish() key off of to
// know a field-defender block is impossible and an assist can never
// apply here, without duplicating any of the rest of that machinery.
function openRegularPenalty(side) {
  var roster = side === 'us' ? S.water : (S.opponentTracked ? S.oppWater : []);
  // Genuinely can happen for the opponent's side if opponent tracking
  // was never turned on -- same tap-a-number-instead-of-typing-one
  // fallback the shootout uses in the identical situation, just without
  // a persistent declared-roster step, since this is one single shot,
  // not a whole repeating sequence worth asking about just once upfront.
  var fallback = !roster.length;
  var dq = xgtDisqualifiedSet(side === 'us' ? 'us' : 'opp');
  drawShooter();

  function drawShooter() {
    // openSheet() re-adds the 'on' class that commitDraft()'s closeSheet()
    // just removed -- without this, the HTML below was being generated
    // correctly but the sheet itself stayed transformed off-screen,
    // invisible, since nothing ever told it to slide back into view.
    // Same pattern openOutletPass() already uses correctly for the
    // identical situation (a new draft/screen opened right after a
    // prior one just committed, rather than continuing an existing one).
    openSheet();
    sheetEl().innerHTML = head('Penalty (5 m)', xgtTeamLabel(side, 'possessive') + ' penalty \u2014 who\u2019s shooting?', null) +
      '<div class="xgtNums" id="xgtRegPenShooters">' + (fallback
        ? Array.apply(null, { length: 20 }).map(function (_, i) { return i + 1; }).map(function (n) {
            return '<button class="xgtNum" data-reg-pen-shooter="' + n + '">' + n + '</button>';
          }).join('')
        : roster.map(function (n) {
            return '<button class="xgtNum' + xgtDqClass(dq, n) + '" data-reg-pen-shooter="' + n + '">' + xgtKeeperLabel(n) + '</button>';
          }).join('')) + '</div>';
    el('xgtX').onclick = function () { closeSheet(); };
    Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-reg-pen-shooter]'), function (b) {
      b.onclick = function () {
        var number = +b.dataset.regPenShooter;
        // Same shape openZone() builds for a normal tapped shot, minus
        // the field-position-specific bits (fieldZone/fieldCoordinates)
        // a penalty genuinely doesn't have. fieldZoneName still gets a
        // real value so every downstream header ("Zone " + ...) reads
        // sensibly rather than showing "Zone undefined".
        S.draft = {
          clockAtTapTime: S.clock,
          fieldZone: null, fieldZoneName: 'Penalty',
          fieldCoordinates: null,
          actor: { side: side, number: number },
          useGkTree: false,
          goalkeeper: currentKeeper(side === 'us' ? 'opp' : 'us'),
          targetGoal: side === 'us' ? 'opponent' : 'own',
          action: 'shot', actionLabel: 'Shot',
          variant: 'penalty', variantLabel: 'Penalty',
          outcome: null, outcomeLabel: null, dc: null, goalPlacement: null
        };
        stepOutcome();
      };
    });
  }
}
// ============================================================= outlet pass
// Own-team-only, per confirmed scope: this whole sequence only fires
// after a block by OUR keeper (see finish()'s trigger condition). Asks
// what happens to the ball right after the block; if it ends up back
// with the goalie -- directly, or via a rebound that gets passed back --
// finish() chains into openOutletPass() below as a genuinely separate,
// later-committed event.
// Two genuinely different questions depending on which tree produced
// this block, not one question with a context-dependent label -- the
// field-player/team-mode tree (FIELD_PLAYER_ACTIONS) has a single
// 'blocked' outcome with no idea who actually made the stop, so it has
// to ask both who and what happened. The goalkeeper-tracking tree
// (GOALKEEPER_ACTIONS) already knows -- 'blocked' only ever means the
// keeper, 'def_block' only ever means a field defender -- so asking who
// again there would just be redundant. Either path lands on the same
// four possible d.blockResult values (gk_in/gk_out/fp_in/fp_out), so
// everything downstream (xgtStopsPlay, commitDraft's rewind check)
// never needs to know or care which question was actually shown.
// Per confirmed water polo rules: the goalkeeper stopping a shot that
// then goes out is a corner throw for the attacking team; a field
// defender doing the same is a change of possession (a "goalie ball")
// to the defending team instead -- not the same outcome, and not a
// judgment call to leave to the coach.
function stepBlockResult() {
  var d = S.draft;
  var knownBlocker = d.outcome === 'def_block' ? 'fp' : ((d.useGkTree || d.variant === 'penalty') ? 'gk' : null);
  if (knownBlocker) {
    var label = knownBlocker === 'gk' ? 'Save' : 'Defender block';
    var outLabel = knownBlocker === 'gk' ? 'Went out \u2014 Corner throw' : 'Went out \u2014 Goalie ball';
    sheetEl().innerHTML = head('Zone ' + d.fieldZoneName, label + ' \u2014 did it go out, or stay in play?', null) +
      '<div class="xgtOpts one">' +
        '<button class="xgtOpt g" data-br="' + knownBlocker + '_in"><span class="dot"></span>Stayed in play</button>' +
        '<button class="xgtOpt c" data-br="' + knownBlocker + '_out"><span class="dot"></span>' + outLabel + '</button>' +
      '</div>';
  } else {
    sheetEl().innerHTML = head('Zone ' + d.fieldZoneName, 'Blocked \u2014 who, and did it go out?', null) +
      '<div class="xgtOpts one">' +
        '<button class="xgtOpt g" data-br="gk_in"><span class="dot"></span>Goalkeeper \u2014 stayed in play</button>' +
        '<button class="xgtOpt c" data-br="gk_out"><span class="dot"></span>Goalkeeper \u2014 went out (Corner throw)</button>' +
        '<button class="xgtOpt w" data-br="fp_in"><span class="dot"></span>Field defender \u2014 stayed in play</button>' +
        '<button class="xgtOpt c" data-br="fp_out"><span class="dot"></span>Field defender \u2014 went out (Goalie ball)</button>' +
      '</div>';
  }
  el('xgtX').onclick = function () { closeSheet(); };
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-br]'), function (b) {
    b.onclick = function () { d.blockResult = b.dataset.br; finish(); };
  });
}
function stepPossession() {
  var d = S.draft;
  // Named explicitly (Us/Them) rather than relative (our/the other) --
  // this now fires for a shot either team took, so "our team" would
  // read backwards exactly half the time otherwise. Values stay
  // relative to the DEFENDING side, same meaning as before
  // (actor.side==='opp' means THEY shot, so WE'RE the defenders here).
  var defenderLabel = xgtTeamLabel(d.actor.side === 'opp' ? 'us' : 'opp');
  var shooterLabel = xgtTeamLabel(d.actor.side === 'opp' ? 'opp' : 'us');
  sheetEl().innerHTML = head('Zone ' + d.fieldZoneName, 'Blocked! What happens to the ball?', null) +
    '<div class="xgtOpts one">' +
      '<button class="xgtOpt g" data-poss="goalie"><span class="dot"></span>' + defenderLabel + ' goalie keeps possession</button>' +
      '<button class="xgtOpt c" data-poss="rebound_opp"><span class="dot"></span>Rebound \u2014 to ' + shooterLabel + '</button>' +
      '<button class="xgtOpt w" data-poss="rebound_own"><span class="dot"></span>Rebound \u2014 to ' + defenderLabel + '</button>' +
    '</div>';
  el('xgtX').onclick = function () { closeSheet(); };
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-poss]'), function (b) {
    b.onclick = function () { d.possession = b.dataset.poss; finish(); };
  });
}
function stepReboundFollowup() {
  var d = S.draft;
  var defenderLabel = d.actor.side === 'opp' ? 'our' : 'their';
  sheetEl().innerHTML = head('Zone ' + d.fieldZoneName, 'Rebound to ' + defenderLabel + ' team \u2014 then what?', null) +
    '<div class="xgtOpts one">' +
      '<button class="xgtOpt g" data-rf="pass_back"><span class="dot"></span>Passed back to the goalie</button>' +
      '<button class="xgtOpt c" data-rf="player_keeps"><span class="dot"></span>Player keeps possession</button>' +
    '</div>';
  el('xgtX').onclick = function () { closeSheet(); };
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-rf]'), function (b) {
    b.onclick = function () { d.reboundFollowup = b.dataset.rf; finish(); };
  });
}
// A fresh, independent draft cycle -- NOT a continuation of the
// just-committed blocked-shot draft, which is already gone (closeSheet()
// cleared it inside commitDraft() before this runs). This is what lets
// the outlet-pass event get its own, separate, real timestamp at
// whatever moment the coach actually finishes selecting it -- makeEvent()
// always stamps quarter/gameClock/timestamp from the CURRENT S.q/S.clock
// at commit time, so a genuinely later, separate commit() call here
// naturally reflects however much real time has passed since the block,
// which is exactly what the eventual "did the next exclusion/goal land
// within 3 seconds of this outlet pass" analysis needs to work from.
// goalkeeper is re-derived fresh via currentKeeper('us') rather than
// copied from the block's own d.goalkeeper -- if a sub happened between
// the block and this moment (however unlikely mid-play), this reflects
// whoever is actually in goal right now.
function openOutletPass(fieldZone, fieldZoneName) {
  S.draft = {
    fieldZone: fieldZone, fieldZoneName: fieldZoneName,
    goalkeeper: currentKeeper('us'),
    outletType: null, outletTypeLabel: null,
    outletOutcome: null, outletOutcomeLabel: null
  };
  openSheet();
  stepOutletType();
}
var OUTLET_TYPES = { lead: 'Lead Pass', dry: 'Dry Pass', wet: 'Wet Pass' };
var OUTLET_OUTCOMES = { advantage_goal: 'Advantage / Goal', regular: 'Regular Possession', turnover: 'Turnover' };
function stepOutletType() {
  var d = S.draft;
  sheetEl().innerHTML = head('Zone ' + d.fieldZoneName, 'Outlet pass \u2014 what kind?', null) +
    '<div class="xgtOpts">' +
      '<button class="xgtOpt b" data-ot="lead"><span class="dot"></span>Lead Pass</button>' +
      '<button class="xgtOpt b" data-ot="dry"><span class="dot"></span>Dry Pass</button>' +
      '<button class="xgtOpt b" data-ot="wet"><span class="dot"></span>Wet Pass</button>' +
    '</div>';
  el('xgtX').onclick = function () { closeSheet(); };
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-ot]'), function (b) {
    b.onclick = function () {
      d.outletType = b.dataset.ot; d.outletTypeLabel = OUTLET_TYPES[b.dataset.ot];
      stepOutletOutcome();
    };
  });
}
function stepOutletOutcome() {
  var d = S.draft;
  sheetEl().innerHTML = head('Zone ' + d.fieldZoneName, d.outletTypeLabel + ' \u2014 outcome', stepOutletType) +
    '<div class="xgtOpts">' +
      '<button class="xgtOpt g" data-oo="advantage_goal"><span class="dot"></span>Advantage / Goal</button>' +
      '<button class="xgtOpt b" data-oo="regular"><span class="dot"></span>Regular Possession</button>' +
      '<button class="xgtOpt c" data-oo="turnover"><span class="dot"></span>Turnover</button>' +
    '</div>';
  wire(stepOutletType);
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-oo]'), function (b) {
    b.onclick = function () {
      d.outletOutcome = b.dataset.oo; d.outletOutcomeLabel = OUTLET_OUTCOMES[b.dataset.oo];
      finishOutletPass();
    };
  });
}
function finishOutletPass() {
  var d = S.draft;
  closeSheet();
  commit({
    actor: { side: 'us', number: d.goalkeeper },
    fieldZone: d.fieldZone, fieldZoneName: d.fieldZoneName,
    action: 'outlet_pass', actionLabel: 'Outlet Pass', // deliberately distinct from the older, simpler 'outlet' action (single-player goalkeeper mode's own completed/turnover pair) -- different outcome vocabulary entirely, so reusing that id would silently misattribute or drop these events in any stats code keyed to the old outcome set
    variant: d.outletType, variantLabel: d.outletTypeLabel,
    outcome: d.outletOutcome, outcomeLabel: d.outletOutcomeLabel,
    goalkeeper: d.goalkeeper,
    context: { kind: 'action', trackingMode: S.trackingMode, dc: null, note: null }
  });
  if (navigator.vibrate) navigator.vibrate([6, 28, 6]);
}
// Team mode (a real, known roster) gets a chip-picker matching this
// module's established visual language elsewhere; single-player modes
// (no roster to pick from at all) get a plain manual number entry, same
// pattern as the shootout panel's shooter-number field. Which roster to
// draw from -- ours or the opponent's -- now depends on which side
// actually scored (d.actor.side), not unconditionally S.water, since an
// assist can only ever come from the SCORER's own teammates. Falls back
// to manual entry if the scoring side is the opponent and detailed
// opponent tracking isn't enabled (no roster to pick from there either).
function stepAssist() {
  var d = S.draft;
  var isTeamMode = S.trackingMode === 'coach' && S.playerRole === 'team';
  var scorerSide = d.actor && d.actor.side;
  var scorerNum = d.actor && d.actor.number;
  var rosterWater = (isTeamMode && scorerSide === 'opp') ? S.oppWater : S.water;
  var hasRoster = isTeamMode && (scorerSide === 'opp' ? S.opponentTracked : true);
  var assistDq = xgtDisqualifiedSet(scorerSide === 'opp' ? 'opp' : 'us');
  sheetEl().innerHTML = head('Zone ' + d.fieldZoneName, 'Goal! Who assisted?', null) +
    (hasRoster
      ? '<div class="xgtChips" id="xgtAssistChips">' +
        rosterWater.filter(function (n) { return n !== scorerNum; }).map(function (n) {
          return '<button class="xgtChip' + xgtDqClass(assistDq, n) + '" data-assist="' + n + '">' + xgtKeeperLabel(n) + '</button>';
        }).join('') + '</div>'
      : '<span class="xgtLbl">Assist\u2019s cap number</span>' +
        '<div class="xgtRow"><input class="xgtField" id="xgtAssistNum" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" ' +
        'placeholder="#" style="flex:0 0 90px;text-align:center;font-size:19px;font-weight:700"></div>' +
        '<button class="xgtBtn pri" id="xgtAssistOk" style="margin-top:8px">Confirm</button>') +
    '<button class="xgtBtn" id="xgtAssistSkip" style="margin-top:10px">No assist / skip</button>';
  el('xgtX').onclick = function () { closeSheet(); };
  if (hasRoster) {
    Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-assist]'), function (b) {
      b.onclick = function () { d.assist = +b.dataset.assist; finish(); };
    });
  } else {
    el('xgtAssistOk').onclick = function () {
      var n = parseInt((el('xgtAssistNum').value || ''), 10);
      d.assist = n || null;
      finish();
    };
  }
  el('xgtAssistSkip').onclick = function () { d.assist = null; finish(); };
}
// Team mode only. After a personal-foul outcome, asks which specific
// player on the OTHER team drew it -- the actor already selected is
// always the one who committed it now (no more drawn/committed
// choice), so the counterpart's role is never in question. Same
// roster-or-manual-entry pattern as stepAssist() above: chips from the
// other side's water when a real roster exists for them, otherwise a
// manual number entry.
function stepFoulCounterpart() {
  var d = S.draft;
  var otherSide = d.actor.side === 'us' ? 'opp' : 'us';
  var otherWater = otherSide === 'opp' ? S.oppWater : S.water;
  var hasRoster = otherSide === 'opp' ? S.opponentTracked : true;
  var question = 'Who drew this?';
  var fcDq = xgtDisqualifiedSet(otherSide);
  sheetEl().innerHTML = head('Zone ' + d.fieldZoneName, question, null) +
    (hasRoster
      ? '<div class="xgtChips" id="xgtFoulChips">' +
        otherWater.map(function (n) {
          return '<button class="xgtChip' + xgtDqClass(fcDq, n) + '" data-fc="' + n + '">' + xgtKeeperLabel(n) + '</button>';
        }).join('') + '</div>'
      : '<span class="xgtLbl">' + xgtTeamLabel(otherSide, 'possessive') + ' cap number</span>' +
        '<div class="xgtRow"><input class="xgtField" id="xgtFoulNum" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" ' +
        'placeholder="#" style="flex:0 0 90px;text-align:center;font-size:19px;font-weight:700"></div>' +
        '<button class="xgtBtn pri" id="xgtFoulOk" style="margin-top:8px">Confirm</button>') +
    '<button class="xgtBtn" id="xgtFoulSkip" style="margin-top:10px">Unknown / skip</button>';
  el('xgtX').onclick = function () { closeSheet(); };
  if (hasRoster) {
    Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-fc]'), function (b) {
      b.onclick = function () { d.foulCounterpart = { side: otherSide, number: +b.dataset.fc }; finish(); };
    });
  } else {
    el('xgtFoulOk').onclick = function () {
      var n = parseInt((el('xgtFoulNum').value || ''), 10);
      d.foulCounterpart = n ? { side: otherSide, number: n } : null;
      finish();
    };
  }
  el('xgtFoulSkip').onclick = function () { d.foulCounterpart = null; finish(); };
}

/* ===================================================================== clock */
function toggleClock() {
  S.running = !S.running;
  clearInterval(S.tick);
  if (S.running) S.tick = setInterval(function () {
    S.clock = Math.max(0, S.clock - 1);
    if (!S.clock) {
      S.running = false; clearInterval(S.tick);
      // Automatic, per confirmed scope -- the exact moment Q4's clock
      // reaches 0:00 is when regulation is considered over. Sticky
      // (only ever set here, on this specific transition) and does a
      // full render() immediately so the game-over banner and the
      // field-blocking guard in openZone() both take effect the instant
      // this happens, not on whatever the next unrelated render was
      // going to be.
      if (S.q >= 4 && !S.regulationEnded) { S.regulationEnded = true; render(); }
    }
    paintClock();
  }, 1000);
  paintClock();
}
function paintClock() {
  var t = el('xgtT'); if (!t) return;
  t.textContent = fmt(S.clock);
  t.className = S.running ? 'run' : '';
  el('xgtQ').textContent = 'Q' + S.q + ' ✎';
}
function openClock() {
  var wasRunning = S.running;
  S.running = false; clearInterval(S.tick); paintClock();
  var before = { q: S.q, clock: S.clock };
  S.onScrim = cancel;
  draw(); openSheet();
  function draw() {
    sheetEl().innerHTML = head('Set the time', 'Match the pool clock, then Done', null) +
      '<span class="xgtLbl">Quarter</span><div class="xgtChips" style="margin-bottom:14px">' +
      [1, 2, 3, 4].map(function (n) {
        return '<button class="xgtChip" data-q="' + n + '" aria-pressed="' + (S.q === n) + '" style="flex:1">Q' + n + '</button>';
      }).join('') +
      // Shootout lives here, right after Q4, rather than as a separate
      // persistent button elsewhere -- "what period is it" (including
      // "we've moved past regulation into the shootout") is exactly the
      // same kind of decision as picking a quarter, so it belongs where
      // a coach would naturally look for it.
      '<button class="xgtChip" id="xgtSoChip" aria-pressed="' + (shootoutAttempts().length > 0) + '" style="flex:1">SO</button></div>' +
      '<span class="xgtLbl">Clock remaining</span><div class="xgtTdisp" id="xgtTd">' + fmt(S.clock) + '</div>' +
      '<div class="xgtTgrid">' +
        '<button class="xgtStep" data-d="60">+1:00</button><button class="xgtStep" data-d="10">+0:10</button>' +
        '<button class="xgtStep" data-d="1">+0:01</button><button class="xgtStep" data-d="-60">−1:00</button>' +
        '<button class="xgtStep" data-d="-10">−0:10</button><button class="xgtStep" data-d="-1">−0:01</button></div>' +
      '<div class="xgtRow" style="margin-bottom:10px">' +
        '<button class="xgtBtn" id="xgtRe">Reset to 8:00</button><button class="xgtBtn" id="xgtZe">Set to 0:00</button></div>' +
      '<button class="xgtBtn pri" id="xgtDone">Done</button>' +
      '<p class="xgtNote">Events already logged keep their own timestamps.</p>';
    el('xgtX').onclick = cancel;
    Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-q]'), function (b) {
      b.onclick = function () { S.q = +b.dataset.q; draw(); };
    });
    el('xgtSoChip').onclick = function () {
      // A genuinely different transition than picking a quarter -- closes
      // this sheet and opens the shootout panel directly, rather than
      // treating "SO" as a numeric quarter value. Deliberately does NOT
      // resume the main clock even if it was running before this sheet
      // opened: entering the shootout means regulation is over.
      closeSheet();
      openShootout();
    };
    Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-d]'), function (b) {
      b.onclick = function () {
        S.clock = Math.max(0, Math.min(99 * 60, S.clock + (+b.dataset.d)));
        el('xgtTd').textContent = fmt(S.clock); paintClock();
      };
    });
    el('xgtRe').onclick = function () { S.clock = QLEN; el('xgtTd').textContent = fmt(S.clock); paintClock(); };
    el('xgtZe').onclick = function () { S.clock = 0; el('xgtTd').textContent = fmt(S.clock); paintClock(); };
    el('xgtDone').onclick = done;
  }
  function cancel() { S.q = before.q; S.clock = before.clock; paintClock(); closeSheet(); resume(); }
  function done() {
    closeSheet();
    if (S.q !== before.q || S.clock !== before.clock) {
      commit({ context: { kind: 'clock', trackingMode: S.trackingMode, dc: null, note: 'manual correction' } });
    }
    paintClock(); resume();
  }
  function resume() { if (wasRunning) toggleClock(); }
}
// Phase G: penalty shootout tracking, deliberately separate from the
// normal zone-tap flow -- a shootout alternates fixed one-on-one
// attempts with no meaningful field position, so the full zone/variant/
// placement flow built for live-play shots would be friction without
// adding anything real. Reuses the exact same shot-event shape
// (action:'shot', variant:'penalty') the normal flow already produces,
// just tagged with context.shootout:true -- that one flag is what
// actionEvents()/xgtStatsBodyParts() key off to keep these out of
// regular shooting stats and the main 4-quarter score, rather than
// needing any separate tracking system.
function shootoutTally() {
  var us = 0, them = 0;
  S.events.forEach(function (e) {
    if (!e.context || !e.context.shootout || e.outcome !== 'goal') return;
    if (e.actor && e.actor.side === 'them') them++; else us++;
  });
  return { us: us, them: them };
}
function shootoutAttempts() {
  return S.events.filter(function (e) { return e.context && e.context.shootout; });
}
// Whose turn it is is always derived, never its own separate flag --
// even count of attempts so far means the side that started is up
// again, odd means the other side. Nothing to keep in sync, nothing
// that can drift.
function shootoutCurrentSide() {
  if (!S.shootoutStartSide) return null;
  var n = shootoutAttempts().length;
  return (n % 2 === 0) ? S.shootoutStartSide : (S.shootoutStartSide === 'us' ? 'them' : 'us');
}
// How many times THIS specific player has already shot -- the source
// for the three-shade highlight below. Naturally handles "the same 5
// shooters repeat in round 2, 3..." without any explicit round-tracking
// state of its own, since it's just a per-player count derived from the
// events already logged.
function shootoutShotCount(side, number) {
  return shootoutAttempts().filter(function (e) { return e.actor && e.actor.side === side && e.actor.number === number; }).length;
}
function shootoutHighlightClass(count) {
  return count ? ('soShot' + (((count - 1) % 3) + 1)) : '';
}
// The 5 official shooters aren't declared upfront -- they're simply
// whichever 5 distinct players a side's coach actually taps first,
// established naturally as the shootout is logged rather than through
// a separate pre-declaration step. Once 5 have shot, this list is
// fixed for the rest of the shootout (no 6th or 7th player should be
// offered), and it's what round 2+ reuses to know who's up.
function shootoutDesignatedShooters(side) {
  var order = [];
  shootoutAttempts().forEach(function (e) {
    if (e.actor && e.actor.side === side && order.indexOf(e.actor.number) < 0 && order.length < 5) {
      order.push(e.actor.number);
    }
  });
  return order;
}
// Only meaningful once all 5 are established (round 1's own order is
// the coach's free choice as it happens, nothing to suggest yet) --
// from there, cycles through that same fixed order every time this
// side comes back up, so round 2's first shooter is round 1's first
// shooter, and so on. A suggestion only, not an enforced restriction --
// every shooter chip stays tappable regardless, per direct confirmation
// that even an already-shot player should remain reachable rather than
// being locked out.
function shootoutSuggestedShooter(side) {
  var designated = shootoutDesignatedShooters(side);
  if (designated.length < 5) return null;
  var sideAttempts = shootoutAttempts().filter(function (e) { return e.actor && e.actor.side === side; }).length;
  return designated[sideAttempts % 5];
}
// Standard shootout math: 5 shooters per side to start (the official
// number -- not configurable here, matching the confirmed rule), then
// sudden death one shot each, same order, repeating. Decided as soon as
// the trailing side can no longer catch up given only what's left in
// the CURRENT phase -- this is what lets it resolve early, mid-round,
// the instant enough misses make the rest moot, not only once a full
// round of 5-a-side (or a full sudden-death pair) has actually played
// out.
function shootoutIsDecided() {
  var ROUND = 5;
  var attempts = shootoutAttempts();
  var n = attempts.length;
  if (!n) return { decided: false, winner: null };
  var tally = shootoutTally();
  if (n <= ROUND * 2) {
    // Still inside (or exactly finishing) the initial round -- compare
    // each side's actual best-possible final tally, using only the
    // attempts each one has genuinely got left in this round, against
    // the other side's CURRENT score. No assumption that both sides
    // have taken an equal number of shots yet.
    var usTaken = attempts.filter(function (e) { return e.actor && e.actor.side === 'us'; }).length;
    var themTaken = n - usTaken;
    var usMax = tally.us + (ROUND - usTaken);
    var themMax = tally.them + (ROUND - themTaken);
    if (tally.us > themMax) return { decided: true, winner: 'us' };
    if (tally.them > usMax) return { decided: true, winner: 'them' };
    return { decided: false, winner: null };
  }
  // Sudden death: exactly one shot each per round. A single shot from
  // just one side never resolves anything on its own -- only checked
  // once both sides have taken their attempt for this round (an even
  // count of attempts beyond the initial 10), same as the real rule
  // ("if not, the second shooters shoot again and THEN the outcome
  // gets checked").
  var beyond = n - ROUND * 2;
  if (beyond % 2 !== 0) return { decided: false, winner: null };
  if (tally.us === tally.them) return { decided: false, winner: null };
  return { decided: true, winner: tally.us > tally.them ? 'us' : 'them' };
}
// YYYYMMDD_myteam_opponent[_optional note], per the confirmed naming
// convention -- date with dashes stripped, both team names falling back
// to the same defaults used everywhere else if left blank, an optional
// trailing note only appended if the coach actually provided one.
function xgtBuildSessionName(suffix) {
  var dateStr = (S.game.date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  var home = (S.game.home || 'My Team').trim();
  var away = (S.game.away || 'Opponent').trim();
  var base = dateStr + '_' + home + '_' + away;
  var extra = (suffix || '').trim();
  return extra ? (base + '_' + extra) : base;
}
// Shared by all three ways a game actually ends: the shootout resolving,
// regulation ending outright with no shootout needed, and the coach
// manually tapping End & Save. finishPromptShown guards against asking
// twice in the same session -- once the coach has answered (whether
// "yes, finish" or "not yet"), render() calling this again on every
// subsequent commit shouldn't re-open the same question.
async function xgtOfferToFinishGame(force) {
  if (S.finishPromptShown && !force) return;
  S.finishPromptShown = true;
  closeSheet(); // closes whatever's open -- the shootout screen in particular, per the confirmed requirement that it should close once decided, not stay open alongside this prompt
  var sc = scoreOf();
  var hadShootout = shootoutAttempts().length > 0;
  var soTally = hadShootout ? shootoutTally() : null;
  var summary = xgtTeamLabel('us') + ' ' + sc[0] + ' \u2013 ' + sc[1] + ' ' + xgtTeamLabel('them') +
    (hadShootout ? ' (shootout ' + soTally.us + '\u2013' + soTally.them + ')' : '');
  var ok = await MizeDialog.confirm('The game is over \u2014 ' + summary + '. Finish and save this session?', 'Game Finished');
  if (!ok) return; // not ready to close it out yet -- everything else about the game (events, score, officiallyEnded staying false) is untouched, so play can continue or this can be finished later via End & Save
  var suffix = await MizeDialog.prompt('Add a note to the file name (optional):', '');
  S.cloudSessionName = xgtBuildSessionName(suffix);
  S.officiallyEnded = true;
  // The local save always happens regardless of what the cloud sync does --
  // this is just about telling the coach honestly whether it also actually
  // reached the Coaching Library, rather than claiming that unconditionally
  // when it may well not have.
  var syncResult = S.events.length ? await syncSessionToCloud() : { status: 'skipped', reason: 'no-events' };
  save();
  var name = '\u201c' + S.cloudSessionName + '\u201d';
  var message;
  if (syncResult.status === 'success') {
    message = 'Saved as ' + name + '. You can find it later in the Coaching Library.';
  } else if (syncResult.status === 'error') {
    message = 'Saved as ' + name + ' on this device. Uploading to the Coaching Library didn\u2019t go through just now, but it\u2019ll keep retrying automatically.';
  } else if (syncResult.reason === 'signed-out') {
    message = 'Saved as ' + name + ' on this device. Sign in to also save it to your Coaching Library.';
  } else if (syncResult.reason === 'no-entitlement') {
    message = 'Saved as ' + name + ' on this device. Cloud session storage isn\u2019t included in your current plan, so it won\u2019t appear in the Coaching Library.';
  } else {
    message = 'Saved as ' + name + ' on this device.';
  }
  await MizeDialog.alert(message, 'Session Saved');
  API.close();
}
function openShootout() {
  // Asked once, the very first time -- never again after that. Everyone
  // after this alternates automatically per shootoutCurrentSide() above.
  if (!S.shootoutStartSide) { drawStart(); openSheet(); return; }
  // A side with no water roster (opponent tracking wasn't enabled,
  // most likely) has no chips to offer as shooters at all -- rather
  // than falling back to typing a cap number every single attempt,
  // this is asked once, tap-only, right here, and reused as that
  // side's shooter grid for the rest of the shootout.
  if (needsRosterDeclare('us')) { drawDeclareRoster('us'); openSheet(); return; }
  if (needsRosterDeclare('them')) { drawDeclareRoster('them'); openSheet(); return; }
  // Defaults to each side's primary declared keeper the first time this
  // actually renders -- freely changeable afterward, per shot, since a
  // backup keeper subbing in specifically for this is real and expected.
  if (S.shootoutGoalkeepers.us == null) S.shootoutGoalkeepers.us = (S.keepers && S.keepers[0]) != null ? S.keepers[0] : null;
  if (S.shootoutGoalkeepers.them == null) S.shootoutGoalkeepers.them = (S.oppKeepers && S.oppKeepers[0]) != null ? S.oppKeepers[0] : null;
  drawMain(); openSheet();

  function needsRosterDeclare(side) {
    var known = side === 'us' ? S.water : S.oppWater;
    return known.length === 0 && S.shootoutRoster[side].length === 0;
  }

  function drawDeclareRoster(side) {
    var chosen = S.shootoutRoster[side];
    sheetEl().innerHTML = head('Penalty Shootout', xgtTeamLabel(side, 'possessive') + ' shootout lineup', null) +
      '<p class="xgtNote" style="margin-top:0">No roster was tracked for ' + (side === 'us' ? 'us' : 'them') +
      ' during the game -- tap every cap number who could shoot, just this once. Five is typical; the same list is reused for the whole shootout, including any repeat rounds.</p>' +
      '<div class="xgtChips" id="xgtSoDeclare">' + Array.apply(null, { length: 20 }).map(function (_, i) {
        var n = i + 1;
        return '<button class="xgtChip" data-so-declare="' + n + '" aria-pressed="' + (chosen.indexOf(n) >= 0) + '">' + n + '</button>';
      }).join('') + '</div>' +
      '<button class="xgtBtn pri" id="xgtSoDeclareGo" style="margin-top:14px"' + (chosen.length ? '' : ' disabled') + '>Continue</button>';
    sheetEl().scrollTop = 0;
    el('xgtX').onclick = function () { closeSheet(); };
    Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-so-declare]'), function (b) {
      b.onclick = function () {
        var n = +b.dataset.soDeclare, i = chosen.indexOf(n);
        if (i >= 0) chosen.splice(i, 1); else chosen.push(n);
        chosen.sort(function (a, b2) { return a - b2; });
        drawDeclareRoster(side);
      };
    });
    var go = el('xgtSoDeclareGo');
    if (go) go.onclick = function () { openShootout(); };
  }

  function drawStart() {
    sheetEl().innerHTML = head('Penalty Shootout', 'Who shoots first?', null) +
      '<p class="xgtNote" style="margin-top:0">Decided once, right now -- every attempt after this alternates automatically, no need to pick a side each time.</p>' +
      '<div class="xgtRow" style="margin-top:10px">' +
        '<button class="xgtBtn pri" id="xgtSoStartUs" style="flex:1">' + xgtTeamLabel('us') + '</button>' +
        '<button class="xgtBtn" id="xgtSoStartThem" style="flex:1">' + xgtTeamLabel('them') + '</button></div>';
    el('xgtX').onclick = function () { closeSheet(); };
    el('xgtSoStartUs').onclick = function () { S.shootoutStartSide = 'us'; openShootout(); };
    el('xgtSoStartThem').onclick = function () { S.shootoutStartSide = 'them'; openShootout(); };
  }

  function drawMain() {
    var tally = shootoutTally();
    var attempts = shootoutAttempts().slice().reverse();
    var side = shootoutCurrentSide();
    var decided = shootoutIsDecided();
    // Once decided, this screen is blocking-only: shows the outcome and
    // the attempts log, and immediately re-offers the finish flow
    // (harmless if already answered once, since that flow's own guard
    // stops it from re-prompting) rather than leaving the shooter grid
    // and goalkeeper selector live. This replaces the earlier design,
    // which deliberately kept shooting available even once the math
    // was settled -- since changed, per direct confirmation that a
    // decided shootout should block every further action instead.
    if (decided.decided) {
      xgtOfferToFinishGame();
      var doneAttempts = shootoutAttempts().slice().reverse();
      sheetEl().innerHTML = head('Penalty Shootout', 'Log each attempt as it happens', null) +
        '<div style="text-align:center;font-size:22px;font-weight:800;margin:6px 0 14px">' + xgtTeamLabel('us') + ' ' + tally.us + ' \u2013 ' + tally.them + ' ' + xgtTeamLabel('them') + '</div>' +
        '<div class="soDecidedBanner">Shootout decided \u2014 ' + xgtTeamLabel(decided.winner) + ' win</div>' +
        (doneAttempts.length
          ? '<span class="xgtLbl" style="margin-top:16px">Attempts</span>' +
            '<div class="xgtCard"><table>' + doneAttempts.map(function (e) {
              var sideLabel = xgtTeamLabel(e.actor && e.actor.side === 'them' ? 'them' : 'us');
              return '<tr><td>' + sideLabel + '</td><td>#' + (e.actor ? e.actor.number : '?') + '</td><td>' + (e.outcomeLabel || '') + '</td></tr>';
            }).join('') + '</table></div>'
          : '');
      el('xgtX').onclick = function () { closeSheet(); };
      sheetEl().scrollTop = 0;
      return;
    }
    // The side currently in goal for this attempt -- always the
    // opposite of whoever's shooting. Only this side's goalkeeper has
    // any bearing on the attempt about to be logged, so it's the only
    // one shown; no need to look at or set the shooting side's own
    // keeper right now.
    var defSide = side === 'us' ? 'them' : 'us';
    // openShootout()'s needsRosterDeclare() gate guarantees one of
    // these two is always non-empty by the time drawMain() ever runs,
    // so there is no third "nothing to tap" case left to handle here.
    var fullRoster = side === 'us' ? (S.water.length ? S.water : S.shootoutRoster.us) : (S.oppWater.length ? S.oppWater : S.shootoutRoster.them);
    var designatedShooters = shootoutDesignatedShooters(side);
    // Round 1 still offers the full water roster -- any of them could
    // end up being one of the 5, and it's the coach's free choice which
    // ones as they tap. Once round 1 has settled who those 5 actually
    // are, the grid narrows to just them, since a 6th or 7th player has
    // no further role in this shootout.
    var roster = designatedShooters.length >= 5 ? designatedShooters : fullRoster;
    var suggestedShooter = shootoutSuggestedShooter(side);
    var defKnownKeepers = defSide === 'us' ? (S.keepers || []) : (S.oppKeepers || []);
    // Same reasoning as the shooter roster fallback above -- if this
    // side's goalkeeper was never declared (no roster tracked, or a
    // roster tracked with no keeper marked), offer every cap number as
    // a tap target rather than typing one in. Unlike the shooter
    // roster, this isn't asked once upfront -- a keeper substitution
    // mid-shootout is real, so it stays a plain tap here, re-offered
    // fresh on every attempt. Falls back to that side's own declared
    // squad specifically -- not an arbitrary 1-20 range, which offered
    // cap numbers that were never part of this game's roster at all.
    var defSquad = defSide === 'us' ? (S.squad || []) : (S.oppSquad || []);
    var defGkOptions = defKnownKeepers.length ? defKnownKeepers : (defSquad.length ? defSquad : Array.apply(null, { length: 20 }).map(function (_, i) { return i + 1; }));
    // Genuinely needed here, not just a defensive backstop -- roster
    // can come from S.shootoutRoster (a manually tap-declared stand-in,
    // see needsRosterDeclare()) rather than the live S.water/oppWater,
    // and that declared list isn't automatically kept in sync with a
    // disqualification that happened earlier in regulation the way the
    // real water arrays are.
    var shootDq = xgtDisqualifiedSet(side === 'us' ? 'us' : 'them');
    var defGkDq = xgtDisqualifiedSet(defSide === 'us' ? 'us' : 'them');
    // Shooter chips moved up, right after the tally -- this is the one
    // thing actually needed to move on to the next attempt, and it was
    // previously buried below both goalkeeper selectors, which change
    // far less often. Combined with the scroll reset just below, this
    // makes sure the very next thing visible after committing an
    // attempt is the actual next action, not whatever was scrolled to
    // reach the placement tap zones a moment before.
    var freeSelection = !!S.shootoutFreeSelection;
    // The two situations that actually restrict who's tappable right
    // now, both off entirely when free selection is on:
    //  - round 1 still in progress (fewer than 5 distinct shooters so
    //    far): anyone who's already taken their one shot this round is
    //    blocked until the other 5th shooter has also gone, per the
    //    confirmed rule that nobody repeats within that first pass.
    //  - round 2+ (all 5 established): only the next shooter in the
    //    order that round 1 itself established is selectable -- the
    //    "automatism" that round 2 replays round 1's order exactly.
    // Both branches disable the actual <button> element rather than
    // relying on styling alone, since a merely-styled-but-still-
    // clickable control is what didn't read as "blocked" at all
    // previously.
    var ordinalLabels = ['1st', '2nd', '3rd', '4th', '5th'];
    sheetEl().innerHTML = head('Penalty Shootout', 'Log each attempt as it happens', null) +
      '<div style="text-align:center;font-size:22px;font-weight:800;margin:6px 0 14px">' + xgtTeamLabel('us') + ' ' + tally.us + ' \u2013 ' + tally.them + ' ' + xgtTeamLabel('them') + '</div>' +
      '<span class="xgtLbl" style="display:block;font-size:15px;font-weight:800">' + xgtTeamLabel(side) + ' shooting \u2014 tap the cap number</span>' +
      '<div class="xgtNums" id="xgtSoShooters">' + roster.map(function (n) {
        var shotCount = shootoutShotCount(side, n);
        var ordinalIdx = designatedShooters.indexOf(n);
        var ordinalLabel = ordinalIdx >= 0 ? ordinalLabels[ordinalIdx] : '';
        var blocked = false;
        if (!freeSelection) {
          blocked = designatedShooters.length < 5 ? (shotCount > 0) : (n !== suggestedShooter);
        }
        return '<button class="xgtNum ' + shootoutHighlightClass(shotCount) + xgtDqClass(shootDq, n) + (n === suggestedShooter ? ' soSuggested' : '') + '" data-so-shooter="' + n + '"' + (blocked ? ' disabled' : '') + '>' + xgtKeeperLabel(n) + (ordinalLabel ? '<span class="soOrdinal">' + ordinalLabel + '</span>' : '') + '</button>';
      }).join('') + '</div>' +
      // The escape hatch for events whose own rules differ from the
      // official ones -- bypasses both blocking behaviors above without
      // touching the roster restriction itself (the same 5 still
      // continue; only which one of them can be tapped right now
      // changes).
      '<label style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:#5a6664;margin:8px 0 2px;"><input type="checkbox" id="xgtSoFreeSelection" ' + (freeSelection ? 'checked' : '') + '> Free selection (override automatic order)</label>' +
      '<span class="xgtLbl" style="margin-top:14px">' + xgtTeamLabel(defSide, 'possessive') + ' goalkeeper</span>' +
      '<div class="xgtChips" id="xgtSoDefGk">' + defGkOptions.map(function (n) {
        return '<button class="xgtChip' + xgtDqClass(defGkDq, n) + '" data-so-def-gk="' + n + '" aria-pressed="' + (S.shootoutGoalkeepers[defSide] === n) + '">' + xgtKeeperLabel(n) + '</button>';
      }).join('') + '</div>' +
      (attempts.length
        ? '<span class="xgtLbl" style="margin-top:16px">Attempts so far</span>' +
          '<div class="xgtCard"><table>' + attempts.map(function (e) {
            var sideLabel = xgtTeamLabel(e.actor && e.actor.side === 'them' ? 'them' : 'us');
            return '<tr><td>' + sideLabel + '</td><td>#' + (e.actor ? e.actor.number : '?') + '</td><td>' + (e.outcomeLabel || '') + '</td></tr>';
          }).join('') + '</table></div>'
        : '') +
      // Relabeled from "Done" -- that read as "done with this attempt,
      // continue" rather than what it actually does, which is close the
      // whole shootout screen (the shootout itself isn't finished by
      // this -- attempts and the running tally are preserved, and it
      // can be reopened from the Time editor's SO chip or the game-over
      // banner at any point to keep going). The "End Shootout"/decided
      // styling this used to switch to has moved to the early-return
      // block above, since that's the only place this now renders once
      // decided.
      '<button class="xgtBtn" id="xgtSoDone" style="margin-top:14px">Close Shootout</button>';
    // Explicit reset, every render -- #xgtSheet's own scroll position
    // otherwise carries over verbatim across a full innerHTML swap, so
    // without this, returning here right after scrolling down to reach
    // the goal-placement tap zones could land the coach mid-screen
    // instead of at the top, with the actual next action easy to miss.
    sheetEl().scrollTop = 0;
    el('xgtX').onclick = function () { closeSheet(); };
    Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-so-def-gk]'), function (b) {
      b.onclick = function () { S.shootoutGoalkeepers[defSide] = +b.dataset.soDefGk; drawMain(); };
    });
    Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-so-shooter]'), function (b) {
      b.onclick = function () { drawOutcome(side, +b.dataset.soShooter); };
    });
    el('xgtSoFreeSelection').onchange = function () { S.shootoutFreeSelection = this.checked; drawMain(); };
    el('xgtSoDone').onclick = function () { closeSheet(); };
  }

  function drawOutcome(side, number) {
    sheetEl().innerHTML = head('Penalty Shootout', '#' + xgtKeeperLabel(number) + ' \u2014 outcome', drawMain) +
      '<div class="xgtRow" style="margin-top:10px">' +
        '<button class="xgtBtn pri" id="xgtSoGoal" style="flex:1">Goal</button>' +
        '<button class="xgtBtn" id="xgtSoMiss" style="flex:1">Miss</button>' +
        '<button class="xgtBtn" id="xgtSoSave" style="flex:1">Saved</button></div>';
    sheetEl().scrollTop = 0;
    wire(drawMain);
    el('xgtSoGoal').onclick = function () { drawPlacement(side, number, 'goal', 'Goal', false); };
    el('xgtSoMiss').onclick = function () { drawPlacement(side, number, 'missed', 'Missed', true); };
    el('xgtSoSave').onclick = function () { drawPlacement(side, number, 'blocked', 'Saved', false); };
  }

  // Reuses buildGoalSvg() -- the same rendering the regular in-game shot
  // flow uses -- but deliberately does NOT route through S.draft/
  // finish()/commitDraft(). Those carry a lot of regular-game-only
  // branching (assist steps, foul-counterpart, the block-result step)
  // that has no meaning for a shootout attempt; keeping this path
  // separate, with its own simple commit at the bottom, avoids
  // entangling the two.
  function drawPlacement(side, number, outcome, outcomeLabel, miss) {
    sheetEl().innerHTML = head('Penalty Shootout', outcomeLabel + ' \u2014 where?', function () { drawOutcome(side, number); }) +
      '<p class="xgtNote" style="margin:0 0 6px">Roughly where in the goal? Skip if you are not sure.</p>' +
      // noBlock=true always -- a penalty shot is strictly one-on-one by
      // rule, no field defender is legally involved, so the "field
      // player blocked it" miss option (which buildGoalSvg would
      // otherwise include) never makes sense here regardless of
      // tracking mode, unlike the regular in-play flow where it's
      // conditional on useGkTree.
      buildGoalSvg(miss ? 'miss' : 'in', true) +
      '<button class="xgtBtn" id="xgtSkip">Skip placement</button>';
    sheetEl().scrollTop = 0;
    wire(function () { drawOutcome(side, number); });
    Array.prototype.forEach.call(sheetEl().querySelectorAll('.gz'), function (g) {
      g.addEventListener('click', function () {
        g.classList.add('flash');
        if (navigator.vibrate) navigator.vibrate(8);
        var placement = { grid: miss ? 'miss' : '3x3', area: g.dataset.p, label: g.dataset.l };
        setTimeout(function () { logAttempt(side, number, outcome, outcomeLabel, placement); }, 90);
      });
    });
    el('xgtSkip').onclick = function () { logAttempt(side, number, outcome, outcomeLabel, null); };
  }

  function logAttempt(side, number, outcome, outcomeLabel, placement) {
    var wasDecided = shootoutIsDecided().decided;
    commit({
      actor: { side: side, number: number },
      action: 'shot', actionLabel: 'Shot',
      variant: 'penalty', variantLabel: 'Penalty',
      outcome: outcome, outcomeLabel: outcomeLabel,
      goalPlacement: placement,
      goalkeeper: side === 'us' ? S.shootoutGoalkeepers.them : S.shootoutGoalkeepers.us,
      context: { kind: 'action', trackingMode: S.trackingMode, dc: null, note: null, shootout: true }
    });
    // Fires exactly once -- the attempt that actually tips the outcome
    // from still-open to mathematically settled -- not on every render
    // afterward if the coach keeps logging further, ceremonial shots.
    var nowDecided = shootoutIsDecided();
    if (nowDecided.decided && !wasDecided) {
      toast('Shootout decided \u2014 ' + xgtTeamLabel(nowDecided.winner) + ' win');
      xgtOfferToFinishGame(); // closes this screen itself -- no further shootout actions should be reachable once decided
    } else {
      drawMain();
    }
  }
}

/* ==================================================================== render */
function render() {
  if (!el('xgtRoot')) return;
  var sc = scoreOf();
  el('xgtHs').textContent = sc[0]; el('xgtAs').textContent = sc[1];
  el('xgtScore').style.display = S.trackScore ? 'contents' : 'none'; // kept in sync every render, not just at setup, since S.trackScore could in principle change after buildChrome()'s one-time HTML already ran. 'contents' (not 'flex') so the two .tm children lay out as direct members of xgtClockRow's own flex row, not as a nested box within it
  el('xgtHn').textContent = S.game.home || 'My team';
  el('xgtAn').textContent = S.game.away || 'Opponent';
  var banner = el('xgtGameOverBanner');
  if (S.regulationEnded) {
    var tied = sc[0] === sc[1];
    banner.style.display = '';
    banner.className = tied ? 'tied' : 'decided';
    var scoreLine = '<div id="xgtGameOverScore">' + xgtTeamLabel('us') + ' ' + sc[0] + ' \u2013 ' + sc[1] + ' ' + xgtTeamLabel('them') + '</div>';
    banner.innerHTML = tied
      ? (S.shootoutStartSide
          ? '<div id="xgtGameOverLabel">Penalty Shootout In Progress</div>' + scoreLine + '<button class="xgtBtn pri" id="xgtGameOverSoBtn">Continue Shootout</button>'
          : '<div id="xgtGameOverLabel">Regulation Over \u2014 Tied</div>' + scoreLine + '<button class="xgtBtn pri" id="xgtGameOverSoBtn">Continue with Penalty Shootout</button>')
      : ('<div id="xgtGameOverLabel">Game Over</div>' + scoreLine);
    var soBtn = el('xgtGameOverSoBtn');
    if (soBtn) soBtn.onclick = openShootout;
    if (!tied) xgtOfferToFinishGame(); // no shootout needed -- the game is decided the moment regulation ends; xgtOfferToFinishGame's own guard keeps this from re-prompting on every later render()
  } else {
    banner.style.display = 'none';
  }
  var recent = S.events.slice(-8).reverse();
  var red = S.undone[S.undone.length - 1];
  // Undo/redo attach directly to the latest entry now, rather than
  // living on their own dedicated row -- only ever rendered on recent[0]
  // (the most recent event), since that's the only one undo can ever
  // act on. No separate "nothing to undo" state needed either: with
  // nothing logged yet, there's no latest row to attach anything to,
  // so the controls simply don't appear at all. redo naturally
  // disappears the instant a new event commits, since commit() already
  // clears S.undone right there -- this only changes where the button
  // shows, not when it's actually available.
  el('xgtLog').innerHTML = recent.length
    ? recent.map(function (e, i) {
        var isLatest = i === 0;
        return '<div class="lr"><span class="tm">Q' + e.quarter + ' ' + fmt(e.gameClock) + '</span>' +
               '<span class="mn">' + describe(e) + '</span>' +
               (isLatest
                 ? '<span class="lrActions"><button class="lrUndo" id="xgtUn" title="Undo">\u21ba</button>' +
                   (red ? '<button class="lrRedo" id="xgtRd" title="Redo">\u21bb</button>' : '') + '</span>'
                 : '') +
               '</div>';
      }).join('')
    : '<div class="lr"><span class="mn" style="color:#7c8a8a">Tap the zone where the action happened.</span></div>';
  if (recent.length) el('xgtUn').onclick = undoLast;
  if (red) el('xgtRd').onclick = redoLast;
  renderBar();
  paintClock();
  if (S.active) setTimeout(function () {
    // Deliberately NOT calling Studio's fitBoardToScreen() here -- it
    // unconditionally resets #stageWrap's scroll position back to the
    // default crop every time it runs. Since render() fires after every
    // single tap, calling it here would silently snap the coach back to
    // the attacking half any time they interacted with anything after
    // scrolling to look at the other end of the pool. Just keep the
    // shield glued to wherever #stageWrap already is.
    positionShield();
  }, 0);
}
// Phase E: goals + personal fouls (committed exclusions) tallied live for
// one player on one side, from the same event shapes fieldPlayerStats()
// already reads (action==='shot'&&outcome==='goal',
// action==='exclusion'&&context.dc==='committed') -- so the quick-tap
// opponent events below feed the exact same computation path a live
// player's own actions already do, no separate counting logic needed.
// A foul this player actually COMMITTED can live in either of two
// places on the event, depending on which player the coach happened to
// tap first when logging it -- the first-tapped player is always the
// one attributed as the primary actor, but which role (drawn/committed)
// THEY played is a separate choice, so the actual committer isn't
// always e.actor. If this player was tapped first and marked as having
// committed it, they're e.actor with dc==='committed'; if a different
// player was tapped first and marked as having drawn it, THIS player is
// instead recorded as e.foulCounterpart with dc==='drawn' on that same
// event. Previously only the first of these two cases was ever counted,
// so a player who committed a foul without being the one the coach
// happened to tap first never showed up on their own record at all.
function xgtLiveTally(side, num) {
  // Normalized to the event data's own convention -- team-mode events
  // store the opposing side as 'opp' (per selectTeamActor()), but
  // renderBar()'s own display-layer toggle (below, and its caller)
  // tracks which roster tab is showing as 'us'/'them' instead. Without
  // this, the opponent roster's own badges could never match any real
  // event at all -- a broader version of the same underlying "which
  // side string means what" gap, not just the drawn/committed case
  // below.
  var normSide = side === 'them' ? 'opp' : side;
  var goals = 0, fouls = 0;
  S.events.forEach(function (e) {
    if (e.actor && e.actor.side === normSide && e.actor.number === num) {
      if (e.action === 'shot' && e.outcome === 'goal') goals++;
      if (e.action === 'exclusion' && e.context && e.context.dc === 'committed') fouls++;
    } else if (e.action === 'exclusion' && e.context && e.context.dc === 'drawn' &&
               e.foulCounterpart && e.foulCounterpart.side === normSide && e.foulCounterpart.number === num) {
      fouls++;
    }
  });
  return { goals: goals, fouls: fouls };
}
function renderBar() {
  var bar = el('xgtBar'), gk = S.playerRole === 'goalkeeper';
  if (singlePlayerMode()) {
    var iw = inWater(S.me.number);
    bar.innerHTML =
      '<div class="xgtRow" style="margin-bottom:7px"><div class="xgtWho"><span class="num">#' + S.me.number + '</span>' +
      '<div class="meta" style="flex:1">' + (S.me.name || (gk ? 'Goalkeeper' : 'My player')) + '<br>' +
      (gk ? 'In goal' : 'In water') + ' ' + fmt(waterSeconds(S.me.number)) + '</div></div></div>' +
      '<div class="xgtRow"><button class="xgtPill ' + (iw ? 'in' : 'out') + '" id="xgtPres" style="flex:1">' +
      (iw ? '● ' + (gk ? 'In goal' : 'In the water') + ' — tap to sub out' : '○ On the bench — tap to sub in') + '</button></div>' +
      '<div class="xgtRow" style="margin-top:7px"><button id="xgtOptionsBtn" style="flex:1">\u2630 Menu</button><button id="xgtStatsBtn" style="flex:1">Stats</button></div>';
    el('xgtPres').onclick = function () {
      var v = inWater(S.me.number);
      commit({ actor: { side: 'us', number: S.me.number },
               context: { kind: 'presence', dir: v ? 'out' : 'in', trackingMode: S.trackingMode, dc: null, note: null } });
    };
    el('xgtOptionsBtn').onclick = openOptions;
    el('xgtStatsBtn').onclick = function () { openStats(); };
  } else {
    // Both rosters shown simultaneously now, side by side (own team
    // left, opponent right), per confirmed direction -- replacing the
    // earlier "Us"/"Them" toggle that only ever showed one roster at a
    // time. If opponent tracking isn't on, there's no second roster to
    // show at all, so only the left (own) column renders.
    function renderBarColumn(side) {
      var isUs = side === 'us';
      var rosterSquad = isUs ? S.squad : S.oppSquad;
      var rosterWater = isUs ? S.water : S.oppWater;
      var keepers = isUs ? S.keepers : S.oppKeepers;
      var dqSet = xgtDisqualifiedSet(side);
      return '<div class="xgtBarCol">' +
        '<span class="xgtLbl">' + xgtTeamLabel(side) + ' \u00b7 ' + rosterWater.length + '/7</span>' +
        '<div class="xgtChips">' + rosterSquad.map(function (n) {
          var dq = dqSet[n];
          var t = xgtLiveTally(side, n);
          var badges = (t.goals || t.fouls)
            ? '<span class="xgtChipBadges">' + (t.goals ? '<span class="xgtBadgeGoal">' + t.goals + '</span>' : '') +
              (t.fouls ? '<span class="xgtBadgeFoul">' + t.fouls + '</span>' : '') + '</span>'
            : '';
          // Both sides' goalkeepers get the same treatment now -- the
          // opponent's was previously never marked at all (isGoalie
          // was unconditionally false whenever this rendered their
          // side), so their keeper never got the red outline this
          // fixes for both columns alike.
          var isGoalie = keepers.indexOf(n) >= 0;
          var displayText = isGoalie && isUs ? xgtKeeperLabel(n) : n;
          // Reason-specific marker (dqExclSub/dqBrutality/dqRedCard)
          // goes on the chip itself, alongside its other classes --
          // that's where the CSS ::after marker is actually anchored.
          var dqReasonClass = dq === 'excl_sub' ? ' dqExclSub' : dq === 'brutality' ? ' dqBrutality' : dq === 'red_card' ? ' dqRedCard' : '';
          return '<div class="xgtChipWrap' + (dq ? ' dqPlayer' : '') + '"><button class="xgtChip ' + (rosterWater.indexOf(n) >= 0 ? 'water' : '') + (isGoalie ? ' goalie' : '') + dqReasonClass + '" data-n="' + n + '" data-side="' + side + '">' +
            displayText + badges + '</button></div>';
        }).join('') + '</div></div>';
    }
    bar.innerHTML = '<div class="xgtBarSplit">' + renderBarColumn('us') +
      '<div class="xgtBarUtil"><button id="xgtOptionsBtn">\u2630 Menu</button><button id="xgtStatsBtn">Stats</button></div>' +
      (S.opponentTracked ? renderBarColumn('them') : '') + '</div>';

    el('xgtOptionsBtn').onclick = openOptions;
    el('xgtStatsBtn').onclick = function () {
      // Single-game stats, including JSON/CSV export of THIS game's event
      // log, are free for everyone -- deliberately not gated. The paid
      // tier is what's built on top of a single game, not the single game
      // itself: aggregating stats across multiple saved sessions, and PDF
      // exports of the visual analytics (field-zone heat maps, goal-zone
      // placement maps). Neither of those exists yet as of this comment.
      openStats();
    };

    Array.prototype.forEach.call(bar.querySelectorAll('[data-n]'), function (b) {
      b.onclick = function () {
        var n = +b.dataset.n, side = b.dataset.side, waterArr = side === 'them' ? S.oppWater : S.water, i = waterArr.indexOf(n);
        // Same 'them'->'opp' normalization as the quick-goal/quick-foul
        // handlers below, and for the same reason: 'us'/'them' is only
        // this bar's own internal column naming, while every commit
        // elsewhere in the app uses 'us'/'opp'. xgtUndoAccidentalResub
        // must be given this same normalized value, since it matches
        // past events by an exact actor.side equality check.
        var actorSide = side === 'them' ? 'opp' : side;
        if (i >= 0) { waterArr.splice(i, 1); commit({ actor: { side: actorSide, number: n }, context: { kind: 'presence', dir: 'out', trackingMode: 'coach', dc: null, note: null } }); }
        else {
          if (waterArr.length >= 7) { toast('7 in the water already — sub someone out first.'); return; }
          waterArr.push(n); waterArr.sort(function (a, b2) { return a - b2; });
          if (xgtUndoAccidentalResub(actorSide, n)) {
            save(); render(); toast('Looked like a mis-tap \u2014 the earlier sub-out was removed, nothing logged.');
          } else {
            commit({ actor: { side: actorSide, number: n }, context: { kind: 'presence', dir: 'in', trackingMode: 'coach', dc: null, note: null } });
          }
        }
      };
    });
  }
}

/* ================================================================= statistics */
var HEAT = ['#e1e6e6', '#a9c2c2', '#6ba3a3', '#1b7373', '#124d4d', '#0d3838'];
function heat(t) { var i = Math.round(t * (HEAT.length - 1)); return HEAT[Math.max(0, Math.min(HEAT.length - 1, i))]; }
function fieldPlayerStats(evs) {
  function c(id) { return evs.filter(function (e) { return e.outcome === id; }).length; }
  var shots = evs.filter(function (e) { return e.action === 'shot'; }).length, goals = c('goal');
  return { shots: shots, goals: goals, blocked: c('blocked'), missed: c('missed'),
    pct: shots ? Math.round(goals / shots * 100) : 0,
    exDrawn: evs.filter(function (e) { return e.action === 'exclusion' && e.context.dc === 'drawn'; }).length,
    exGiven: evs.filter(function (e) { return e.action === 'exclusion' && e.context.dc === 'committed'; }).length,
    turnovers: evs.filter(function (e) { return e.action === 'turnover'; }).length,
    steals: evs.filter(function (e) { return e.action === 'steal'; }).length,
    assists: evs.filter(function (e) { return e.assist != null; }).length };
}
function goalkeeperStats(evs) {
  var shots = evs.filter(function (e) { return e.action === 'shot'; });
  function o(list, id) { return list.filter(function (e) { return e.outcome === id; }).length; }
  function v(id) { return shots.filter(function (e) { return e.variant === id; }); }
  function onT(list) { return list.filter(function (e) { return e.outcome === 'blocked' || e.outcome === 'goal'; }); }
  /* "Faced" deliberately means shots that reached the frame — otherwise a wide
     shot would drag the save percentage around without the keeper touching it. */
  var onTarget = onT(shots).length, saves = o(shots, 'blocked'), goals = o(shots, 'goal');
  var pen = v('penalty');
  var missedShots = shots.filter(function (e) { return e.outcome === 'missed'; });
  var postCrossbar = missedShots.filter(function (e) {
    return e.goalPlacement && ['post_left', 'crossbar', 'post_right'].indexOf(e.goalPlacement.area) >= 0;
  }).length;
  var outlets = evs.filter(function (e) { return e.action === 'outlet'; });
  return {
    attempts: shots.length,
    faced: onTarget, saves: saves, goals: goals,
    pct: onTarget ? Math.round(saves / onTarget * 100) : 0,
    missed: o(shots, 'missed'), defBlocks: o(shots, 'def_block'),
    postCrossbar: postCrossbar,
    penFaced: onT(pen).length, penSaves: o(pen, 'blocked'),
    regular: onT(v('regular')).length, regularSaves: o(v('regular'), 'blocked'), regularOff: o(v('regular'), 'missed'),
    skip: onT(v('skip')).length, skipSaves: o(v('skip'), 'blocked'), skipOff: o(v('skip'), 'missed'),
    lob: onT(v('lob')).length, lobSaves: o(v('lob'), 'blocked'), lobOff: o(v('lob'), 'missed'),
    penOff: o(pen, 'missed'),
    steals: evs.filter(function (e) { return e.action === 'steal'; }).length,
    turnovers: evs.filter(function (e) { return e.action === 'turnover'; }).length,
    exDrawn: evs.filter(function (e) { return e.action === 'exclusion' && e.context.dc === 'drawn'; }).length,
    exGiven: evs.filter(function (e) { return e.action === 'exclusion' && e.context.dc === 'committed'; }).length,
    outletCompleted: outlets.filter(function (e) { return e.outcome === 'completed'; }).length,
    outletTurnovers: outlets.filter(function (e) { return e.outcome === 'turnover'; }).length
  };
}
// A given side's exclusions given/drawn needs BOTH halves of every foul
// event to be checked, not just the primary-actor half -- same
// reasoning as xgtLiveTally's own comment above. Shared here so the
// live per-player badge, a single player's full stats, and a whole
// team's aggregate stats all stay consistent with each other rather
// than three separate implementations of the same rule drifting apart.
// scopeNum omitted (undefined) computes for the whole side; provided,
// scopes to that one player specifically.
function xgtExclusionCounts(side, scopeNum) {
  var given = 0, drawn = 0;
  actionEvents().forEach(function (e) {
    if (e.action !== 'exclusion' || !e.context) return;
    var actorMatch = e.actor && e.actor.side === side && (scopeNum == null || e.actor.number === scopeNum);
    var counterpartMatch = e.foulCounterpart && e.foulCounterpart.side === side && (scopeNum == null || e.foulCounterpart.number === scopeNum);
    if (actorMatch) {
      if (e.context.dc === 'committed') given++;
      if (e.context.dc === 'drawn') drawn++;
    } else if (counterpartMatch) {
      if (e.context.dc === 'drawn') given++; // the primary actor drew it, so this side/player (the counterpart) committed it
      if (e.context.dc === 'committed') drawn++; // the primary actor committed it, so this side/player (the counterpart) drew it
    }
  });
  return { given: given, drawn: drawn };
}
// Every action event where this exact player is the primary actor --
// correct for a field player's shots/goals/steals/turnovers/assists.
// Exclusion counts are handled separately (xgtExclusionCounts, above)
// since those need the counterpart half too, which this alone can't see.
function xgtFieldPlayerEvents(side, num) {
  return actionEvents().filter(function (e) { return e.actor && e.actor.side === side && e.actor.number === num; });
}
// A goalkeeper is never the primary actor on a shot they face -- the
// shooter is (e.actor), and this keeper is instead recorded separately
// via e.goalkeeper (set on every team-mode shot regardless of outcome).
// goalkeeperStats() expects ONE combined array covering both shots
// faced AND this keeper's own other actions (steals, turnovers, outlet
// passes), which is exactly what it already reads shots/steals/etc from
// within a single evs param -- so both halves are merged here rather
// than calling it twice.
function xgtGoalkeeperEvents(side, num) {
  return actionEvents().filter(function (e) {
    if (e.action === 'shot') return e.goalkeeper === num && e.actor && e.actor.side !== side;
    return e.actor && e.actor.side === side && e.actor.number === num;
  });
}
// One player's complete stats, correctly attributed regardless of
// whether they're a field player or a designated goalkeeper, and with
// exclusions correctly counting both halves of the drawn/committed
// relationship rather than just whichever half happened to name them
// as the primary actor.
function xgtPlayerStats(side, num, isGk) {
  var stats = isGk ? goalkeeperStats(xgtGoalkeeperEvents(side, num)) : fieldPlayerStats(xgtFieldPlayerEvents(side, num));
  var ex = xgtExclusionCounts(side, num);
  stats.exGiven = ex.given; stats.exDrawn = ex.drawn;
  return stats;
}
// A whole side's aggregate stats -- same field-player computation as a
// single player's, just scoped to every actor on that side rather than
// one number, with the same corrected exclusion counting.
function xgtTeamStats(side) {
  var stats = fieldPlayerStats(actionEvents().filter(function (e) { return e.actor && e.actor.side === side; }));
  var ex = xgtExclusionCounts(side);
  stats.exGiven = ex.given; stats.exDrawn = ex.drawn;
  return stats;
}
function gkRow(label, n, saved, off) {
  return '<tr><td>' + label + '</td><td style="text-align:right">' + n + '</td>' +
    '<td style="text-align:right">' + saved + '</td>' +
    '<td style="text-align:right">' + (n ? Math.round(saved / n * 100) + '%' : '—') + '</td>' +
    '<td style="text-align:right">' + off + '</td></tr>';
}
function zoneCounts(evs) {
  var map = {}, max = 0;
  evs.forEach(function (e) { if (!e.fieldZone) return; map[e.fieldZone] = (map[e.fieldZone] || 0) + 1; max = Math.max(max, map[e.fieldZone]); });
  return { map: map, max: max };
}
function heatFieldSvg(evs) {
  var c = zoneCounts(evs);
  var zoneBody = ZONES.map(function (z) {
    var n = c.map[z.id] || 0, lp = labelPoint(z);
    return '<path d="' + wedgePath(z.r1, z.r2, z.a1, z.a2) + '" fill="' + (n ? heat(c.max ? n / c.max : 0) : 'rgba(27,115,115,.05)') +
      '" fill-opacity="' + (n ? '0.82' : '1') + '" stroke="rgba(20,35,92,.35)" stroke-width=".05"/>' +
      '<text x="' + lp.x + '" y="' + lp.y + '" text-anchor="middle" font-family="system-ui" ' +
      'transform="rotate(90,' + lp.x + ',' + lp.y + ')" fill="' + (n ? '#fff' : '#124d4d') + '" ' +
      'style="paint-order:stroke" stroke="' + (n ? 'rgba(13,43,43,.45)' : 'none') + '" stroke-width=".18" stroke-linejoin="round">' +
      /* Count (how many events) as the primary number, zone number alone
         as a small secondary label -- no "ZONE" word, matching the live
         overlay's numbers-only display. */
      '<tspan x="' + lp.x + '" dy="-0.15em" font-size="1.05" font-weight="800">' + n + '</tspan>' +
      '<tspan x="' + lp.x + '" dy="1.1em" font-size=".5" font-weight="600" opacity=".85">' + zoneNum(z) + '</tspan></text>';
  }).join('');
  /* Real field markings, reproduced from Studio's own #fieldGroup at the
     same board coordinates (goal 0.5-2 wide x 1.5 deep, 2m box, 5m line,
     6m line, center line at x=14.5) -- recolored to teal/grey/white
     instead of Studio's red/yellow/green functional colors, since those
     are meaningful during live coaching but this is a read-only summary
     view, not something a referee needs to read at a glance. */
  var field =
    '<rect x="2" y="2" width="12.5" height="20" fill="#f2f5f5" stroke="#ccd6d6" stroke-width=".05"/>' +
    '<rect x="0.5" y="10.5" width="1.5" height="3" fill="#fff" stroke="#54605f" stroke-width=".05"/>' +
    '<path d="M0.65 10.65 H1.85 M0.65 11.0 H1.85 M0.65 11.35 H1.85 M0.65 11.7 H1.85 M0.65 12.05 H1.85 M0.65 12.4 H1.85 M0.65 12.75 H1.85 M0.65 13.1 H1.85 M0.65 13.45 H1.85 M0.65 10.65 V13.35 M0.95 10.65 V13.35 M1.25 10.65 V13.35 M1.55 10.65 V13.35 M1.85 10.65 V13.35" stroke="#ccd6d6" stroke-width=".02"/>' +
    '<g fill="none" stroke-linecap="round" stroke-dasharray=".08 .16">' +
      '<path d="M2 8.5 H4 V15.5 H2" stroke="#7c8a8a" stroke-width=".05"/>' +
      '<path d="M7 2 V22" stroke="#a9c2c2" stroke-width=".05"/>' +
      '<path d="M8 2 V22" stroke="#1b7373" stroke-width=".05"/>' +
      '<path d="M14.5 2 V22" stroke="#54605f" stroke-width=".05"/>' +
    '</g>';
  return '<svg class="xgtHeat" viewBox="-2.6 4.9 20 14.2" style="width:100%;height:auto;display:block;background:#e1e6e6;border-radius:8px">' +
    '<defs><clipPath id="xgtHeatClip" clipPathUnits="userSpaceOnUse">' +
    '<rect x="2" y="2" width="12.5" height="20"/></clipPath></defs>' +
    '<g transform="rotate(-90, 7.4, 12)">' +
      field +
      '<g clip-path="url(#xgtHeatClip)">' + zoneBody + '</g>' +
      '<rect x="2" y="2" width="12.5" height="20" fill="none" stroke="#54605f" stroke-width=".08"/>' +
    '</g></svg>';
}
/* Full goal graphic with posts, crossbar, and the surrounding miss area --
   reuses buildGoalSvg's exact frame/net/target geometry (the same shape
   the live picker itself uses) rather than a flat 3x3 grid, so every
   recorded shot has a real place to land: in the cage (from IN_TARGETS,
   heat-colored) or wide/high/off the post (from MISS_TARGETS). The
   redundant in-cage "blocked_field" miss zone is dropped from this
   combined view since the in-goal grid already covers that region. */
function goalMapHtml(evs) {
  var inMap = {}, inMax = 0, missMap = {}, missMax = 0;
  evs.forEach(function (e) {
    var g = e.goalPlacement; if (!g) return;
    if (g.grid === '3x3') { inMap[g.area] = (inMap[g.area] || 0) + 1; inMax = Math.max(inMax, inMap[g.area]); }
    else if (g.grid === 'miss' && g.area !== 'blocked_field') { missMap[g.area] = (missMap[g.area] || 0) + 1; missMax = Math.max(missMax, missMap[g.area]); }
  });
  if (!inMax && !missMax) return '<p class="xgtNote">No shot placements recorded yet.</p>';
  var G = GOALG;
  var inCells = IN_TARGETS.map(function (t) {
    var n = inMap[t.id] || 0, r = inMax ? n / inMax : 0;
    var cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    return '<g><rect x="' + (t.x + 1.5) + '" y="' + (t.y + 1.5) + '" width="' + (t.w - 3) + '" height="' + (t.h - 3) +
      '" rx="5" fill="' + (n ? heat(r) : 'rgba(27,115,115,.08)') + '" stroke="rgba(20,35,92,.30)"/>' +
      '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="15" font-weight="800" fill="' + (n ? '#fff' : '#7c8a8a') + '">' + n + '</text></g>';
  }).join('');
  var missCells = MISS_TARGETS.filter(function (t) { return t.id !== 'blocked_field'; }).map(function (t) {
    var n = missMap[t.id] || 0, r = missMax ? n / missMax : 0;
    var cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    var label = t.rot
      ? '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" font-size="9" font-weight="700" transform="rotate(-90 ' + cx + ' ' + cy + ')" fill="' + (n ? '#fff' : '#7c8a8a') + '">' + n + '</text>'
      : '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="13" font-weight="800" fill="' + (n ? '#fff' : '#7c8a8a') + '">' + n + '</text>';
    return '<g><rect x="' + (t.x + 1.5) + '" y="' + (t.y + 1.5) + '" width="' + (t.w - 3) + '" height="' + (t.h - 3) +
      '" rx="4" fill="' + (n ? heat(r) : 'rgba(124,138,138,.10)') + '" stroke="rgba(20,35,92,.20)"/>' + label + '</g>';
  }).join('');
  var net = '<g opacity=".4" stroke="rgba(84,96,95,.55)" stroke-width=".8">';
  for (var i = 1; i <= 7; i++) net += '<line x1="' + (G.mouth.x + i * G.mouth.w / 8) + '" y1="' + G.mouth.y + '" x2="' + (G.mouth.x + i * G.mouth.w / 8) + '" y2="' + (G.mouth.y + G.mouth.h) + '"/>';
  for (i = 1; i <= 3; i++) net += '<line x1="' + G.mouth.x + '" y1="' + (G.mouth.y + i * G.mouth.h / 4) + '" x2="' + (G.mouth.x + G.mouth.w) + '" y2="' + (G.mouth.y + i * G.mouth.h / 4) + '"/>';
  net += '</g>';
  var frame = '<g fill="#fff" stroke="#54605f" stroke-width="1.5">' +
    '<rect x="' + G.frame.x + '" y="' + G.frame.y + '" width="20" height="' + G.frame.h + '" rx="4"/>' +
    '<rect x="' + (G.frame.x + G.frame.w - 20) + '" y="' + G.frame.y + '" width="20" height="' + G.frame.h + '" rx="4"/>' +
    '<rect x="' + G.mouth.x + '" y="' + G.frame.y + '" width="' + G.mouth.w + '" height="20" rx="4"/></g>';
  return '<svg class="xgtGoal" viewBox="24 0 552 294" preserveAspectRatio="xMidYMid meet">' +
    '<rect x="0" y="0" width="600" height="400" fill="#e1e6e6"/>' +
    '<line x1="30" y1="' + G.waterY + '" x2="570" y2="' + G.waterY + '" stroke="#a9c2c2" stroke-width="2.5"/>' +
    net + frame + missCells + inCells + '</svg>';
}
function fileName() {
  var sc = scoreOf();
  return [S.game.date || 'game', (S.game.home || 'Us') + '-v-' + (S.game.away || 'Them'),
    sc[0] + '-' + sc[1], S.playerRole === 'goalkeeper' ? 'GK' : 'FP',
    S.me.number != null ? ('no' + S.me.number) : ''].filter(Boolean).join('_').replace(/[^\w\-.]/g, '_');
}
// Shared by openStats() (live) and xgtStatsBodyParts() (saved/combined) --
// builds one goalkeeper-facing-shots block (title + tiles + type table)
// from an already-filtered, side-specific event array. Returns '' for an
// empty array so callers can unconditionally concatenate this in without
// their own length check first.
function xgtOpposingKeeperBlockHtml(label, gkEvents) {
  if (!gkEvents.length) return '';
  var kg = goalkeeperStats(gkEvents);
  var keeperNo = null;
  for (var i = 0; i < gkEvents.length && keeperNo == null; i++) keeperNo = gkEvents[i].goalkeeper;
  return '<h2>' + label + (keeperNo != null ? ' \u00b7 #' + xgtKeeperLabel(keeperNo) : '') + '</h2>' +
    '<div class="xgtTiles">' +
    [[kg.faced, 'ON GOAL FACED'], [kg.saves, 'SAVES / BLOCKS'], [kg.pct + '%', 'SAVE %'],
     [kg.goals, 'GOALS ALLOWED'], [kg.missed, 'OFF TARGET'], [kg.defBlocks, 'DEFENDER BLOCKS']]
      .map(function (t) { return '<div class="xgtTile"><div class="v">' + t[0] + '</div><div class="k">' + t[1] + '</div></div>'; }).join('') +
    '</div>' + gkTypeTable(kg);
}
// Extracted from what used to be the standalone Sessions button's own
// click handler, unchanged -- now reachable from Options instead (see
// openOptions below), per direct feedback that this should only live
// there, not as its own always-visible top-row button.
function xgtOpenSessions() {
  if (typeof XQUIX === 'undefined' || !XQUIX.Auth || !XQUIX.Auth.getCurrentUser()) {
    toast('Sign in to save and browse sessions across games \u2014 today\u2019s game still tracks and exports locally either way.');
    return;
  }
  if (!xgtHasCloudStorage()) {
    toast('Session storage is a paid feature \u2014 upgrade to save and revisit games across your season. Today\u2019s game still tracks and exports locally either way.');
    return;
  }
  if (typeof openCoachingLibrary !== 'function' || typeof renderLibraryContent !== 'function') return;
  var shield = el('xgtShield'), block = el('xgtBlock'), oppoZone = el('xgtOppoZone');
  if (shield || block) {
    if (shield) shield.style.pointerEvents = 'none';
    if (block) block.style.pointerEvents = 'none';
    if (oppoZone) oppoZone.style.pointerEvents = 'none';
    S.shieldSuspendedForToolPanel = true;
  }
  openCoachingLibrary().then(function () {
    libState.typeFilter = 'gameTrackerSession';
    return renderLibraryContent();
  });
}
// Consolidates everything that used to be its own always-visible
// top-row button (Time, Zones, Field View, Edit Numbers, Sessions) plus
// several genuinely new items, into one out-of-the-way sheet -- per
// direct feedback that the top row above the field was too crowded
// with secondary, infrequently-used actions competing with the field
// itself for prominence. Quarter-tap still opens the same time editor
// directly (Set Time here is just a second way to reach the exact same
// screen, not a separate function) and Stats still has its own direct
// top-row button too -- both are duplicated here deliberately, since
// they're common enough to be worth a shortcut from wherever the coach
// happens to be looking.
function openOptions() {
  draw(); openSheet();
  function draw() {
    var isFrontCourt = frontCourtOn();
    // Sessions only shown when it would actually lead somewhere useful --
    // see xgtShouldShowSessionsEntry()'s own comment for the full reasoning.
    var showSessions = xgtShouldShowSessionsEntry();
    sheetEl().innerHTML = head('Menu', 'Settings and less-frequent actions', null) +
      // Prominent and first, matching how Switch Mode sits at the top
      // of the sidebar in the Coaching platform, rather than buried
      // among the settings below it.
      '<button class="xgtBtn" id="xgtOptSwitchMode" style="background:#1b7373;color:#fff;border:1px solid #124d4d;margin-bottom:14px">Switch Mode \u2192</button>' +
      '<button class="xgtBtn" id="xgtOptTime">Set / Reset Time</button>' +
      '<button class="xgtBtn" id="xgtOptZones" style="margin-top:8px">' + (S.zonesVisible ? 'Hide Field Zones' : 'Show Field Zones') + '</button>' +
      '<button class="xgtBtn" id="xgtOptEditNums" style="margin-top:8px">' + (S.editingZoneNumbers ? 'Done Renaming Zones' : 'Rename Field Zones') + '</button>' +
      // Front Court stays the default every time the tracker opens
      // (unrelated to whatever this toggle is set to at the moment) --
      // this only changes the CURRENT session's view on request, per
      // direct confirmation that Front Court is sufficient for all
      // tracking as things stand today. See toggleFrontCourt() itself
      // for why switching away is safe to offer here: the geometry
      // problem that originally justified removing this toggle
      // entirely was specific to leaving it reachable as a prominent,
      // easy-to-hit default control, not to the underlying view itself
      // being broken.
      '<button class="xgtBtn" id="xgtOptFieldView" style="margin-top:8px">Field View: ' +
        (isFrontCourt ? 'Front Court (tap for Full Court)' : 'Full Court (tap for Front Court)') + '</button>' +
      '<div style="border-top:1px solid #e1e6e6;margin:14px 0 10px"></div>' +
      '<button class="xgtBtn" id="xgtOptStats">Stats</button>' +
      (showSessions ? '<button class="xgtBtn" id="xgtOptSessions" style="margin-top:8px">Sessions</button>' : '') +
      // Only reachable once regulation has actually ended -- a post-
      // game foul, by definition, can't happen before then. Tucked in
      // here rather than given a prominent spot of its own, matching
      // how rare an occurrence this is expected to be.
      (S.regulationEnded ? '<button class="xgtBtn" id="xgtOptPostGameFoul" style="margin-top:8px">Log Post-Game Foul</button>' : '') +
      '<div style="border-top:1px solid #e1e6e6;margin:14px 0 10px"></div>' +
      '<button class="xgtBtn" id="xgtOptCsv">Export CSV</button>' +
      '<button class="xgtBtn" id="xgtOptJson" style="margin-top:8px">Export JSON</button>' +
      '<div style="border-top:1px solid #e1e6e6;margin:14px 0 10px"></div>' +
      '<button class="xgtBtn" id="xgtOptNew">Start New Session</button>' +
      '<button class="xgtBtn pri" id="xgtOptEndSave" style="margin-top:8px">End \u0026 Save Session</button>';
    el('xgtX').onclick = function () { closeSheet(); };
    el('xgtOptTime').onclick = function () { closeSheet(); openClock(); };
    el('xgtOptZones').onclick = function () {
      S.zonesVisible = !S.zonesVisible;
      var g = el('xgtZoneLayer'); if (g) g.style.display = S.zonesVisible ? '' : 'none';
      draw();
    };
    el('xgtOptEditNums').onclick = function () {
      S.editingZoneNumbers = !S.editingZoneNumbers;
      if (S.editingZoneNumbers) { closeSheet(); toast('Tap a zone to give it a new number.'); }
      else draw();
    };
    el('xgtOptFieldView').onclick = function () {
      if (window.MIZE.Field && window.MIZE.Field.toggleFrontCourt) {
        try { window.MIZE.Field.toggleFrontCourt(!isFrontCourt); } catch (err) {}
      }
      xgtCorrectStageWrapOverlap();
      positionShield();
      draw();
    };
    el('xgtOptStats').onclick = function () { closeSheet(); openStats(); };
    el('xgtOptSessions')?.addEventListener('click', function () { closeSheet(); xgtOpenSessions(); });
    el('xgtOptPostGameFoul')?.addEventListener('click', function () { openPostGameFoulWho(); });
    // Mirrors the Exit button's own close path (game state is already
    // kept saved/resumable via syncSessionToCloud on every tap, same as
    // Exit) -- then reveals the home screen so the coach can jump
    // straight into another mode instead of landing back on the
    // ordinary coaching board first.
    el('xgtOptSwitchMode').onclick = function () { closeSheet(); API.close(); xquixShowHome(); };
    el('xgtOptCsv').onclick = function () {
      download(fileName() + '.csv', 'text/csv', xgtEventsToCsvString(S.events));
    };
    el('xgtOptJson').onclick = function () {
      var sc = scoreOf();
      download(fileName() + '.json', 'application/json', JSON.stringify({
        app: 'XquiX Game Tracker', stage: 'beta', schema: 3,
        field: { space: 'MIZE.Field', zoneSet: 'offense+outer', goal: GEO.goal, innerR: GEO.innerR, outerR: GEO.outerR },
        game: { date: S.game.date, loc: S.game.loc, home: S.game.home, away: S.game.away, finalScore: { home: sc[0], away: sc[1] } },
        trackingMode: S.trackingMode, playerRole: S.playerRole, trackedPlayer: S.me, squad: S.squad,
        events: S.events
      }, null, 2));
    };
    el('xgtOptNew').onclick = async function () {
      const ok = await MizeDialog.confirm('Clear this game and start a new one?');
      if (!ok) return;
      resetGameState();
      closeSheet();
      render(); openSetup();
    };
    // "End & Save" rather than a bare close -- syncSessionToCloud()
    // already runs after every single tap during play, so there's
    // nothing this uniquely saves that wasn't already saved moments
    // ago, but a coach wrapping up a game wants the reassurance of an
    // explicit "yes, this is done and saved" action, not to have to
    // trust that closing the same way as every other exit already
    // covered it.
    el('xgtOptEndSave').onclick = function () { xgtOfferToFinishGame(true); };
  }
}
function openPostGameFoulWho() {
  var usRoster = S.squad.length ? S.squad : S.water;
  var themRoster = S.oppSquad.length ? S.oppSquad : S.oppWater;
  sheetEl().innerHTML = head('Post-Game Foul', 'Who committed it?', openOptions) +
    '<span class="xgtLbl" style="display:block;font-size:14px;font-weight:800">' + xgtTeamLabel('us') + '</span>' +
    '<div class="xgtNums">' + usRoster.map(function (n) {
      return '<button class="xgtNum" data-pgf-who="us:' + n + '">' + n + '</button>';
    }).join('') + '</div>' +
    // No opponent roster to pick from at all if they were never
    // tracked -- there'd be no known cap numbers for them regardless
    // of what actually happened.
    (S.opponentTracked
      ? '<span class="xgtLbl" style="display:block;font-size:14px;font-weight:800;margin-top:14px">' + xgtTeamLabel('them') + '</span>' +
        '<div class="xgtNums">' + themRoster.map(function (n) {
          return '<button class="xgtNum" data-pgf-who="them:' + n + '">' + n + '</button>';
        }).join('') + '</div>'
      : '');
  wire(openOptions);
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-pgf-who]'), function (b) {
    b.onclick = function () {
      var parts = b.dataset.pgfWho.split(':');
      openPostGameFoulConsequence(parts[0], +parts[1]);
    };
  });
}
function openPostGameFoulConsequence(side, number) {
  sheetEl().innerHTML = head('Post-Game Foul', xgtTeamLabel(side) + ' #' + number + ' \u2014 what happened?', openPostGameFoulWho) +
    '<button class="xgtBtn pri" data-pgf-outcome="red_card" style="margin-bottom:9px">Red Card</button>' +
    '<button class="xgtBtn" data-pgf-outcome="excl_sub" style="margin-bottom:9px">Exclusion with Substitution</button>' +
    '<button class="xgtBtn" data-pgf-outcome="brutality">Exclusion with Brutality</button>';
  wire(openPostGameFoulWho);
  Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-pgf-outcome]'), function (b) {
    b.onclick = function () {
      // Normalized to 'opp' for the actual event, matching every other
      // commit() call site -- 'us'/'them' is purely this screen's own
      // display-layer naming, same distinction xgtLiveTally() and
      // others already have to account for.
      var actorSide = side === 'them' ? 'opp' : side;
      commit({ actor: { side: actorSide, number: number }, action: 'exclusion', outcome: b.dataset.pgfOutcome,
               context: { kind: 'action', dir: null, dc: 'committed', note: 'post-game foul (' + b.dataset.pgfOutcome + ')' } });
      closeSheet();
      openOptions();
    };
  });
}
function openStats() {
  // Team mode gets a genuinely different structure -- a whole-team view
  // by side, with per-player drill-down -- rather than this function's
  // existing single-tracked-player layout, which has no real concept of
  // "which of several players" at all. Every other mode (parent, or
  // coach tracking one specific field player/goalkeeper) keeps exactly
  // the behavior below, unchanged.
  if (S.trackingMode === 'coach' && S.playerRole === 'team') { openTeamStats('us'); return; }
  var box = el('xgtStats');
  var gk = S.playerRole === 'goalkeeper', sc = scoreOf();
  var evs = actionEvents().filter(function (e) {
    return singlePlayerMode() ? (gk ? true : e.actor.side === 'us') : true;
  });
  // Shots faced by OUR keeper (opponent shot, our goalkeeper attributed)
  // and shots faced by THEIR keeper (our shot, their goalkeeper
  // attributed) -- e.goalkeeper is the reliable, side-agnostic marker
  // now (set on every team-mode event regardless of which action type
  // was eventually picked), replacing the old e.context.tree==='gk'
  // check. That check only ever matched events recorded against the
  // pre-unification GOALKEEPER_ACTIONS tree, and has been silently
  // empty for team mode ever since team mode stopped using that tree.
  var ourGkEvents = actionEvents().filter(function (e) { return e.action === 'shot' && e.actor && e.actor.side === 'opp' && e.goalkeeper != null; });
  var oppGkEvents = actionEvents().filter(function (e) { return e.action === 'shot' && e.actor && e.actor.side === 'us' && e.goalkeeper != null; });
  var showGk = gk || (S.trackingMode === 'coach' && ourGkEvents.length > 0);
  var tiles, extra = '';
  if (gk) {
    var g = goalkeeperStats(evs);
    tiles = [[g.faced, 'ON GOAL FACED'], [g.saves, 'SAVES / BLOCKS'], [g.pct + '%', 'SAVE %'],
             [g.goals, 'GOALS ALLOWED'], [g.missed, 'OFF TARGET'], [g.defBlocks, 'DEFENDER BLOCKS'],
             [g.postCrossbar, 'POST / CROSSBAR'],
             [g.penFaced, 'PENALTIES FACED'], [g.penSaves, 'PENALTY SAVES'], [g.attempts, 'TOTAL ATTEMPTS'],
             [g.steals, 'STEALS'], [g.turnovers, 'TURNOVERS'], [g.exDrawn, 'EXCL. DRAWN'],
             [g.outletCompleted, 'OUTLETS COMPLETED'], [g.outletTurnovers, 'OUTLET TURNOVERS']];
    extra = gkTypeTable(g);
  } else {
    var f = fieldPlayerStats(evs);
    tiles = [[f.goals, 'GOALS'], [f.shots, 'SHOTS'], [f.pct + '%', 'SHOOTING'],
             [f.steals, 'STEALS'], [f.turnovers, 'TURNOVERS'], [f.blocked, 'BLOCKED'],
             [f.exDrawn, 'EXCL. DRAWN'], [f.exGiven, 'EXCL. GIVEN'], [f.assists, 'ASSISTS'],
             [S.me.number != null ? fmt(waterSeconds(S.me.number)) : '—', 'IN WATER']];
    if (showGk) {
      extra += xgtOpposingKeeperBlockHtml('Our goalkeeper', ourGkEvents);
      // Symmetric -- our own shots' outcomes against their keeper, same
      // data already captured, shown only if there's actually anything
      // to show (e.g. suppressed entirely if opponent tracking isn't on
      // and no opposing keeper was ever attributed).
      extra += xgtOpposingKeeperBlockHtml('Their goalkeeper', oppGkEvents);
    }
  }
  var origin = gk ? evs.filter(function (e) { return e.action === 'shot'; })
                  : (showGk && S.trackingMode === 'coach' ? evs : evs);
  var chain = evs.filter(function (e) { return e.fieldZone && e.outcomeLabel; }).slice().reverse().slice(0, 30);

  box.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
      '<button class="xgtIcon" id="xgtSb">‹ Back</button>' +
      '<div style="flex:1;min-width:0"><div style="font-weight:700">' + (S.game.home || 'My team') + ' ' + sc[0] + ' – ' + sc[1] + ' ' + (S.game.away || 'Opponent') + '</div>' +
      '<div style="font-size:11.5px;color:#7c8a8a">' + (gk ? 'Goalkeeper' : 'Field player') + ' #' + S.me.number + ' · ' + evs.length + ' actions</div></div></div>' +
    '<div class="xgtTiles">' + tiles.map(function (t) {
      return '<div class="xgtTile"><div class="v">' + t[0] + '</div><div class="k">' + t[1] + '</div></div>';
    }).join('') + '</div>' + extra +
    '<h2>' + (gk ? 'Shot origin — where they shot from' : 'Where it happened') + '</h2>' +
    '<div class="xgtCard" style="padding:8px">' + heatFieldSvg(origin) + '</div>' +
    '<h2>Goal placement</h2><div class="xgtCard">' + goalMapHtml(evs) + '</div>' +
    missBlock(evs) +
    '<h2>Origin → outcome → placement</h2><div class="xgtCard">' +
      (chain.length ? '<table><tr><th>From</th><th>Type</th><th>Outcome</th><th>Placement</th></tr>' + chain.map(function (e) {
        return '<tr><td>' + e.fieldZoneName + '</td><td>' + (e.variantLabel || '—') + '</td><td>' + e.outcomeLabel + '</td><td>' +
          (e.goalPlacement ? e.goalPlacement.label : '—') + '</td></tr>';
      }).join('') + '</table>' : '<p class="xgtNote">Nothing recorded yet.</p>') +
      '<p class="xgtNote">Stored per event, not derived — this is what future goalkeeper analysis needs.</p></div>' +
    '<h2>Full log — tap any entry to correct or remove it</h2>' +
    '<button class="xgtBtn pri" id="xgtAddEvent" style="margin-bottom:9px">+ Add Event</button>' +
    '<div class="xgtCard">' + (S.events.length ? S.events.slice().reverse().map(function (e) {
      return '<div class="xgtLogRow" data-eid="' + e.eventId + '" style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #e1e6e6;align-items:baseline;cursor:pointer">' +
        '<span style="font-size:11px;color:#7c8a8a;width:56px;flex:none;font-variant-numeric:tabular-nums">Q' + e.quarter + ' ' + fmt(e.gameClock) + '</span>' +
        '<span style="flex:1;min-width:0;font-size:13px">' + describe(e) +
        '<small style="display:block;color:#7c8a8a;font-size:11px">' + (e.actionLabel || e.context.kind) + '</small></span>' +
        (e.fieldCoordinates ? '<span style="flex:none;font-size:10px;color:#7c8a8a;border:1px solid #ccd6d6;border-radius:6px;padding:4px 6px">⤢ Studio</span>' : '') +
        '<span style="flex:none;font-size:11px;color:#a9c2c2">✎</span>' +
        '</div>';
    }).join('') : '<p class="xgtNote">Nothing logged yet.</p>') + '</div>' +
    '<h2>Save this game</h2><div class="xgtCard">' +
      '<p class="xgtNote" style="margin-top:0">File: <b style="color:#d5dede">' + fileName() + '</b></p>' +
      '<div class="xgtRow"><button class="xgtBtn" id="xgtJson">Export JSON</button>' +
      '<button class="xgtBtn" id="xgtCsv">Export CSV</button></div>' +
      '<div id="xgtRaw" style="display:none;margin-top:10px"></div>' +
      '<p class="xgtNote">Autosaved locally after every tap. "New game" clears it.</p>' +
      '<button class="xgtBtn" id="xgtNew" style="margin-top:10px">Start a new game</button></div>';

  box.classList.add('on');
  el('xgtSb').onclick = function () { box.classList.remove('on'); };
  el('xgtAddEvent').onclick = function () {
    // Reuses the exact same zone -> action -> outcome -> placement flow
    // live tracking already uses, rather than a separate input form --
    // one flow to learn, and every field (zone, coordinates, variant,
    // placement) gets filled in exactly as it would from a real tap,
    // not approximated by hand. If the missing moment wasn't just now,
    // the existing Time button already lets the coach set the clock
    // back to when it happened first, then tap the zone as normal --
    // this button doesn't need its own separate time picker for that.
    box.classList.remove('on');
    toast('Tap the zone where it happened — adjust the clock first (✎ Time) if it wasn\u2019t just now.');
  };
  Array.prototype.forEach.call(box.querySelectorAll('.xgtLogRow'), function (row) {
    row.addEventListener('click', function () { openEditEvent(+row.dataset.eid); });
  });
  el('xgtJson').onclick = function () {
    download(fileName() + '.json', 'application/json', JSON.stringify({
      app: 'XquiX Game Tracker', stage: 'beta', schema: 3,
      field: { space: 'MIZE.Field', zoneSet: 'offense+outer', goal: GEO.goal, innerR: GEO.innerR, outerR: GEO.outerR },
      game: { date: S.game.date, loc: S.game.loc, home: S.game.home, away: S.game.away, finalScore: { home: sc[0], away: sc[1] } },
      trackingMode: S.trackingMode, playerRole: S.playerRole, trackedPlayer: S.me, squad: S.squad,
      events: S.events
    }, null, 2));
  };
  el('xgtCsv').onclick = function () {
    download(fileName() + '.csv', 'text/csv', xgtEventsToCsvString(S.events));
  };
  el('xgtNew').onclick = async function () {
    const ok = await MizeDialog.confirm('Clear this game and start a new one?');
    if (!ok) return;
    resetGameState();
    box.classList.remove('on');
    render(); openSetup();
  };
}
// Team mode's own stats entry point. Shows one side's aggregate numbers
// plus every one of its players, each tappable through to their own
// full detail view (openPlayerStats below) -- reusing the same
// heatFieldSvg/goalMapHtml/missBlock detail-rendering helpers the
// single-player path already uses, rather than a second, separately
// maintained copy of that rendering.
function openTeamStats(side) {
  var box = el('xgtStats');
  var sc = scoreOf();
  var squad = side === 'us' ? S.squad : S.oppSquad;
  var keepers = side === 'us' ? S.keepers : S.oppKeepers;
  var t = xgtTeamStats(side);
  var teamName = side === 'us' ? (S.game.home || 'My team') : (S.game.away || 'Opponent');
  var otherTeamName = side === 'us' ? (S.game.away || 'Opponent') : (S.game.home || 'My team');
  // Offensive: every shot THIS side took, wherever it went -- same
  // events feed both the field-origin map and the goal-placement map,
  // same pairing openPlayerStats() already uses for one player at a
  // time, just scoped to the whole side here instead of one number.
  var offensiveEvs = actionEvents().filter(function (e) { return e.actor && e.actor.side === side && e.action === 'shot'; });
  // Defensive: every shot the OTHER side took against this side's
  // goal -- the mirror image, showing what this team faced and how it
  // was handled, regardless of which specific keeper was between the
  // posts for any given shot.
  var defensiveEvs = actionEvents().filter(function (e) { return e.actor && e.actor.side !== side && e.action === 'shot'; });
  box.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
      '<button class="xgtIcon" id="xgtSb">‹ Back</button>' +
      '<div style="flex:1;min-width:0"><div style="font-weight:700">' + teamName + '</div>' +
      '<div style="font-size:11.5px;color:#7c8a8a">' + (S.game.home || 'My team') + ' ' + sc[0] + ' \u2013 ' + sc[1] + ' ' + (S.game.away || 'Opponent') + '</div></div></div>' +
    (S.opponentTracked
      ? '<div class="xgtSeg" id="xgtStatsSide" style="margin-bottom:10px">' +
        '<button data-stats-side="us" aria-pressed="' + (side === 'us') + '">' + (S.game.home || 'My Team') + '</button>' +
        '<button data-stats-side="opp" aria-pressed="' + (side === 'opp') + '">' + (S.game.away || 'Opponent') + '</button></div>'
      : '') +
    '<div class="xgtTiles">' + [[t.goals, 'GOALS'], [t.shots, 'SHOTS'], [t.pct + '%', 'SHOOTING'],
      [t.exDrawn, 'EXCL. DRAWN'], [t.exGiven, 'EXCL. GIVEN'], [t.steals, 'STEALS'],
      [t.turnovers, 'TURNOVERS'], [t.assists, 'ASSISTS']].map(function (x) {
        return '<div class="xgtTile"><div class="v">' + x[0] + '</div><div class="k">' + x[1] + '</div></div>';
      }).join('') + '</div>' +
    '<h2>Where ' + teamName + '\u2019s shots came from</h2>' +
    '<div class="xgtCard" style="padding:8px">' + heatFieldSvg(offensiveEvs) + '</div>' +
    '<h2>' + otherTeamName + '\u2019s goal \u2014 ' + teamName + '\u2019s shooting</h2><div class="xgtCard">' + goalMapHtml(offensiveEvs) + '</div>' +
    '<h2>' + teamName + '\u2019s goal \u2014 shots faced</h2><div class="xgtCard">' + goalMapHtml(defensiveEvs) + '</div>' +
    '<h2>Players \u2014 tap a number for their own stats</h2>' +
    '<div class="xgtPlayerTiles">' +
      squad.slice().sort(function (a, b) { return a - b; }).map(function (n) {
        var isGk = keepers.indexOf(n) >= 0;
        var ps = xgtPlayerStats(side, n, isGk);
        var goalsOrSaves = isGk ? ps.saves : ps.goals;
        return '<button class="xgtPlayerTile' + (isGk ? ' goalie' : '') + '" data-player-n="' + n + '">' +
          '<div class="num">' + xgtKeeperLabel(n) + '</div>' +
          '<div class="pstats"><span class="g">' + goalsOrSaves + (isGk ? ' sv' : ' g') + '</span><span class="f">' + (ps.exGiven || 0) + ' f</span></div>' +
        '</button>';
      }).join('') + '</div>';
  box.classList.add('on');
  el('xgtSb').onclick = function () { box.classList.remove('on'); };
  var sideToggle = el('xgtStatsSide');
  if (sideToggle) Array.prototype.forEach.call(sideToggle.querySelectorAll('[data-stats-side]'), function (b) {
    b.onclick = function () { openTeamStats(b.dataset.statsSide); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('.xgtPlayerTile'), function (tile) {
    tile.onclick = function () { openPlayerStats(side, +tile.dataset.playerN, function () { openTeamStats(side); }); };
  });
}
// One player's full detail view, reachable only from openTeamStats
// above -- reuses the exact same detail-rendering helpers (heat map,
// goal placement, misses, origin/outcome/placement chain) the
// single-player path in openStats() already relies on, just scoped to
// this one player's own events via xgtPlayerStats/xgtFieldPlayerEvents/
// xgtGoalkeeperEvents instead of the whole side.
function openPlayerStats(side, num, backFn) {
  var box = el('xgtStats');
  var isGk = (side === 'us' ? S.keepers : S.oppKeepers).indexOf(num) >= 0;
  var stats = xgtPlayerStats(side, num, isGk);
  var evs = isGk ? xgtGoalkeeperEvents(side, num) : xgtFieldPlayerEvents(side, num);
  var teamName = side === 'us' ? (S.game.home || 'My team') : (S.game.away || 'Opponent');
  var tiles = isGk
    ? [[stats.faced, 'ON GOAL FACED'], [stats.saves, 'SAVES / BLOCKS'], [stats.pct + '%', 'SAVE %'],
       [stats.goals, 'GOALS ALLOWED'], [stats.missed, 'OFF TARGET'], [stats.steals, 'STEALS'],
       [stats.turnovers, 'TURNOVERS'], [stats.exDrawn, 'EXCL. DRAWN'], [stats.exGiven, 'EXCL. GIVEN']]
    : [[stats.goals, 'GOALS'], [stats.shots, 'SHOTS'], [stats.pct + '%', 'SHOOTING'],
       [stats.steals, 'STEALS'], [stats.turnovers, 'TURNOVERS'], [stats.blocked, 'BLOCKED'],
       [stats.exDrawn, 'EXCL. DRAWN'], [stats.exGiven, 'EXCL. GIVEN'], [stats.assists, 'ASSISTS']];
  var origin = isGk ? evs.filter(function (e) { return e.action === 'shot'; }) : evs;
  var chain = evs.filter(function (e) { return e.fieldZone && e.outcomeLabel; }).slice().reverse().slice(0, 30);
  box.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
      '<button class="xgtIcon" id="xgtSb">‹ Back</button>' +
      '<div style="flex:1;min-width:0"><div style="font-weight:700">' + teamName + ' #' + xgtKeeperLabel(num) + (isGk ? ' \u2014 Goalkeeper' : '') + '</div>' +
      '<div style="font-size:11.5px;color:#7c8a8a">' + evs.length + ' actions</div></div></div>' +
    '<div class="xgtTiles">' + tiles.map(function (x) {
      return '<div class="xgtTile"><div class="v">' + x[0] + '</div><div class="k">' + x[1] + '</div></div>';
    }).join('') + '</div>' + (isGk ? gkTypeTable(stats) : '') +
    '<h2>' + (isGk ? 'Shot origin \u2014 where they shot from' : 'Where it happened') + '</h2>' +
    '<div class="xgtCard" style="padding:8px">' + heatFieldSvg(origin) + '</div>' +
    '<h2>Goal placement</h2><div class="xgtCard">' + goalMapHtml(evs) + '</div>' +
    missBlock(evs) +
    '<h2>Origin \u2192 outcome \u2192 placement</h2><div class="xgtCard">' +
      (chain.length ? '<table><tr><th>From</th><th>Type</th><th>Outcome</th><th>Placement</th></tr>' + chain.map(function (e) {
        return '<tr><td>' + e.fieldZoneName + '</td><td>' + (e.variantLabel || '\u2014') + '</td><td>' + e.outcomeLabel + '</td><td>' +
          (e.goalPlacement ? e.goalPlacement.label : '\u2014') + '</td></tr>';
      }).join('') + '</table>' : '<p class="xgtNote">Nothing recorded yet.</p>') + '</div>';
  box.classList.add('on');
  el('xgtSb').onclick = backFn;
}
function gkTypeTable(g) {
  return '<div class="xgtCard"><table><tr><th>Type</th><th style="text-align:right">On goal</th>' +
    '<th style="text-align:right">Saved</th><th style="text-align:right">%</th><th style="text-align:right">Off</th></tr>' +
    gkRow('Regular', g.regular, g.regularSaves, g.regularOff) +
    gkRow('Skip', g.skip, g.skipSaves, g.skipOff) +
    gkRow('Lob', g.lob, g.lobSaves, g.lobOff) +
    gkRow('Penalty', g.penFaced, g.penSaves, g.penOff) +
    '</table><p class="xgtNote" style="margin-bottom:0">Save rate by shot type. "Off" = went wide, over, or hit the frame.</p></div>';
}
function missBlock(evs) {
  var m = evs.filter(function (e) { return e.goalPlacement && e.goalPlacement.grid === 'miss'; });
  if (!m.length) return '';
  var c = {};
  m.forEach(function (e) { c[e.goalPlacement.label] = (c[e.goalPlacement.label] || 0) + 1; });
  return '<h2>Misses (' + m.length + ')</h2><div class="xgtCard"><table>' +
    Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }).map(function (k) {
      return '<tr><td>' + k + '</td><td style="text-align:right">' + c[k] + '</td></tr>';
    }).join('') + '</table></div>';
}
function download(name, type, data) {
  var ok = false;
  try {
    var b = new Blob([data], { type: type }), u = URL.createObjectURL(b);
    var a = document.createElement('a'); a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 2000); ok = true;
  } catch (err) {}
  var host = el('xgtRaw');
  if (host) {
    host.style.display = 'block';
    host.innerHTML = '<span class="xgtLbl">' + name + '</span><textarea readonly style="width:100%;height:170px;' +
      'border-radius:10px;padding:10px;background:#124d4d;border:1px solid rgba(255,255,255,.12);color:#fff;' +
      'font:12px/1.4 ui-monospace,Menlo,monospace;-webkit-user-select:text;user-select:text">' +
      data.replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }) + '</textarea>' +
      '<p class="xgtNote">' + (ok ? 'Download started. ' : '') + 'If nothing downloaded, long-press → Select All → Copy.</p>';
  }
}

/* ===================================================================== setup */
function openSetup() {
  openSheet();
  S.onScrim = function () { closeSheet(); API.close(); };
  draw();
  function draw() {
    var gk = S.playerRole === 'goalkeeper', team = S.playerRole === 'team';
    var notes = {
      field: 'Tap the zone where your player acted → what happened → outcome.',
      goalkeeper: 'Tap the zone the OPPONENT shot from → what happened → outcome. Your keeper stays the tracked player.',
      team: 'Tap the zone → pick which squad player acted → what happened → outcome. Tracks the whole team\u2019s game, not just one player.'
    };
    sheetEl().innerHTML = head('Game Tracker <span style="font-size:10px;background:#ffcc00;color:#14235c;padding:2px 6px;border-radius:5px;vertical-align:middle">BETA</span>',
        'Records what happened, so Studio can ask why', null) +
      '<span class="xgtLbl">Who is tracking</span>' +
      '<div class="xgtSeg" id="xgtTm">' +
        '<button data-tm="parent" aria-pressed="' + (S.trackingMode === 'parent') + '">Parent</button>' +
        '<button data-tm="coach" aria-pressed="' + (S.trackingMode === 'coach') + '">Coach / Team</button></div>' +
      '<span class="xgtLbl">Tracking role</span>' +
      '<div class="xgtSeg" id="xgtRl">' +
        '<button data-role="field" aria-pressed="' + (S.playerRole === 'field') + '">Field Player</button>' +
        '<button data-role="goalkeeper" aria-pressed="' + (S.playerRole === 'goalkeeper') + '">Goalkeeper</button>' +
        '<button data-role="team" aria-pressed="' + (S.playerRole === 'team') + '">Team</button></div>' +
      '<p class="xgtNote" style="margin:0 0 12px">' + notes[S.playerRole] + '</p>' +
      '<span class="xgtLbl">Game</span>' +
      '<div class="xgtRow"><input class="xgtField" id="xgtDate" type="date" value="' + (S.game.date || new Date().toISOString().slice(0, 10)) + '">' +
      '<input class="xgtField" id="xgtLoc" placeholder="Location" value="' + (S.game.loc || '') + '"></div>' +
      '<div class="xgtRow"><input class="xgtField" id="xgtHome" placeholder="My team" value="' + (S.game.home || '') + '">' +
      '<input class="xgtField" id="xgtAway" placeholder="Opponent" value="' + (S.game.away || '') + '"></div>' +
      // General, mode-independent -- most sessions are stats-first, not
      // scoreboard-first, so this stays off by default and is opt-in
      // regardless of parent/coach or field/goalkeeper/team, rather than
      // being scoped only to squad-tracking mode the way opponent
      // tracking is.
      '<div class="xgtRow" style="margin-top:6px"><label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:650;flex:1;cursor:pointer">' +
      '<input type="checkbox" id="xgtTrackScoreToggle" ' + (S.trackScore ? 'checked' : '') + '> Track game score</label></div>' +
      (
        // "Team" (under Coach) now means what it says: full squad, water,
        // goalies, opponent tracking. Field Player / Goalkeeper (under
        // either Coach or Parent) mean tracking one specific player's
        // individual game -- previously it was backwards (Field Player
        // showed the full squad, Team showed nothing at all and was
        // completely unusable if ever selected), which is exactly the
        // confusion this was rebuilt to fix.
        (S.trackingMode === 'coach' && team)
        ? '<span class="xgtLbl">Squad — tap every number dressed today</span><div class="xgtChips" id="xgtSquad">' +
          Array.apply(null, { length: 20 }).map(function (_, i) {
            return '<button class="xgtChip" data-n="' + (i + 1) + '" aria-pressed="' + (S.squad.indexOf(i + 1) >= 0) + '">' + (i + 1) + '</button>';
          }).join('') + '</div>' +
          '<span class="xgtLbl" style="margin-top:12px">Goalkeepers — tap their cap numbers</span>' +
          '<div class="xgtChips" id="xgtKeepers">' +
          (S.squad.length ? S.squad.map(function (n) {
            var isKeeper = S.keepers.indexOf(n) >= 0;
            return '<button class="xgtChip ' + (isKeeper ? 'goalie' : '') + '" data-k="' + n + '" aria-pressed="' + isKeeper + '">' + n + '</button>';
          }).join('') : '<span class="xgtNote">Pick the squad first.</span>') + '</div>' +
          (S.keepers.length
            ? '<p class="xgtNote" style="margin-top:8px">Some competitions label backup goalies 1A/1B/1C instead of a separate cap number — optional, leave blank to just show the number.</p>' +
              '<div id="xgtKeeperLabels">' + S.keepers.map(function (n) {
                return '<div class="xgtRow" style="margin-top:4px;align-items:center">' +
                  '<span style="width:34px;text-align:center;font-weight:700;color:#c0392b;flex:none">#' + n + '</span>' +
                  '<input class="xgtField" data-label-for="' + n + '" placeholder="Label (optional, e.g. 1A)" maxlength="4" value="' + (S.keeperLabels[n] || '') + '"></div>';
              }).join('') + '</div>'
            : '') +
          '<p class="xgtNote" style="margin-top:8px">Any opponent action you log is credited to whichever keeper is in the water, so you get their game for free.</p>' +
          '<div class="xgtRow" style="margin-top:14px"><label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:650;flex:1;cursor:pointer">' +
          '<input type="checkbox" id="xgtOppToggle" ' + (S.opponentTracked ? 'checked' : '') + '> Track opposing team too</label></div>' +
          (S.opponentTracked ?
            '<span class="xgtLbl" style="margin-top:10px">Their squad — tap every number they dressed</span><div class="xgtChips" id="xgtOppSquad">' +
            Array.apply(null, { length: 20 }).map(function (_, i) {
              return '<button class="xgtChip" data-opp-n="' + (i + 1) + '" aria-pressed="' + (S.oppSquad.indexOf(i + 1) >= 0) + '">' + (i + 1) + '</button>';
            }).join('') + '</div>' +
            '<span class="xgtLbl" style="margin-top:12px">Their goalkeepers — tap cap numbers</span>' +
            '<div class="xgtChips" id="xgtOppKeepers">' +
            (S.oppSquad.length ? S.oppSquad.map(function (n) {
              return '<button class="xgtChip" data-opp-k="' + n + '" aria-pressed="' + (S.oppKeepers.indexOf(n) >= 0) + '">' + n + '</button>';
            }).join('') : '<span class="xgtNote">Pick their squad first.</span>') + '</div>'
            : '')
        : '<span class="xgtLbl">' + (gk ? 'My goalkeeper' : 'My player') + '</span>' +
          '<div class="xgtRow"><input class="xgtField" id="xgtNum" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" ' +
          'placeholder="#" style="flex:0 0 90px;text-align:center;font-size:19px;font-weight:700" value="' + (S.me.number || '') + '">' +
          '<input class="xgtField" id="xgtName" placeholder="Name (optional)" value="' + (S.me.name || '') + '"></div>'
      ) +
      '<div class="xgtErr" id="xgtSetupErr"></div>' +
      '<button class="xgtBtn pri" id="xgtGo" style="margin-top:10px">Start tracking</button>' +
      '<p class="xgtNote">Front Court view switches on automatically.</p>';
    el('xgtX').onclick = function () { closeSheet(); API.close(); };
    Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-tm]'), function (b) {
      b.onclick = function () { grab(); S.trackingMode = b.dataset.tm; draw(); };
    });
    Array.prototype.forEach.call(sheetEl().querySelectorAll('[data-role]'), function (b) {
      b.onclick = function () { grab(); S.playerRole = b.dataset.role; draw(); };
    });
    var sq = el('xgtSquad');
    if (sq) Array.prototype.forEach.call(sq.querySelectorAll('[data-n]'), function (b) {
      b.onclick = function () {
        var n = +b.dataset.n, i = S.squad.indexOf(n);
        if (i >= 0) {
          S.squad.splice(i, 1);
          var k = S.keepers.indexOf(n); if (k >= 0) S.keepers.splice(k, 1);
          delete S.keeperLabels[n];
        } else {
          S.squad.push(n);
          // #1 defaults to goalie -- the overwhelmingly common convention --
          // but stays a plain, ordinary toggle the coach can freely undo via
          // the keeper chip below if their actual goalie wears a different number.
          if (n === 1 && S.keepers.indexOf(1) < 0) S.keepers.push(1);
        }
        S.squad.sort(function (a, b2) { return a - b2; });
        S.keepers.sort(function (a, b2) { return a - b2; });
        el('xgtSetupErr').classList.remove('on');
        grab(); draw();
      };
    });
    var kp = el('xgtKeepers');
    if (kp) Array.prototype.forEach.call(kp.querySelectorAll('[data-k]'), function (b) {
      b.onclick = function () {
        var n = +b.dataset.k, i = S.keepers.indexOf(n);
        if (i >= 0) { S.keepers.splice(i, 1); delete S.keeperLabels[n]; } else S.keepers.push(n);
        S.keepers.sort(function (a, b2) { return a - b2; });
        grab(); draw(); // re-render, not just toggle the one chip's attribute -- the label-input list below needs to show/hide/reorder with the keeper set
      };
    });
    var klWrap = el('xgtKeeperLabels');
    if (klWrap) Array.prototype.forEach.call(klWrap.querySelectorAll('[data-label-for]'), function (inp) {
      inp.oninput = function () {
        var n = +inp.dataset.labelFor, v = inp.value.trim();
        if (v) S.keeperLabels[n] = v; else delete S.keeperLabels[n];
      };
    });
    var oppToggle = el('xgtOppToggle');
    if (oppToggle) oppToggle.onchange = function () { S.opponentTracked = oppToggle.checked; grab(); draw(); };
    var scoreToggle = el('xgtTrackScoreToggle');
    // No re-draw needed here, unlike oppToggle -- this doesn't reveal any
    // additional setup UI, it only affects the live tracker's top bar,
    // which render() keeps in sync independently.
    if (scoreToggle) scoreToggle.onchange = function () { S.trackScore = scoreToggle.checked; };
    var oppSq = el('xgtOppSquad');
    if (oppSq) Array.prototype.forEach.call(oppSq.querySelectorAll('[data-opp-n]'), function (b) {
      b.onclick = function () {
        var n = +b.dataset.oppN, i = S.oppSquad.indexOf(n);
        if (i >= 0) {
          S.oppSquad.splice(i, 1);
          var k = S.oppKeepers.indexOf(n); if (k >= 0) S.oppKeepers.splice(k, 1);
        } else S.oppSquad.push(n);
        S.oppSquad.sort(function (a, b2) { return a - b2; });
        grab(); draw();
      };
    });
    var oppKp = el('xgtOppKeepers');
    if (oppKp) Array.prototype.forEach.call(oppKp.querySelectorAll('[data-opp-k]'), function (b) {
      b.onclick = function () {
        var n = +b.dataset.oppK, i = S.oppKeepers.indexOf(n);
        if (i >= 0) S.oppKeepers.splice(i, 1); else S.oppKeepers.push(n);
        S.oppKeepers.sort(function (a, b2) { return a - b2; });
        b.setAttribute('aria-pressed', String(i < 0));
      };
    });
    el('xgtGo').onclick = go;
  }
  function grab() {
    if (el('xgtDate')) S.game = { date: el('xgtDate').value, loc: el('xgtLoc').value, home: el('xgtHome').value, away: el('xgtAway').value };
    if (el('xgtNum')) S.me = { number: parseInt(el('xgtNum').value, 10) || null, name: (el('xgtName').value || '').trim() };
  }
  function err(m) { var e = el('xgtSetupErr'); e.textContent = m; e.classList.add('on'); }
  function go() {
    grab();
    // Matches openZone()'s singlePlayerMode: every combination except
    // coach+team needs a single tracked player's cap number entered.
    // This used to only require it for parent mode or coach+goalkeeper --
    // silently correct back when coach+field meant squad tracking, but
    // would have left coach+field's new single-player entry unvalidated.
    var needsPlayer = !(S.trackingMode === 'coach' && S.playerRole === 'team');
    if (needsPlayer && !S.me.number) { err('Enter the cap number first — the box marked #.'); return; }
    if (!S.cloudSessionName) {
      var oppName = (S.game.away || '').trim();
      var dateStr = S.game.date || new Date().toISOString().slice(0, 10);
      var timeStr = new Date().toTimeString().slice(0, 8); // HH:MM:SS -- genuinely useful (distinguishes a double-header), and guards against same-day-same-opponent sessions colliding on the upsert-by-name key; minute-level granularity alone proved insufficient in testing (two sessions started in the same minute collided)
      S.cloudSessionName = (oppName ? ('vs ' + oppName) : 'Untitled session') + ' \u00b7 ' + dateStr + ' \u00b7 ' + timeStr;
    }
    if (S.trackingMode === 'coach' && S.playerRole === 'team') {
      if (S.squad.length < 7) { err('Tap at least 7 squad numbers (you have ' + S.squad.length + ').'); return; }
      if (S.opponentTracked && S.oppSquad.length < 7) { err('Tap at least 7 numbers for the opposing squad too (you have ' + S.oppSquad.length + ').'); return; }
      S.water = S.squad.slice(0, 7);
      if (S.keepers.length && S.water.indexOf(S.keepers[0]) < 0) { S.water[0] = S.keepers[0]; S.water.sort(function (a, b) { return a - b; }); }
      if (S.opponentTracked) {
        S.oppWater = S.oppSquad.slice(0, 7);
        if (S.oppKeepers.length && S.oppWater.indexOf(S.oppKeepers[0]) < 0) { S.oppWater[0] = S.oppKeepers[0]; S.oppWater.sort(function (a, b) { return a - b; }); }
      }
      S.water.forEach(function (n) {
        commit({ actor: { side: 'us', number: n }, context: { kind: 'presence', dir: 'in', trackingMode: 'coach', dc: null, note: null } });
      });
      if (S.opponentTracked) {
        S.oppWater.forEach(function (n) {
          commit({ actor: { side: 'them', number: n }, context: { kind: 'presence', dir: 'in', trackingMode: 'coach', dc: null, note: null } });
        });
      }
    } else {
      commit({ actor: { side: 'us', number: S.me.number },
               context: { kind: 'presence', dir: 'in', trackingMode: S.trackingMode, dc: null, note: null } });
    }
    closeSheet(); render();
    // The one settle-in pass in open() ran BEFORE this point -- against
    // whatever #xgtBottom looked like right after that initial render(),
    // not against its real, final content. Team mode's presence commits
    // just above can add several lines to the log strip, genuinely
    // growing the chrome's height beyond what that earlier pass
    // measured -- without a fresh fit here, the field's scrollable area
    // stays sized against the smaller, stale measurement, leaving the
    // true bottom of the field covered by chrome that grew after the
    // fact.
    if (window.MIZE.Field && window.MIZE.Field.fitBoardToScreen) { try { window.MIZE.Field.fitBoardToScreen(); } catch (err) {} }
    xgtCorrectStageWrapOverlap();
  }
}

/* ============================================================ public surface */
// Studio's own fitBoardToScreen() sizes #stageWrap against the raw
// viewport height, with no idea the tracker's own top/bottom chrome
// (score bar, undo/log strip) visually overlays part of that space --
// without this, #stageWrap ends up taller than what's actually visible
// behind the chrome, so the goal and deck sections at either end never
// scroll into view no matter how far the coach drags. Temporarily
// wrapping the one function Studio's own sizing already reads from
// (rather than adding a competing transform, which is exactly the bug
// this whole rewrite removed) lets Studio compute the right size
// itself, honestly, for as long as tracking is active.
var _origViewportHeight = (typeof window.viewportHeight === 'function') ? window.viewportHeight : null;
function xgtViewportHeight() {
  var full = _origViewportHeight ? _origViewportHeight() : (window.visualViewport ? window.visualViewport.height : window.innerHeight);
  if (!S.active) return full;
  var top = el('xgtTop'), bot = el('xgtBottom');
  var topH = top ? top.getBoundingClientRect().height : 0;
  var botH = bot ? bot.getBoundingClientRect().height : 0;
  // Lowered from 220 -- on a real phone in landscape, top+bottom chrome
  // can genuinely add up to more than (viewport height - 220), even
  // after the log strip is hidden there (see the landscape media query
  // above). A 220px floor in that situation didn't protect against a
  // too-small field -- it caused the opposite problem: the computed
  // area stayed LARGER than what was actually left over, so the
  // scrollable field's own box physically overlapped the chrome below
  // it, which is what made the field appear to vanish entirely rather
  // than just be a bit cramped. A smaller but correctly-non-overlapping
  // field is a real improvement over a larger one that's covered by
  // its own chrome.
  return Math.max(130, full - topH - botH);
}
// fitBoardToScreen() itself ALSO applies its own, separate,
// hardcoded 220px floor internally (Math.max(220, viewportHeight()-
// margin)) -- that's shared Studio code, used by every mode, not
// something to change just for this one case. So lowering this
// wrapper's own floor above wasn't enough on its own: Studio's
// function still clamps #stageWrap back up to 220px regardless of
// what this wrapper returns, whenever the true available space is
// less than that -- which is routinely true in phone landscape.
// This runs immediately after every fitBoardToScreen() call the
// tracker itself triggers (open()'s settle-in pass, onViewportChange,
// and go()'s post-setup re-fit) and, only when the true, correctly-
// computed height is smaller than what Studio's own floor already
// clamped #stageWrap to, corrects it down to the honest value. Never
// makes the field bigger than Studio already sized it -- only ever
// shrinks it further, and only when necessary to stop it from
// overlapping the chrome below it. #board's own height/scale is
// untouched here; only #stageWrap's visible-window height changes,
// which is safe since the two are otherwise independent (the field's
// own geometry doesn't depend on how much of it happens to be
// visible at once).
function xgtCorrectStageWrapOverlap() {
  if (!S.active) return;
  var wrap = el('stageWrap');
  if (!wrap) return;
  var honestH = xgtViewportHeight() - 20; // matches fitBoardToScreen()'s own margin subtraction for non-presentation contexts
  var currentH = parseFloat(wrap.style.height) || wrap.getBoundingClientRect().height;
  if (honestH > 0 && honestH < currentH) {
    wrap.style.height = honestH + 'px';
  }
}
// Same wrap-the-one-function-Studio-already-calls pattern as
// xgtViewportHeight above, for a different problem: #xgtShield is
// deliberately built with a z-index far above every Studio panel (so no
// Studio tool can fire while tracking is on), which means it also sits
// on top of the Coaching Library when the "Sessions" button opens it
// mid-game -- confirmed directly by testing, not assumed: the panel
// rendered correctly but every click on it was silently swallowed by
// the shield underneath. Installed once, globally; the flag check makes
// it a true no-op for every other closeToolPanels() call throughout the
// app that has nothing to do with this module.
var _origCloseToolPanels = (typeof window.closeToolPanels === 'function') ? window.closeToolPanels : null;
function xgtCloseToolPanels() {
  if (_origCloseToolPanels) _origCloseToolPanels();
  if (S.shieldSuspendedForToolPanel) {
    S.shieldSuspendedForToolPanel = false;
    var shield = el('xgtShield'), block = el('xgtBlock'), oppoZone = el('xgtOppoZone');
    if (shield) shield.style.pointerEvents = '';
    if (block) block.style.pointerEvents = '';
    if (oppoZone) oppoZone.style.pointerEvents = '';
  }
}
if (_origCloseToolPanels) window.closeToolPanels = xgtCloseToolPanels;
// Shared by renderSessionStatsHtml (one game) and
// renderCombinedSessionStatsHtml (several games merged) below -- both
// need the identical tiles/heat-map/goal-map/chain-table body, differing
// only in what header sits above it. Extracted here rather than
// duplicated or string-sliced between the two, since an earlier attempt
// at slicing the single-session header off the combined output turned
// out to only strip the inner score-line div, leaving the subtitle line
// behind -- fragile in exactly the way a real shared helper isn't.
function xgtStatsBodyParts(evs, playerRole, trackingMode) {
  var gk = playerRole === 'goalkeeper';
  // Same exclusion as the live actionEvents() above -- shootout attempts
  // stay out of regular shooting stats here too, since this is what
  // renders the saved-session and combined-session views.
  var actionEvs = evs.filter(function (e) { return e.context && e.context.kind === 'action' && !e.context.shootout; });
  var filteredEvs = actionEvs.filter(function (e) {
    // Same singlePlayerMode() logic as the live path, inlined against the
    // passed-in parameters since this also has to work on saved-session
    // data where the live S object isn't the source of truth.
    var singlePlayer = !(trackingMode === 'coach' && playerRole === 'team');
    return singlePlayer ? (gk ? true : e.actor.side === 'us') : true;
  });
  var ourGkEvents = actionEvs.filter(function (e) { return e.action === 'shot' && e.actor && e.actor.side === 'opp' && e.goalkeeper != null; });
  var oppGkEvents = actionEvs.filter(function (e) { return e.action === 'shot' && e.actor && e.actor.side === 'us' && e.goalkeeper != null; });
  var showGk = gk || (trackingMode === 'coach' && ourGkEvents.length > 0);
  var tiles, extra = '';
  if (gk) {
    var g = goalkeeperStats(filteredEvs);
    tiles = [[g.faced, 'ON GOAL FACED'], [g.saves, 'SAVES / BLOCKS'], [g.pct + '%', 'SAVE %'],
             [g.goals, 'GOALS ALLOWED'], [g.missed, 'OFF TARGET'], [g.defBlocks, 'DEFENDER BLOCKS'],
             [g.postCrossbar, 'POST / CROSSBAR'],
             [g.penFaced, 'PENALTIES FACED'], [g.penSaves, 'PENALTY SAVES'], [g.attempts, 'TOTAL ATTEMPTS'],
             [g.steals, 'STEALS'], [g.turnovers, 'TURNOVERS'], [g.exDrawn, 'EXCL. DRAWN'],
             [g.outletCompleted, 'OUTLETS COMPLETED'], [g.outletTurnovers, 'OUTLET TURNOVERS']];
    extra = gkTypeTable(g);
  } else {
    var f = fieldPlayerStats(filteredEvs);
    tiles = [[f.goals, 'GOALS'], [f.shots, 'SHOTS'], [f.pct + '%', 'SHOOTING'],
             [f.steals, 'STEALS'], [f.turnovers, 'TURNOVERS'], [f.blocked, 'BLOCKED'],
             [f.exDrawn, 'EXCL. DRAWN'], [f.exGiven, 'EXCL. GIVEN'], [f.assists, 'ASSISTS']];
    if (showGk) {
      extra += xgtOpposingKeeperBlockHtml('Our goalkeeper', ourGkEvents);
      extra += xgtOpposingKeeperBlockHtml('Their goalkeeper', oppGkEvents);
    }
  }
  var origin = gk ? filteredEvs.filter(function (e) { return e.action === 'shot'; }) : filteredEvs;
  var chain = filteredEvs.filter(function (e) { return e.fieldZone && e.outcomeLabel; }).slice().reverse().slice(0, 30);
  var html =
    '<div class="xgtTiles">' + tiles.map(function (t) {
      return '<div class="xgtTile"><div class="v">' + t[0] + '</div><div class="k">' + t[1] + '</div></div>';
    }).join('') + '</div>' + extra +
    '<h2>' + (gk ? 'Shot origin — where they shot from' : 'Where it happened') + '</h2>' +
    '<div class="xgtCard" style="padding:8px">' + heatFieldSvg(origin) + '</div>' +
    '<h2>Goal placement</h2><div class="xgtCard">' + goalMapHtml(filteredEvs) + '</div>' +
    missBlock(filteredEvs) +
    '<h2>Origin → outcome → placement</h2><div class="xgtCard">' +
      (chain.length ? '<table><tr><th>From</th><th>Type</th><th>Outcome</th><th>Placement</th></tr>' + chain.map(function (e) {
        return '<tr><td>' + e.fieldZoneName + '</td><td>' + (e.variantLabel || '—') + '</td><td>' + e.outcomeLabel + '</td><td>' +
          (e.goalPlacement ? e.goalPlacement.label : '—') + '</td></tr>';
      }).join('') + '</table>' : '<p class="xgtNote">Nothing recorded.</p>') +
      '</div>';
  return { html: html, actionCount: filteredEvs.length, gk: gk, tiles: tiles };
}
// Loaded on demand, only when a coach actually taps "Export PDF" -- not
// a static <script> tag alongside Supabase's, since that would add load
// weight for every coach regardless of whether they ever use this paid
// feature. Pinned to a specific version (matching how Supabase itself is
// pinned above) rather than @latest, so a future jsPDF release can't
// silently change behavior underneath an already-shipped export button.
var _jspdfLoadPromise = null;
function loadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (_jspdfLoadPromise) return _jspdfLoadPromise;
  _jspdfLoadPromise = new Promise(function (resolve, reject) {
    var script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/4.2.1/jspdf.umd.min.js';
    script.onload = function () {
      if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
      else reject(new Error('The PDF export library loaded but wasn\u2019t in the expected shape.'));
    };
    script.onerror = function () { reject(new Error('Could not load the PDF export library \u2014 check your connection and try again.')); };
    document.head.appendChild(script);
  }).catch(function (err) {
    _jspdfLoadPromise = null; // allow a retry on the next click rather than permanently caching one transient failure
    throw err;
  });
  return _jspdfLoadPromise;
}
// jsPDF embeds raster images or its own vector primitives, not raw SVG
// directly -- this rasterizes an already-rendered <svg> DOM element (the
// same one currently on screen, not a separately regenerated copy) to a
// PNG data URI via canvas, at 2x scale for print sharpness. A white
// background fill matters here: heatFieldSvg's own background is opaque
// already, but goalMapHtml's is not, and an unfilled canvas defaults to
// transparent black in most PDF viewers rather than the white a printed
// page needs.
function xgtSvgToPngDataUri(svgEl) {
  return new Promise(function (resolve, reject) {
    if (!svgEl) { reject(new Error('No visualization to export.')); return; }
    try {
      var svgString = new XMLSerializer().serializeToString(svgEl);
      var svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(svgBlob);
      var img = new Image();
      img.onload = function () {
        var rect = svgEl.getBoundingClientRect();
        var scale = 2;
        var w = Math.max(1, Math.round((rect.width || 400) * scale));
        var h = Math.max(1, Math.round((rect.height || 300) * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve({ dataUri: canvas.toDataURL('image/png'), width: w, height: h });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not render a visualization for export.')); };
      img.src = url;
    } catch (err) { reject(err); }
  });
}
// Shared by exportCombinedStatsPdf and exportSingleSessionPdf below --
// both need identical jsPDF document-building mechanics (title, stats-
// as-text, rasterized heat/goal images, page-overflow handling),
// differing only in what header/session-list content sits above the
// shared stats body. Extracted here rather than duplicated, matching the
// same reasoning renderSessionStatsHtml/renderCombinedSessionStatsHtml
// already established for xgtStatsBodyParts() -- Promise.all preserves
// input-array order regardless of completion timing, so heatImg/goalImg
// can be read straight off fixed result indices without the kind-
// tagging the original single-purpose version used.
// Shared by the live CSV export button (S.events) and the new saved/
// combined-session CSV export below (a saved or merged events array) --
// identical column structure and quoting either way, extracted here
// rather than duplicated for the same reason xgtStatsBodyParts()/
// xgtBuildStatsPdf() already were.
function xgtEventsToCsvString(events) {
  var rows = [['eventId', 'quarter', 'clock', 'kind', 'role', 'side', 'number', 'zone', 'zoneName',
               'fieldX_m', 'fieldY_m', 'action', 'shotType', 'outcome', 'drawnCommitted',
               'goalPlacement', 'assist', 'foulCounterpartSide', 'foulCounterpartNumber', 'possession', 'reboundFollowup', 'blockResult', 'goalkeeper', 'targetGoal', 'timestamp']];
  (events || []).forEach(function (e) {
    var fc = e.fieldCoordinates || {};
    var fcp = e.foulCounterpart || {};
    rows.push([e.eventId, e.quarter, fmt(e.gameClock), e.context.kind, e.playerRole,
      e.actor ? e.actor.side : '', e.actor && e.actor.number != null ? e.actor.number : '',
      e.fieldZone || '', e.fieldZoneName || '', fc.fx == null ? '' : fc.fx, fc.fy == null ? '' : fc.fy,
      e.actionLabel || e.context.dir || '', e.variantLabel || '', e.outcomeLabel || '', e.context.dc || '',
      e.goalPlacement ? e.goalPlacement.label : '', e.assist == null ? '' : e.assist,
      fcp.side || '', fcp.number == null ? '' : fcp.number, e.possession || '', e.reboundFollowup || '', e.blockResult || '',
      e.goalkeeper == null ? '' : e.goalkeeper, e.targetGoal || '', e.timestamp]);
  });
  return rows.map(function (r) {
    return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
}
function xgtBuildStatsPdf(jsPDFCtor, opts) {
  var viz = opts.vizElements || {};
  return Promise.all([
    viz.heatSvg ? xgtSvgToPngDataUri(viz.heatSvg).catch(function () { return null; }) : Promise.resolve(null),
    viz.goalSvg ? xgtSvgToPngDataUri(viz.goalSvg).catch(function () { return null; }) : Promise.resolve(null)
  ]).then(function (results) {
    var heatImg = results[0], goalImg = results[1];
    var doc = new jsPDFCtor({ orientation: 'p', unit: 'pt', format: 'a4' });
    var pageW = doc.internal.pageSize.getWidth();
    var pageH = doc.internal.pageSize.getHeight();
    var margin = 40, y = margin;
    function ensureSpace(needed) { if (y + needed > pageH - margin) { doc.addPage(); y = margin; } }
    function addTitle(text) { ensureSpace(24); doc.setFontSize(16); doc.setFont(undefined, 'bold'); doc.text(text, margin, y); y += 20; doc.setFont(undefined, 'normal'); }
    function addSubheading(text) { ensureSpace(18); doc.setFontSize(12); doc.setFont(undefined, 'bold'); doc.text(text, margin, y); y += 16; doc.setFont(undefined, 'normal'); }
    function addLine(text) { ensureSpace(14); doc.setFontSize(10); doc.text(text, margin, y); y += 14; }

    addTitle(opts.title);
    addLine(opts.subtitle);
    y += 6;

    if (opts.sessionLines && opts.sessionLines.length) {
      addSubheading('Sessions included');
      opts.sessionLines.forEach(addLine);
      y += 10;
    }

    addSubheading('Stats');
    // Plain text lines rather than trying to replicate the on-screen
    // tile boxes exactly -- simpler and more reliably legible once
    // printed than reconstructing a grid layout in jsPDF's own
    // (non-flow, manually-positioned) drawing model.
    opts.parts.tiles.forEach(function (t) { addLine(t[1] + ':  ' + t[0]); });
    y += 10;

    if (heatImg) {
      addSubheading(opts.parts.gk ? 'Shot origin' : 'Where it happened');
      var hw = Math.min(pageW - margin * 2, 300), hh = hw * (heatImg.height / heatImg.width);
      ensureSpace(hh + 10);
      doc.addImage(heatImg.dataUri, 'PNG', margin, y, hw, hh);
      y += hh + 14;
    }
    if (goalImg) {
      addSubheading('Goal placement');
      var gw = Math.min(pageW - margin * 2, 300), gh = gw * (goalImg.height / goalImg.width);
      ensureSpace(gh + 10);
      doc.addImage(goalImg.dataUri, 'PNG', margin, y, gw, gh);
      y += gh + 14;
    }

    doc.save(opts.filename);
    return opts.filename;
  });
}
var API = {
  open: function () {
    if (S.active) return;
    if (!window.MIZE || !el('fieldZonesSvg')) {
      window.alert('Game Tracker needs the XquiX Studio field — load it after the Studio scripts.');
      return;
    }
    S.active = true;
    // Studio's own navigation chrome (the edge tabs, header/sidebar close
    // handles) sit at a lower z-index than this tracker's own chrome, but
    // the tracker's middle field area is deliberately transparent to show
    // the underlying field -- so anything positioned in that middle
    // region (the edge tabs specifically, vertically centered on the
    // right) was still visually showing through AND clickable, not just
    // theoretically stacked behind. This class drives the CSS that hides
    // them for as long as the tracker is open, same body-class pattern
    // already used for body.presentation/body.viewerModeActive elsewhere.
    document.body.classList.add('gameTrackerActive');
    S.zoneNumberOverrides = loadZoneNumberOverrides();
    injectCss(); buildChrome();
    S.hadFrontCourt = frontCourtOn();
    // Same save-before-modify, restore-on-close pattern as Front Court
    // above -- the coach's actual board (whatever formation/players were
    // there before opening the tracker) is never lost, just temporarily
    // set aside while tracking uses an empty pool as its backdrop.
    try { S.savedBoardState = (typeof getState === 'function') ? getState() : null; } catch (err) { S.savedBoardState = null; }
    try { if (typeof newBoard === 'function') newBoard(); } catch (err) {}
    // Swapped in AFTER buildChrome() (so #xgtTop/#xgtBottom already
    // exist to measure) and BEFORE toggleFrontCourt() below, since that
    // call is what actually triggers Studio's fitBoardToScreen() and
    // needs the corrected height already in place the first time it runs.
    if (typeof window.viewportHeight === 'function') window.viewportHeight = xgtViewportHeight;
    // Always track in Front Court -- the same scrollable venue Studio's
    // regular mode uses, goal to goal, not a separate cropped view of
    // our own. There's no toggle away from this anymore (the old "Court"
    // button is gone): switching away would just reintroduce the wrong,
    // non-scrollable geometry this replaces. fitBoardToScreen() (called
    // via toggleFrontCourt) sizes #stageWrap as a genuinely taller-than-
    // viewport, natively scrollable container and sets a sensible
    // starting scroll position -- nothing here needs its own transform
    // on top of that.
    if (window.MIZE.Field && window.MIZE.Field.toggleFrontCourt) {
      try { window.MIZE.Field.toggleFrontCourt(true); } catch (err) {}
    }
    drawOverlay(null);
    watchShield(true);
    // toggleFrontCourt() above sized the field before the chrome's
    // bottom panel had its actual content (log, undo strip) -- it grows
    // once render()/openSetup() below populate it, which the earlier
    // measurement couldn't have known about. One more sizing pass here,
    // after that content exists, corrects for the real chrome height.
    // Deliberately not repeated on every render() after this (see the
    // comment there) -- just this one settle-in pass right after open.
    setTimeout(function () {
      if (window.MIZE.Field && window.MIZE.Field.fitBoardToScreen) { try { window.MIZE.Field.fitBoardToScreen(); } catch (err) {} }
      xgtCorrectStageWrapOverlap();
      showFullVenueWidth();
      positionShield();
    }, 60);
    var saved = loadSaved();
    var canResume = !!(saved && saved.events && saved.events.length && !saved.officiallyEnded);
    if (!canResume) {
      // No resumable game -- but S itself is a page-lifetime variable,
      // not something that re-initializes on its own just because the
      // tracker closed and reopened. Without this, a coach who closed
      // the tracker after a game without explicitly starting a new one
      // (or hit some edge case where the autosave didn't persist) could
      // reopen it later in the same browser session and land in the
      // landing screen while S still silently held the previous game's
      // score and events underneath. Safe either way: a no-op if S was
      // already clean, corrective if it wasn't, and still saves first
      // via resetGameState() if there's anything there worth keeping.
      // Also covers the case where a saved game exists but is
      // officially ended -- already persisted, nothing left to resume
      // from it locally.
      resetGameState();
    }
    openGameTrackerLanding(canResume ? saved : null);
  },
  close: function () {
    if (!S.active) return;
    S.active = false;
    document.body.classList.remove('gameTrackerActive');
    S.running = false; clearInterval(S.tick);
    S.shieldSuspendedForToolPanel = false; // no shield left to restore once removeChrome() below runs anyway, but avoids a stale flag if reopened later
    removeChrome(); removeOverlay();
    restoreVenueWidth();
    if (frontCourtOn() !== S.hadFrontCourt && window.MIZE.Field && window.MIZE.Field.toggleFrontCourt) {
      try { window.MIZE.Field.toggleFrontCourt(S.hadFrontCourt); } catch (err) {}
    }
    // Restored AFTER the toggleFrontCourt() call above, for the same
    // reason it was swapped in before its counterpart in open(): that
    // call re-triggers Studio's own sizing, and if the coach really was
    // in Front Court before (S.hadFrontCourt), it should size against
    // the tracker's chrome one last time (which is still on screen at
    // this exact point) rather than against the full, chrome-free
    // viewport too early.
    if (_origViewportHeight) window.viewportHeight = _origViewportHeight;
    if (S.savedBoardState) {
      try { if (typeof loadState === 'function') loadState(S.savedBoardState); } catch (err) {}
      S.savedBoardState = null;
    }
  },
  isOpen: function () { return S.active; },
  state: S,
  zones: ZONES,
  hitZone: hitZone,
  screenToBoard: screenToBoard,
  boardToClient: boardToClient,
  FIELD_PLAYER_ACTIONS: FIELD_PLAYER_ACTIONS,
  GOALKEEPER_ACTIONS: GOALKEEPER_ACTIONS,
  events: function () { return S.events.slice(); },
  // Read-only stats rendering for a SAVED session record (Phase B --
  // "View Stats" from the Coaching Library), completely separate from
  // openStats() and never touching the live S object. This matters: a
  // coach could be mid-game, tap into the Library to check a past
  // session, and tap back out -- if this shared S.events with the live
  // tracker even briefly, that would risk corrupting the in-progress
  // game. Reuses the same stateless computation helpers openStats()
  // itself calls (goalkeeperStats/fieldPlayerStats/heatFieldSvg/
  // goalMapHtml/missBlock/gkTypeTable all already take an explicit
  // events array, not S), just with its own simpler HTML around them --
  // no add-event/edit-event/new-game affordances, since none of those
  // make sense for a completed, saved game. Returns an HTML string for
  // the Library's own detail view to inject; this module never renders
  // it directly, since #libraryDetailBody lives outside this IIFE.
  renderSessionStatsHtml: function (sessionRecord) {
    var d = sessionRecord || {};
    var sc = d.finalScore || { home: 0, away: 0 };
    var parts = xgtStatsBodyParts(d.events || [], d.playerRole, d.trackingMode);
    var trackedNum = d.trackedPlayer && d.trackedPlayer.number != null ? d.trackedPlayer.number : null;
    var btnStyle = 'flex:none;border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;font-size:12px;';
    return (
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">' +
        '<div><div style="font-weight:700">' + (d.game && d.game.home || 'My team') + ' ' + sc.home + ' – ' + sc.away + ' ' + (d.game && d.game.away || 'Opponent') + '</div>' +
        '<div style="font-size:11.5px;color:#7c8a8a">' + (parts.gk ? 'Goalkeeper' : 'Field player') + (trackedNum != null ? ' #' + trackedNum : '') + ' · ' + parts.actionCount + ' actions' + (d.game && d.game.date ? ' · ' + d.game.date : '') + '</div></div>' +
        '<div style="display:flex;gap:6px;flex:none">' +
          '<button type="button" id="xgtSessionCsvBtn" style="' + btnStyle + 'background:#e1e6e6;color:#124d4d;">Export CSV</button>' +
          '<button type="button" id="xgtSessionPdfBtn" style="' + btnStyle + 'background:#1b7373;color:#fff;">Export PDF</button>' +
        '</div>' +
      '</div>' +
      parts.html
    );
  },
  // Phase C: the paid, multi-session view -- combines events from
  // several saved sessions into one merged array and hands it to the
  // exact same xgtStatsBodyParts() helper renderSessionStatsHtml() above
  // uses, rather than any separate aggregation logic of its own. Guarded
  // UI upstream (the Library's own checkbox handler) already prevents
  // mismatched playerRole/trackedPlayer combinations from reaching here,
  // but this re-checks defensively rather than trusting that guard
  // blindly, since this method could in principle be called from
  // somewhere else later that doesn't go through it.
  renderCombinedSessionStatsHtml: function (sessionRecords) {
    var recs = (sessionRecords || []).filter(Boolean);
    if (!recs.length) return '<p class="xgtNote">No sessions to combine.</p>';
    var first = recs[0];
    var mismatched = recs.some(function (r) {
      return r.playerRole !== first.playerRole ||
        (first.trackingMode === 'parent' && r.trackingMode === 'parent' &&
         (r.trackedPlayer || {}).number !== (first.trackedPlayer || {}).number);
    });
    if (mismatched) return '<p class="xgtNote">These sessions can\u2019t be combined — they track different roles or players.</p>';
    var mergedEvents = [];
    recs.forEach(function (r) { mergedEvents = mergedEvents.concat(r.events || []); });
    var totalHome = 0, totalAway = 0;
    recs.forEach(function (r) { var sc = r.finalScore || { home: 0, away: 0 }; totalHome += sc.home; totalAway += sc.away; });
    var sessionListHtml = '<ul style="margin:0 0 10px;padding-left:18px;font-size:12px;color:#7c8a8a">' +
      recs.map(function (r) {
        var sc = r.finalScore || { home: 0, away: 0 };
        return '<li>' + (r.game && r.game.home || 'My team') + ' ' + sc.home + '–' + sc.away + ' ' + (r.game && r.game.away || 'Opponent') +
          (r.game && r.game.date ? ' · ' + r.game.date : '') + '</li>';
      }).join('') + '</ul>';
    var parts = xgtStatsBodyParts(mergedEvents, first.playerRole, first.trackingMode);
    var trackedNum = first.trackedPlayer && first.trackedPlayer.number != null ? first.trackedPlayer.number : null;
    return (
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">' +
        '<h2 style="margin-top:0">' + recs.length + ' sessions combined</h2>' +
        '<div style="display:flex;gap:6px;flex:none">' +
          '<button type="button" id="xgtSessionCsvBtn" style="flex:none;background:#e1e6e6;color:#124d4d;border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;font-size:12px;">Export CSV</button>' +
          '<button type="button" id="xgtExportPdfBtn" style="flex:none;background:#1b7373;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;">Export PDF</button>' +
        '</div>' +
      '</div>' +
      sessionListHtml +
      '<div style="margin-bottom:10px;font-size:11.5px;color:#7c8a8a">' + (parts.gk ? 'Goalkeeper' : 'Field player') + (trackedNum != null ? ' #' + trackedNum : '') + ' · ' + parts.actionCount + ' total actions · Combined score ' + totalHome + '–' + totalAway + '</div>' +
      parts.html
    );
  },
  // The actual PDF-building logic lives here (stats computation is this
  // module's own responsibility already), but the rendered SVG elements
  // to rasterize are passed in by the caller rather than queried here --
  // #libraryDetailBody, where the combined view is actually rendered,
  // lives in the Library's own DOM, outside this module entirely, and
  // reaching into another module's specific element IDs directly would
  // be exactly the tight, fragile coupling this codebase's modules have
  // deliberately avoided everywhere else.
  exportCombinedStatsPdf: function (sessionRecords, vizElements) {
    var recs = (sessionRecords || []).filter(Boolean);
    if (!recs.length) return Promise.reject(new Error('No sessions to export.'));
    var first = recs[0];
    var mergedEvents = [];
    recs.forEach(function (r) { mergedEvents = mergedEvents.concat(r.events || []); });
    var totalHome = 0, totalAway = 0;
    recs.forEach(function (r) { var sc = r.finalScore || { home: 0, away: 0 }; totalHome += sc.home; totalAway += sc.away; });
    var parts = xgtStatsBodyParts(mergedEvents, first.playerRole, first.trackingMode);
    var trackedNum = first.trackedPlayer && first.trackedPlayer.number != null ? first.trackedPlayer.number : null;

    return loadJsPDF().then(function (jsPDFCtor) {
      return xgtBuildStatsPdf(jsPDFCtor, {
        title: recs.length + ' Sessions Combined',
        subtitle: (parts.gk ? 'Goalkeeper' : 'Field player') + (trackedNum != null ? ' #' + trackedNum : '') +
          ' \u00b7 ' + parts.actionCount + ' total actions \u00b7 Combined score ' + totalHome + '\u2013' + totalAway,
        sessionLines: recs.map(function (r) {
          var sc = r.finalScore || { home: 0, away: 0 };
          return (r.game && r.game.home || 'My team') + ' ' + sc.home + '\u2013' + sc.away + ' ' + (r.game && r.game.away || 'Opponent') +
            (r.game && r.game.date ? '  \u00b7  ' + r.game.date : '');
        }),
        parts: parts, vizElements: vizElements,
        filename: 'xquix-combined-stats-' + recs.length + '-sessions.pdf'
      });
    });
  },
  // Single-session equivalent of exportCombinedStatsPdf above -- a
  // separate function rather than just calling the combined one with a
  // one-element array, since "1 sessions combined" reads wrong and a
  // single game's report should use the same natural score-line header
  // renderSessionStatsHtml already established ("My Team 8 – 5
  // Opponent"), not a session-count framing that only makes sense once
  // there's more than one.
  exportSingleSessionPdf: function (sessionRecord, vizElements) {
    var d = sessionRecord;
    if (!d) return Promise.reject(new Error('No session to export.'));
    var sc = d.finalScore || { home: 0, away: 0 };
    var parts = xgtStatsBodyParts(d.events || [], d.playerRole, d.trackingMode);
    var trackedNum = d.trackedPlayer && d.trackedPlayer.number != null ? d.trackedPlayer.number : null;

    return loadJsPDF().then(function (jsPDFCtor) {
      return xgtBuildStatsPdf(jsPDFCtor, {
        title: (d.game && d.game.home || 'My team') + ' ' + sc.home + ' \u2013 ' + sc.away + ' ' + (d.game && d.game.away || 'Opponent'),
        subtitle: (parts.gk ? 'Goalkeeper' : 'Field player') + (trackedNum != null ? ' #' + trackedNum : '') +
          ' \u00b7 ' + parts.actionCount + ' actions' + (d.game && d.game.date ? ' \u00b7 ' + d.game.date : ''),
        sessionLines: null, // no "sessions included" list for a single game -- the title line already says everything that section would
        parts: parts, vizElements: vizElements,
        filename: 'xquix-session-stats.pdf'
      });
    });
  },
  // CSV/download() are both module-private -- the Library's own detail
  // views (single and combined session) live outside this module
  // entirely, so this is the one exposed entry point they call into,
  // matching how renderSessionStatsHtml/exportSingleSessionPdf are
  // already exposed for the same reason. Works for either a single
  // saved session's events or an already-merged combined array -- the
  // caller decides which, this just needs the final flat array.
  exportSessionCsv: function (events, filenameHint) {
    download((filenameHint || 'xquix-session-stats') + '.csv', 'text/csv', xgtEventsToCsvString(events));
  }
};
function openGameTrackerLanding(saved) {
  openSheet();
  var showSessions = xgtShouldShowSessionsEntry();
  var when = '';
  if (saved) { try { when = new Date(saved.savedAt).toLocaleString(); } catch (err) {} }
  sheetEl().innerHTML = head('Game Tracker', saved ? 'Saved ' + when : 'Start tracking a game', null) +
    (saved
      ? '<p class="xgtNote" style="margin-top:0">' +
          (saved.game.home || 'My team') + ' vs ' + (saved.game.away || 'Opponent') + ' \u00b7 ' +
          saved.events.length + ' events \u00b7 Q' + saved.q + ' ' + fmt(saved.clock) + '</p>' +
        '<button class="xgtBtn pri" id="xgtRes" style="margin-bottom:9px">Resume this game</button>'
      : '') +
    // Start a new game takes the primary styling itself whenever there's
    // nothing to resume -- otherwise Resume already fills that role, and
    // this stays the plain, secondary option beneath it.
    '<button class="xgtBtn' + (saved ? '' : ' pri') + '" id="xgtFresh" style="margin-bottom:9px">Start a new game</button>' +
    (showSessions ? '<button class="xgtBtn" id="xgtViewSessions">View Saved Sessions</button>' : '');
  el('xgtX').onclick = function () { closeSheet(); API.close(); };
  if (saved) el('xgtRes').onclick = function () { restore(saved); closeSheet(); render(); };
  el('xgtFresh').onclick = function () { resetGameState(); closeSheet(); render(); openSetup(); };
  if (showSessions) el('xgtViewSessions').onclick = xgtOpenSessions;
}

/* ------------------------------------------------------------- boot / launch */
function boot() {
  injectCss();
  window.XquiXGameTracker = API;
  if (window.MIZE) { window.MIZE.GameTracker = API; }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
