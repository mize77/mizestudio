/* ============================================================================
 * XquiX Game Tracker — tutorials
 * ----------------------------------------------------------------------------
 * Guided walkthroughs that run ON the real Game Tracker, not a mock.
 *
 *   1. <script src="xquix-game-tracker-tutorial.js"></script>  after
 *      xquix-game-tracker.js
 *   2. window.XquiXGameTracker — the tracker's own public API
 *
 * Design context: gametracker/TUTORIAL-STORYBOARD.md in the project.
 * Three decisions from that document shape everything here:
 *
 * ONE THING IS POSSIBLE AT A TIME. Studio's board tutorials lock input through
 * body.tutorialLockActive; that mechanism cannot reach here, because the tracker
 * lays a full-screen pointer shield over everything and Studio's guard sits
 * underneath it. An early version of this file therefore did not gate at all --
 * it only watched. Tested on a device that was wrong: you could start the clock
 * three steps before the tutorial asked, and wander off the path with no way
 * back. So the guard is rebuilt here instead, at the level that works: a
 * capture-phase click listener on window, which fires before the shield's own
 * handler. Only the current step's target is clickable; everything else is
 * swallowed and the ring nudges. Deliberately 'click' and not 'pointerdown',
 * so scrolling the stats panel and typing into fields still work.
 *
 * VALIDATE THE RECORD, NOT THE SCREEN. The tracker builds its UI at runtime and
 * rewrites one sheet's innerHTML per step, so there is almost nothing durable to
 * select. Instead every validator reads the tracker's own introspection API —
 * state, events(), zones, hitZone(), boardToClient() — none of which Studio
 * itself calls. Highlights key off the data-* attributes the sheets already
 * carry, and a step with no stable target simply runs without a ring.
 *
 * LEAVE NO RECORD BEHIND. The tracker autosaves after every tap and cloud-syncs
 * for entitled users. Running a tutorial through it would otherwise overwrite a
 * coach's in-progress game and file invented events into their real library.
 * setTutorialMode(true) suspends all of that; the tutorial's own session lives
 * in memory and dies with it.
 * ==========================================================================*/
(function () {
'use strict';

var Z_BOX = 999990;   // instruction box + nav (above #xgtToast at 999987)
var Z_RING = 999989;  // the pulsing ring sits under the box, over everything else

var T = null;         // window.XquiXGameTracker, resolved at start()
var lessons = [];     // [{ title, steps: [...] }]
var steps = [];       // flattened
var lessonStarts = [], lessonTitles = [];
var idx = -1;
var rafHandle = null;
var running = false;
var advancing = false;
var practice = null;  // scratch state for the final lesson
/* Which tutorial is running, as tracker setup state. setUpTick() used to
   hard-code 'field', so jumping to a lesson in the Goalkeeper tutorial built a
   FIELD PLAYER session underneath it -- every keeper-only thing the lesson then
   talks about (the Opponent header, Defender Block, the outlet pass) was
   missing. The team tutorials make this worse again: squad tracking is
   `trackingMode === 'coach' && playerRole === 'team'` and NOTHING else, so a
   jump has to reproduce both halves, plus a squad of at least seven, or
   go() refuses to start and the lesson opens onto the setup sheet. */
var tutorialRole = 'field';
var tutorialMode = 'parent';    // 'parent' | 'coach'
var tutorialOpp = false;        // D only: the opposing squad is tracked too
/* The squad the demo and the jump-setup use. Seven is the minimum go() accepts
   and also exactly a starting seven, so nobody has to wonder why an eighth
   number is or is not in the water. #1 is first because the tracker marks it as
   the goalkeeper by itself, which is a thing the lesson points out. */
var DEMO_SQUAD = [1, 2, 3, 4, 5, 6, 7];
var DEMO_OPP_SQUAD = [1, 2, 3, 4, 5, 6, 7];

/* ------------------------------------------------------------------- css */
var CSS = [
'#xgtuBox{position:fixed;left:12px;width:min(370px,calc(100vw - 24px));',
'  z-index:' + Z_BOX + ';background:#0d2422;border:1px solid #2a5f5c;border-radius:14px;',
'  padding:13px 15px;box-shadow:0 10px 30px rgba(0,0,0,.45);color:#eaf6f5;',
'  font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;pointer-events:auto;',
// The box moves out of the way of whatever the step is pointing at, so it has
// to move visibly rather than teleport -- a box that jumps is one the eye has
// to find again on every step.
'  transition:top .28s cubic-bezier(.22,.61,.36,1);}',
'@media (prefers-reduced-motion: reduce){#xgtuBox{transition:none;}}',
// On a small portrait phone a long step can be taller than the band it has to
// fit in. Capped and scrollable beats overflowing off the screen, which is how
// the Exit and Next buttons would end up unreachable.
'#xgtuScroll{overflow-y:auto;-webkit-overflow-scrolling:touch;}',
'#xgtuLesson{font:800 10.5px system-ui;letter-spacing:.09em;text-transform:uppercase;color:#4bb8bd;margin-bottom:5px;}',
'#xgtuText{white-space:pre-wrap;}',
'#xgtuText b{color:#7fd6da;font-weight:700;}',
'#xgtuHint{margin-top:10px;padding:8px 11px;border-left:3px solid #ffb020;',
'  background:rgba(255,176,32,.10);border-radius:0 9px 9px 0;color:#ffdca8;',
'  font:13px/1.4 system-ui;white-space:pre-wrap;}',
'#xgtuRow{display:flex;gap:8px;margin-top:11px;align-items:center;}',
'#xgtuRow .sp{flex:1;}',
'.xgtuBtn{font:700 12px system-ui;color:#fff;border:none;border-radius:9px;padding:8px 13px;',
'  cursor:pointer;touch-action:manipulation;pointer-events:auto;}',
'#xgtuExit{background:#8a3a3a;}',
'#xgtuNext{background:#37474f;}',
'#xgtuAck{background:#1b7373;}',
'#xgtuRing{position:fixed;z-index:' + Z_RING + ';border:3px solid #ff3b30;border-radius:12px;',
'  pointer-events:none;box-shadow:0 0 0 3px rgba(255,59,48,.25);animation:xgtuPulse 1.3s ease-in-out infinite;display:none;}',
'#xgtuRing.nudge{animation:xgtuNudge .45s ease;}',
// Amber, not teal. Teal (#4bb8bd) is the tracker's own accent -- it is on the
// chrome, the buttons and the labels -- so a teal ring read as part of the UI
// and was reported three separate times as "there is no ring here". Amber
// appears nowhere else on this screen, so it can only be the tutorial.
'#xgtuRing.look{border-color:#ffb020;box-shadow:0 0 0 3px rgba(255,176,32,.28);',
'  animation:xgtuBreathe 2.1s ease-in-out infinite;}',
'@keyframes xgtuPulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.55;transform:scale(1.04);}}',
'@keyframes xgtuBreathe{0%,100%{opacity:1;}50%{opacity:.62;}}',
'@keyframes xgtuNudge{0%,100%{transform:scale(1);}25%{transform:scale(1.14);}60%{transform:scale(.97);}}',
'#xgtuFlash{position:fixed;left:0;right:0;z-index:' + Z_BOX + ';text-align:center;pointer-events:none;',
'  font:800 22px system-ui;color:#4bb8bd;text-shadow:0 2px 12px rgba(0,0,0,.6);opacity:0;transition:opacity .25s;}',
'#xgtuFlash.on{opacity:1;}',
'#xgtuDlg{position:fixed;inset:0;z-index:' + (Z_BOX + 1) + ';background:rgba(4,18,17,.93);',
'  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;',
'  color:#eaf6f5;font:15px/1.5 system-ui;text-align:center;pointer-events:auto;}',
'#xgtuDlg h2{margin:0;font:800 21px system-ui;color:#7fd6da;}',
'#xgtuDlg select{font:700 15px system-ui;color:#0b2b2b;background:#fff;border:2px solid #4bb8bd;',
'  border-radius:11px;padding:10px 13px;min-width:min(320px,84vw);}',
'#xgtuDlg .row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
'@media (prefers-reduced-motion: reduce){#xgtuRing{animation:none;}}'
].join('');

/* --------------------------------------------------------------- helpers */
function el(id) { return document.getElementById(id); }
function q(sel) { try { return document.querySelector(sel); } catch (err) { return null; } }
function make(tag, id) { var e = document.createElement(tag); if (id) e.id = id; return e; }
function step() { return idx >= 0 ? steps[idx] : null; }
function evts() { return T ? T.events() : []; }
function last() { var e = evts(); return e.length ? e[e.length - 1] : null; }
function actions() {
  return evts().filter(function (e) { return e.context && e.context.kind === 'action'; });
}
function lastAction() { var a = actions(); return a.length ? a[a.length - 1] : null; }
function mmss(s) { return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function stageWrap() { return document.getElementById('stageWrap'); }

/* Ring whichever of these is on screen right now. A sheet step walks through
   two or three screens -- action, outcome, placement -- and a ring fixed to the
   first of them goes blank for the rest of the step, which reads as "there is
   nothing to tap here" at exactly the moment there is. */
function firstVisible(sels) {
  return function () {
    for (var i = 0; i < sels.length; i++) if (vis(sels[i])) return q(sels[i]);
    return null;
  };
}

/* The stats panel carries no ids on its sections, and which sections exist
   depends on what has been logged -- the misses block only appears once there
   is a miss. So a section is found by its heading text, and the ring goes on
   the card underneath it. */
function statsSection(re) {
  return function () {
    var box = el('xgtStats');
    if (!box) return null;
    var hs = box.querySelectorAll('h2');
    for (var i = 0; i < hs.length; i++) {
      if (re.test(hs[i].textContent || '')) {
        var n = hs[i].nextElementSibling;
        while (n && String(n.className || '').indexOf('xgtCard') < 0) n = n.nextElementSibling;
        return n || hs[i];
      }
    }
    return null;
  };
}
function statsTiles() { return q('#xgtStats .xgtTiles'); }

/* One ring around several controls. A step that describes two adjacent options
   -- rename AND hide the field zones -- has no honest single target: ringing
   either one says the other is not being talked about, which is exactly how it
   was read on a device. Returns a plain rectangle covering them all; paintRing
   and the box layout both accept that as readily as an element. */
function spanOf(sels) {
  var boxes = [];
  for (var i = 0; i < sels.length; i++) {
    var e = q(sels[i]);
    if (!e) continue;
    var b = e.getBoundingClientRect();
    if (b.width || b.height) boxes.push(b);
  }
  if (!boxes.length) return null;
  var top = boxes[0].top, left = boxes[0].left, bottom = boxes[0].bottom, right = boxes[0].right;
  for (var j = 1; j < boxes.length; j++) {
    top = Math.min(top, boxes[j].top);       left = Math.min(left, boxes[j].left);
    bottom = Math.max(bottom, boxes[j].bottom); right = Math.max(right, boxes[j].right);
  }
  return { top: top, left: left, bottom: bottom, right: right,
           width: right - left, height: bottom - top };
}

/* Brings the thing being talked about into view. The stats panel is taller than
   any phone, so a ring on a section below the fold is a ring nobody sees. */
function reveal(fn) {
  return function () {
    var e = typeof fn === 'function' ? fn() : q(fn);
    if (e && e.scrollIntoView) { try { e.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (err) { e.scrollIntoView(); } }
  };
}

/* NO STEP NAMES A FIELD ZONE NUMBER, and that is a rule rather than a habit.
   The numbering is per-device: any coach can renumber a field zone, and this
   tutorial invites them to in Lesson 3, so "tap field zone 3" is wrong for
   anyone who has. Resolving the number at runtime was tried and dropped -- it
   was correct but it made the lesson about the numbering rather than about the
   idea. Steps ask for ANY field zone instead; the zoning itself is explained
   once, without numbers, as a way of saying where something happened. */

/* The most recent action logged since `baseline` that is NOT the one the step
   asked for. Practice steps use it to say what actually went in, rather than
   sitting silent while the coach wonders why nothing advanced. */
function stray(baseline, want) {
  var a = actions();
  for (var i = a.length - 1; i >= baseline; i--) {
    var e = a[i], ok = true;
    for (var k in want) if (want.hasOwnProperty(k) && e[k] !== want[k]) { ok = false; break; }
    if (!ok) return e;
  }
  return null;
}
var EVENT_NAMES = {
  goal: 'goal', blocked: 'blocked shot', missed: 'missed shot',
  exclusion: 'exclusion', penalty: 'penalty', excl_sub: 'exclusion + substitution',
  brutality: 'brutality', off_foul: 'offensive foul', off_exclusion: 'offensive exclusion',
  intercepted: 'intercepted pass', shotclock: 'shot clock violation'
};
function nameOf(e) {
  if (!e) return 'that';
  if (e.action === 'steal') return 'steal';
  return EVENT_NAMES[e.outcome] || EVENT_NAMES[e.action] || e.action || 'event';
}

/* True once an action event matching every key in `want` exists that was not
   already there when the step began. Steps record their own baseline in
   onEnter, so replaying a lesson never counts an earlier lesson's event. */
function loggedSince(baseline, want) {
  var a = actions();
  for (var i = baseline; i < a.length; i++) {
    var e = a[i], ok = true;
    for (var k in want) if (want.hasOwnProperty(k) && e[k] !== want[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/* A board point inside a given zone, found by asking the tracker's own
   hit-test rather than reimplementing its polar geometry. Used to drive a
   zone tap for "Next step", and to check the coach tapped the right one. */
function pointInZone(zoneId) {
  if (!T) return null;
  for (var x = 2.25; x <= 14.5; x += 0.25) {
    for (var y = 2.25; y <= 21.75; y += 0.25) {
      if (T.hitZone(x, y) === zoneId) return { x: x, y: y };
    }
  }
  return null;
}

/* Tap a zone the way a finger does: the shield resolves client coordinates
   against the field's own viewBox, so this goes through the identical path. */
function tapZone(zoneId) {
  var p = pointInZone(zoneId);
  var shield = el('xgtShield');
  if (!p || !shield) return false;
  var c = T.boardToClient(p.x, p.y);
  if (!c) return false;
  shield.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, clientX: c.x, clientY: c.y
  }));
  return true;
}

/* Dispatches rather than calling .click(), because the goal-placement targets
   are SVG elements and SVGElement has no click() method -- calling it there
   throws, which silently broke every auto-completed shot until it was traced. */
function click(sel) {
  var e = q(sel);
  if (!e) return false;
  e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}

/* closeSheet() only drops the 'on' class -- the sheet's innerHTML stays in the
   DOM, so "has this button disappeared" is never true. Every "did they close
   it" check has to go through the class. */
function sheetOpen() {
  var sh = el('xgtSheet');
  return !!sh && sh.classList.contains('on');
}
function statsOpen() {
  var s = el('xgtStats');
  return !!s && s.classList.contains('on');
}

/* Runs a sequence of auto-complete actions, waiting for each target to exist
   rather than guessing at delays. The tracker advances its own sheets on
   internal timers (stepPlacement defers finish() by 90ms, for one), so fixed
   setTimeouts race it -- that is what silently broke the shot chains first
   time round.

   An entry is a function (run it), a selector (wait for it, then click), or a
   selector prefixed '?' (optional -- click it if it turns up quickly, carry on
   if it never does). Optional covers sheets that only appear on some tiers,
   like the assist step, which exists on Pro and not on Basic. */
/* Visible *now* -- not merely present. closeSheet() leaves the last sheet's
   innerHTML in the DOM, so q() happily finds buttons from a screen that is no
   longer on screen. */
function vis(sel) {
  if (!sheetOpen()) return false;
  var e = q(sel);
  if (!e) return false;
  var r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/* Start a chain wherever the sheet actually is, rather than always at the first
   tap. "Next step" gets pressed just as often three taps into a sequence as at
   its start -- and a chain that begins from scratch then spends 1.3 seconds
   polling for a button that is long gone, three times over, while the advance
   fallback fires underneath it. That is exactly how the blocked-shot step left
   its follow-up sheet open over a step that allowed nothing, with no way to
   close it. */
function chainFrom(items) {
  for (var i = items.length - 1; i > 0; i--) {
    var it = items[i];
    if (typeof it !== 'string') continue;
    if (vis(it.charAt(0) === '?' ? it.slice(1) : it)) { chain(items.slice(i)); return; }
  }
  chain(items);
}

function chain(items) {
  var i = 0;
  (function step_() {
    if (i >= items.length) return;
    var it = items[i];
    if (typeof it === 'function') { try { it(); } catch (err) {} i++; setTimeout(step_, 70); return; }
    var optional = it.charAt(0) === '?';
    var sel = optional ? it.slice(1) : it;
    var limit = optional ? 6 : 24, tries = 0;
    (function poll() {
      if (click(sel)) { i++; setTimeout(step_, 70); return; }
      if (++tries >= limit) { i++; setTimeout(step_, 40); return; }
      setTimeout(poll, 55);
    })();
  })();
}

/* ------------------------------------------------------------------ gate */
/* Everything the current step does not need is unclickable. Runs in the
   CAPTURE phase on window, so it fires before the tracker's shield handler and
   before any button's own onclick -- which is the only place a guard can sit
   given the shield swallows events on the way down. */
var allowedNow = null;   // { sels: [..], deny: [..], zone: 'z3' | '*' | null }

function insideAny(node, sels) {
  for (var i = 0; i < sels.length; i++) {
    try { if (node.closest && node.closest(sels[i])) return true; } catch (err) {}
  }
  return false;
}

function clickAllowed(e) {
  var box = el('xgtuBox'), dlg = el('xgtuDlg');
  if (dlg && dlg.contains(e.target)) return true;         // the exit / complete dialogue
  if (box && box.contains(e.target)) return true;         // the tutorial's own controls
  if (!allowedNow) return false;
  // A deny list, checked first. Some steps need the whole sheet reachable so a
  // mis-tap can be backed out of, minus one or two buttons that would take the
  // coach somewhere the lesson has not prepared them for -- Penalty, which
  // launches the penalty-shot flow, and the field-defender block options, which
  // contradict what this lesson teaches. Narrowing `allow` instead would also
  // remove the ✕ and the back arrow, and leave a mis-tap with nowhere to go.
  if (allowedNow.deny && allowedNow.deny.length && insideAny(e.target, allowedNow.deny)) return false;
  var shield = el('xgtShield');
  if (allowedNow.zone && shield && (e.target === shield || shield.contains(e.target))) {
    // A zone tap is allowed only where the step actually asked for it, resolved
    // through the tracker's own hit-test rather than a second copy of the maths.
    var b = T && T.screenToBoard(e.clientX, e.clientY);
    var z = b && T.hitZone(b.x, b.y);
    return !!z && (allowedNow.zone === '*' || z === allowedNow.zone);
  }
  return allowedNow.sels.length ? insideAny(e.target, allowedNow.sels) : false;
}

/* The tutorial's own rescue taps go through the guard like everyone else's, so
   they need a way past it -- closing a sheet the coach was never allowed to
   close is the whole point of a rescue. Set only around a synchronous dispatch. */
var bypassGuard = false;
function clickThrough(sel) {
  bypassGuard = true;
  var r = click(sel);
  bypassGuard = false;
  return r;
}

function interactionGuard(e) {
  if (bypassGuard) return;
  if (!running) return;
  restartHints();                       // any tap counts as "they are trying"
  if (clickAllowed(e)) return;
  e.stopPropagation();
  e.preventDefault();
  nudgeRing();
  var s = step();
  if (s && s.hints) showHint(s.wrongHint || DEFAULT_WRONG);
}

/* Studio's own keyboard shortcuts are live the whole time the tracker is open
   -- its guard is body.tutorialLockActive, which the Game Tracker never sets.
   Shift+N opens Studio's Add Player panel, ⌘V pastes players, and a bare h/a/n/g
   switches drawing mode; all of them act on the board UNDERNEATH the tracker,
   which is how players appeared on the field mid-tutorial. Swallowed here for
   the duration of a tutorial run. Keys inside a field are untouched, so typing
   the team name and pressing Enter still works exactly as before.
   The tracker itself is still exposed to this when no tutorial is running --
   recorded for the Studio side in gametracker/INSTRUCTION-TUTORIAL-HOOKS.md. */
function keyGuard(e) {
  if (!running) return;
  var t = e.target, tag = (t && t.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (t && t.isContentEditable) return;
  e.stopPropagation();
}

/* ----------------------------------------------------------------- hints */
/* The last lesson deliberately stops pointing at things. Left at that, a coach
   who does not know where to start has nothing to fall back on but "Next step",
   which does it FOR them and teaches nothing. So a step can carry a ladder of
   hints: one appears after three seconds of no tapping at all, the next after
   another three, and so on. Any tap resets the clock -- someone who is working
   through it is never nagged. */
var HINT_MS = 3000;
var DEFAULT_WRONG = 'Not that one. Start with the field zone where it happened, then the action, then the outcome.';
var hintTimer = null, hintN = 0;

function showHint(html) {
  var h = el('xgtuHint');
  if (!h) return;
  h.innerHTML = html;
  h.style.display = '';
  positionChrome(true);         // the box just got taller
}
function clearHints() {
  clearTimeout(hintTimer); hintTimer = null; hintN = 0;
  var h = el('xgtuHint');
  if (h) { h.style.display = 'none'; h.innerHTML = ''; }
}
function restartHints() {
  var s = step();
  if (!s || !s.hints) return;
  clearTimeout(hintTimer);
  var from = idx;
  hintTimer = setTimeout(function tickHint() {
    if (!running || idx !== from) return;
    if (hintN < s.hints.length) {
      var h = s.hints[hintN++];
      showHint(typeof h === 'function' ? h() : h);
    }
    if (hintN < s.hints.length) hintTimer = setTimeout(tickHint, HINT_MS);
  }, HINT_MS);
}

function nudgeRing() {
  var r = el('xgtuRing');
  if (!r || r.style.display === 'none') return;
  r.classList.remove('nudge');
  void r.offsetWidth;                                     // restart the animation
  r.classList.add('nudge');
  setTimeout(function () { r.classList.remove('nudge'); }, 500);
}

/* A step is finished the moment the field is committed -- Enter, Tab, or moving
   away from it -- rather than on the first keystroke, which would advance on the
   '1' of '17'. */
var inputCommitted = false;
function armCommit(sel) {
  var e = q(sel);
  if (!e) return;
  var fire = function () {
    if (!(e.value || '').trim()) return;
    inputCommitted = true;
    e.readOnly = true;          // confirmed; move to the next field, not back into this one
    e.blur();
  };
  e.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === 'Tab') setTimeout(fire, 0);
  });
  e.addEventListener('blur', fire);
  e.addEventListener('change', fire);
}
function fieldValue(sel) { var e = q(sel); return e ? (e.value || '').trim() : ''; }

/* Types into a field a character at a time, with the ring on it, so the coach
   sees which field is being filled rather than watching values appear from
   nowhere.

   Each field takes about DEMO_MS end to end, whether it is 'Diablo' or 'Marin
   Aquatic Center'. Per-character speed alone does not achieve that -- a short
   word finishes in half a second and the eye never catches up, which is what
   made the first version feel like values appearing from nowhere. So the
   per-character delay is capped for readability and whatever time is left over
   is spent holding the finished field, ringed, before moving on. */
var DEMO_MS = 2000;
/* Bumped on every step change. A demo animation captures it and stops the
   moment it no longer belongs to the step on screen -- otherwise pressing
   "Next step" mid-demo leaves it typing into the setup sheet two steps later,
   with the ring wandering off after it. */
var demoToken = 0;

/* Selects a control the way a finger does: ring first, then the tap, then a
   beat to see the result. Same two seconds as a typed field, for the same
   reason -- a selection that snaps into place is one the eye misses entirely. */
function autoTap(sel, done) {
  var e = q(sel);
  if (!e) { if (done) done(); return; }
  var tok = demoToken;
  ringOverride = sel;
  setTimeout(function () {
    if (!running || tok !== demoToken) { ringOverride = null; return; }
    var t = q(sel);
    if (t) { bypassGuard = true; t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); bypassGuard = false; }
    setTimeout(function () {
      if (!running || tok !== demoToken) { ringOverride = null; return; }
      if (done) done();
    }, Math.max(400, DEMO_MS - 1200));
  }, 1200);
}

function autoType(sel, text, done) {
  var e = q(sel);
  if (!e) { if (done) done(); return; }
  var tok = demoToken;
  ringOverride = sel;
  var started = Date.now();
  var i = 0, per = Math.max(55, Math.min(140, Math.round((DEMO_MS - 400) / text.length)));
  (function tick() {
    if (!running || tok !== demoToken) { ringOverride = null; return; }
    e.value = text.slice(0, ++i);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    if (i < text.length) { setTimeout(tick, per); return; }
    e.dispatchEvent(new Event('change', { bubbles: true }));
    var left = Math.max(350, DEMO_MS - (Date.now() - started));
    setTimeout(function () {
      if (!running || tok !== demoToken) { ringOverride = null; return; }
      if (done) done();
    }, left);
  })();
}
var demoDone = false;

/* ---------------------------------------------------------------- chrome */
function injectCss() {
  if (el('xgtuStyle')) return;
  var st = make('style', 'xgtuStyle');
  st.textContent = CSS;
  document.head.appendChild(st);
}

function buildChrome() {
  if (el('xgtuBox')) return;
  var box = make('div', 'xgtuBox');
  box.innerHTML =
    '<div id="xgtuLesson"></div>' +
    '<div id="xgtuScroll"><div id="xgtuText"></div>' +
    '<div id="xgtuHint" style="display:none"></div></div>' +
    '<div id="xgtuRow">' +
      '<button class="xgtuBtn" id="xgtuExit">Exit / Skip Lesson</button>' +
      '<span class="sp"></span>' +
      '<button class="xgtuBtn" id="xgtuAck" style="display:none">Got it</button>' +
      '<button class="xgtuBtn" id="xgtuNext">Next step →</button>' +
    '</div>';
  document.body.appendChild(box);
  document.body.appendChild(make('div', 'xgtuRing'));
  document.body.appendChild(make('div', 'xgtuFlash'));
  el('xgtuExit').onclick = function () { openDialog('exit'); };
  el('xgtuNext').onclick = nextStep;
  el('xgtuAck').onclick = function () { succeed(); };
  positionChrome(true);
  window.addEventListener('resize', onViewportResize);
  window.addEventListener('orientationchange', onViewportResize);
}

/* WHERE THE BOX GOES, and why it cannot be one fixed place.
 *
 * The tutorial runs on a phone held in portrait -- the only orientation the
 * Game Tracker is usable in -- and over the course of a lesson it points at the
 * clock at the very top, the action sheet at the very bottom, a wedge in the
 * middle of the water, and sections of a full-screen stats panel. A box parked
 * under the top bar covers the clock explanation's own subject on one step and
 * the goal grid on another; parked at the bottom it covers the action sheet it
 * is asking the coach to tap.
 *
 * So it is placed per step, against the one thing that step is about: the ring
 * target. Above it if there is room above, below it if there is room below,
 * whichever band is roomier when both work. The band is measured from the real
 * chrome -- the top pane's actual height, the real safe-area insets -- rather
 * than from guessed constants, because those differ on every handset.
 *
 * Two cases deliberately do not move it: no target at all (nothing to avoid),
 * and a target inside the box itself, which is the "Got it" ring. */
/* The gap is measured from the ANCHOR, but what the eye sees -- and what a
   layout test measures -- is the RING, which paintRing() draws 5px proud of the
   anchor on every side. At 10 the real clearance was 5px, and on the sideline
   scroll step, where the strip's rect shifts by a few pixels while the field
   settles, that was close enough to zero to show up as the box sitting on the
   ring. 16 leaves 11px of actual daylight. */
var ANCHOR_GAP = 16;

/* WHEN THE BOX MOVES AT ALL: portrait only.
 *
 * On a phone held in portrait the box has to dodge. The screen is one column
 * wide, the instructions and whatever the step points at are competing for the
 * same strip of space, and a box parked anywhere covers something.
 *
 * On a wide screen it stays where it has always been, top left. Reported from a
 * Mac: the dodging there is "unnecessary and looks very hectic", and that is
 * right -- there is room for both, so the motion carries no information.
 *
 * A first attempt kept the dodge in landscape "only when the box would actually
 * cover the target". It moved almost as much: the tracker's own bar, sheets and
 * stats panel all span the full width on a desktop, so their targets share the
 * box's column constantly. Half a rule was worse than either whole one.
 *
 * The trade, stated plainly: on a wide screen the box can sit over a corner of
 * what a step describes. That was true of every build before this, was never
 * reported, and the ring stays visible around it. The tutorial is a
 * portrait-phone experience -- that is the only way the Game Tracker is usable
 * -- and that is where the effort belongs. */
function isPortrait() { return window.innerHeight > window.innerWidth; }

/* A resize or a rotation invalidates every measurement the layout was based on,
   so it starts from scratch rather than deciding nothing moved. */
function onViewportResize() { placedAt = null; positionChrome(true); }

function bandLimits() {
  var vh = window.innerHeight;
  var topBar = el('xgtTop');
  var safeTop = topBar ? topBar.getBoundingClientRect().bottom : 12;
  return { top: Math.max(8, Math.round(safeTop) + 8), bottom: vh - 10 };
}

/* The rectangle this step is about, if any. The ring's target is the honest
   answer: it is what the step points at, and it is resolved from the live DOM
   every frame, so it follows the sheet through its own screens. */
function anchorRect() {
  var s = step();
  if (!s) return null;
  // A quiet step does not dodge. It is two lines tall -- a lesson label and the
  // two buttons -- and there is no instruction competing for attention, so the
  // dodging only finds somewhere else on the same small screen to sit. Parked
  // home it stays clear of the sheet the ring is working in; dodging put it
  // straight over the big CLOCK REMAINING readout, which is the one number the
  // coach is watching change.
  if (s.quiet) return null;
  var sel = ringOverride || s.highlight;
  var handed = s.then && Date.now() - stepAt >= (s.thenAfter || 3000);
  if (handed) sel = s.then;
  if (!sel) return null;
  var e = typeof sel === 'function' ? sel() : q(sel);
  if (!e) return null;
  var box = el('xgtuBox');
  if (e.nodeType && box && box.contains(e)) return null;   // the ring around "Got it"
  var r = e.getBoundingClientRect ? e.getBoundingClientRect() : e;
  if (!r.width && !r.height) return null;
  if (r.bottom < 0 || r.top > window.innerHeight) return null;   // scrolled away
  return r;
}

var placedAt = null;      // the anchor we last laid out against

function positionChrome(force) {
  var box = el('xgtuBox'); if (!box) return;
  var lim = bandLimits();
  var r = anchorRect();

  // Only re-lay-out when the thing being pointed at has actually moved. Doing
  // it every frame fights the CSS transition and jitters.
  var key = r ? [Math.round(r.top / 3), Math.round(r.bottom / 3)].join(':') : 'none';
  if (!force && key === placedAt) return;
  placedAt = key;

  box.style.maxHeight = '';
  var scroll = el('xgtuScroll');
  if (scroll) scroll.style.maxHeight = '';
  var h = box.offsetHeight;

  var y;
  if (!r || !isPortrait()) {
    // Nothing to avoid, or a screen with room for both. Stay home.
    y = lim.top;
  } else {
    var above = (r.top - ANCHOR_GAP) - lim.top;    // room in the band above
    var below = lim.bottom - (r.bottom + ANCHOR_GAP);
    var fitsAbove = h <= above, fitsBelow = h <= below;
    if (fitsAbove && (!fitsBelow || above >= below)) y = r.top - ANCHOR_GAP - h;
    else if (fitsBelow) y = r.bottom + ANCHOR_GAP;
    else {
      // Neither band fits the box whole. Take the roomier one and let the text
      // scroll inside it, so the buttons stay on screen either way.
      // Take the roomier band and let the text scroll inside it. The cap is the
      // band itself, never a floor above it -- a floor is how the box ends up
      // taller than the space it was being fitted into, and back over the
      // anchor it was supposed to clear.
      var room = Math.max(above, below);
      var useAbove = above >= below;
      box.style.maxHeight = room + 'px';
      if (scroll) scroll.style.maxHeight = Math.max(30, room - 78) + 'px';
      h = Math.min(box.offsetHeight, room);
      y = useAbove ? (r.top - ANCHOR_GAP - h) : (r.bottom + ANCHOR_GAP);
    }
  }
  y = Math.max(lim.top, Math.min(y, lim.bottom - h));
  // Last line of defence, and portrait only for the same reason as the dodge
  // itself: in landscape this was still re-placing the box on most steps, which
  // is exactly the motion that was reported as hectic. Skipping the dodge but
  // leaving this in place meant the rule only half applied.
  if (isPortrait() && r && y < r.bottom && y + h > r.top) {
    y = (r.top - lim.top >= lim.bottom - r.bottom)
      ? Math.max(lim.top, r.top - ANCHOR_GAP - h)
      : Math.min(lim.bottom - h, r.bottom + ANCHOR_GAP);
  }
  box.style.top = Math.round(y) + 'px';

  var flash = el('xgtuFlash');
  if (flash) {
    // Under the box, unless that would put it off the bottom.
    var fy = y + h + 14;
    flash.style.top = Math.round(fy + 40 > window.innerHeight ? Math.max(lim.top, y - 40) : fy) + 'px';
  }
}

function removeChrome() {
  window.removeEventListener('resize', onViewportResize);
  window.removeEventListener('orientationchange', onViewportResize);
  ['xgtuBox', 'xgtuRing', 'xgtuFlash', 'xgtuDlg'].forEach(function (id) {
    var e = el(id); if (e) e.remove();
  });
}

/* ------------------------------------------------------------------ ring */
var ringOverride = null;   // set while a demo animation is leading the eye
var stepAt = 0;            // when the current step began, for the ring handover

function paintRing() {
  var ring = el('xgtuRing'); if (!ring) return;
  var s = step();
  var sel = ringOverride || (s && s.highlight);
  // A step can point at one thing to read and then, after a beat, at the thing
  // to tap. Without the handover the ring has to choose between explaining and
  // instructing, and whichever it picks the other reads as missing.
  var handed = !!(s && s.then && !ringOverride && Date.now() - stepAt >= (s.thenAfter || 3000));
  if (handed) sel = s.then;
  var target = sel ? (typeof sel === 'function' ? sel() : q(sel)) : null;
  if (!target) { ring.style.display = 'none'; return; }
  // A highlight can resolve to a plain rectangle rather than an element -- see
  // spanOf(), for pointing at two adjacent controls at once.
  var r = target.getBoundingClientRect ? target.getBoundingClientRect() : target;
  if (!r.width && !r.height) { ring.style.display = 'none'; return; }
  ring.style.display = 'block';
  // Above the instruction box only when the thing being ringed is inside it,
  // so a ring around a tracker control never draws over the instructions.
  var box = el('xgtuBox');
  ring.style.zIndex = (target.nodeType && box && box.contains(target)) ? (Z_BOX + 2) : Z_RING;
  // Red means "tap this". An ack step is read-only, so its ring is amber and
  // calm -- pointing at something that is deliberately not clickable with the
  // same urgent red is what made a blocked Menu feel broken rather than inert.
  // redRing overrides that for the one ack step whose target IS pressable: the
  // ring around "Got it", which the step's own text calls out as red.
  ring.className = (!handed && s && ((s.ack && !s.redRing) || s.calmRing)) ? 'look' : '';
  ring.style.left = (r.left - 5) + 'px';
  ring.style.top = (r.top - 5) + 'px';
  ring.style.width = (r.width + 10) + 'px';
  ring.style.height = (r.height + 10) + 'px';
}

function flash(msg) {
  var f = el('xgtuFlash'); if (!f) return;
  f.textContent = msg;
  f.classList.add('on');
  setTimeout(function () { f.classList.remove('on'); }, 1100);
}

/* ----------------------------------------------------------- step walker */
function goTo(i) {
  // A success flash or an auto-complete fallback can still be in flight when
  // the coach exits; without this the queued advance lands on removed chrome.
  if (!running || !el('xgtuBox')) return;
  if (i >= steps.length) { openDialog('complete'); return; }
  idx = i;
  advancing = false;
  stepAt = Date.now();
  demoToken++;               // any animation still running belongs to the old step
  var s = steps[idx];

  // What the coach may touch on this step, and nothing else.
  var sels = s.allow ? (typeof s.allow === 'string' ? [s.allow] : s.allow.slice()) : [];
  // An ack step is read-and-continue: the ring points at something, but nothing
  // on screen should respond. Falling back to the highlight here was a bug --
  // "here is the clock" let the clock be started three steps early.
  if (!sels.length && !s.ack && typeof s.highlight === 'string') sels.push(s.highlight);
  // An ack step allows nothing -- with one exception. If a sheet is open when
  // one begins, the ✕ stays live, because otherwise a sheet left over from the
  // step before is a box on screen that cannot be dismissed and a lesson that
  // cannot continue. Closing it is always safe: it is a cancel, never a record.
  if (s.ack && !sels.length) sels.push('#xgtX');
  var denies = s.deny ? (typeof s.deny === 'string' ? [s.deny] : s.deny.slice()) : [];
  allowedNow = { sels: sels, deny: denies, zone: s.allowZone || null };
  inputCommitted = false;
  ringOverride = null;
  clearHints();
  if (s.commit) setTimeout(function () { armCommit(s.commit); }, 0);

  el('xgtuLesson').textContent =
    'L' + s._lessonNo + ' · S' + s._nInLesson + ' of ' + s._ofLesson + '  ·  ' + s._lessonTitle;
  el('xgtuText').innerHTML = (typeof s.instruction === 'function') ? s.instruction() : s.instruction;
  /* A QUIET STEP shows no words at all -- just the ring, and the two buttons
     that must never disappear. Two things asked for it, and both are the same
     complaint from opposite directions:
       - the auto-fill demo in Lesson 1: text arriving while an animation plays
         reads as something you are missing while you watch;
       - correcting the clock in Lesson 2: on a phone the instruction box covers
         half the very time sheet the coach is learning to recognise.
     In both cases the words belong on the step BEFORE, behind a Got it, and the
     doing or the watching happens with the screen clear. */
  var scroll = el('xgtuScroll');
  if (scroll) scroll.style.display = s.quiet ? 'none' : '';
  el('xgtuAck').style.display = s.ack ? '' : 'none';
  el('xgtuNext').style.display = s.ack ? 'none' : '';
  if (s.onEnter) { try { s.onEnter(); } catch (err) { console.error('XquiX tutorial: onEnter threw', err); } }
  restartHints();
  placedAt = null;              // a new step lays out from scratch
  positionChrome(true);
}

/* A step's instruction, rewritten after onEnter has worked something out that
   only exists at runtime -- the exact clock time L2 is asking for, above all,
   so the coach can check the number they dialled in against the one they were
   asked for instead of counting taps and hoping. */
function setText(html) {
  var t = el('xgtuText');
  if (t) { t.innerHTML = html; positionChrome(true); }
}

function succeed() {
  if (!running || advancing) return;
  advancing = true;
  var s = step();
  if (s && s.onLeave) { try { s.onLeave(); } catch (err) { console.error('XquiX tutorial: onLeave threw', err); } }
  if (s && s.success) flash(s.success);
  setTimeout(function () { goTo(idx + 1); }, s && s.success ? 700 : 120);
}

/* One loop drives both the ring and validation -- the tracker redraws its
   sheets constantly, so re-querying every frame is simpler and more reliable
   than trying to hook its render. */
function tick() {
  if (!running) return;
  rafHandle = requestAnimationFrame(tick);
  paintRing();
  positionChrome();
  var s = step();
  if (!s || s.ack || advancing) return;
  // A practice step can notice that something was logged, but the wrong thing.
  // Saying so beats letting the coach tap on wondering why it has not moved.
  if (s.misstep) {
    var m = null;
    try { m = s.misstep(); } catch (err) { m = null; }
    if (m) showHint(m);
  }
  if (!s.validate) return;
  var ok = false;
  try { ok = !!s.validate(); } catch (err) { ok = false; }
  if (ok) succeed();
}

/* Escape hatch: perform the current step's own action, visibly, then let the
   normal validation advance it -- so the scene ends up exactly as if the coach
   had done it and later steps still line up. No step is ever a dead end. */
function nextStep() {
  var s = step();
  if (!s) return;
  if (s.ack) { succeed(); return; }
  if (s.autoComplete) {
    var from = idx;
    try { s.autoComplete(); } catch (err) { console.error('XquiX tutorial: autoComplete threw', err); }
    // Wait for the auto-complete to actually land rather than advancing on a
    // fixed timer. A chain can take several seconds when it starts mid-sequence,
    // and a timer that fires underneath it advances the tutorial while a sheet
    // is still open -- onto a step that may allow nothing, which strands the
    // whole lesson with a box that cannot be closed.
    //
    // If it has not landed by the deadline, close whatever is open before
    // moving on, so the next step starts from a clean screen either way. No
    // step is ever a dead end, and none leaves a sheet behind.
    var t0 = Date.now();
    (function waitOut() {
      if (!running || idx !== from || advancing) return;   // it advanced on its own
      var ok = false;
      try { ok = s.validate ? !!s.validate() : true; } catch (err) { ok = false; }
      if (ok) return;                                      // tick() will advance it
      if (Date.now() - t0 < 5000) { setTimeout(waitOut, 180); return; }
      if (sheetOpen() || (T && T.state.draft)) clickThrough('#xgtX');
      setTimeout(function () { if (running && idx === from && !advancing) succeed(); }, 150);
    })();
    return;
  }
  succeed();
}

/* ------------------------------------------------------------ lesson jump */
/* SKIPPING TO A LESSON REBUILDS THE SCREEN THAT LESSON STARTS ON.
 *
 * Moving the step pointer is the easy half and on its own it strands people.
 * Skip out of Lesson 4 with an action sheet half filled in and Lesson 2 opens
 * behind it, asking you to look at a clock you cannot see and blocking the one
 * control that would close the sheet. Reported from a device, twice.
 *
 * So a jump throws away whatever the previous lesson was in the middle of and
 * puts the tracker into the state that lesson's first step assumes:
 *
 *   Lesson 1  the landing screen -- close the tracker and reopen it, which is
 *             the only honest way back to "no game set up yet".
 *   Lesson 2+ a set-up session, tracking, nothing open over it. If no session
 *             exists (jumping forward from Lesson 1) one is created silently,
 *             the same way the lesson's own steps would have.
 *   Lesson 2  additionally stops the clock, because its second step asks you to
 *             start it -- and a clock already running would satisfy that step
 *             before the coach touched anything.
 *
 * Everything here goes through clickThrough(), because the interaction guard
 * blocks the tutorial's own taps exactly as it blocks anyone else's. */
/* "A session is set up and running." In team mode there is no cap number to
   look at -- go() skips that check entirely for coach + team and S.me stays
   {number:null} -- so the signal is the starting seven it puts in the water
   instead. Reading me.number here made a jump into a team lesson spin through
   its whole retry budget and then open the lesson on a half-filled setup sheet. */
function sessionReady() {
  if (!T || !T.state) return false;
  if (tutorialRole === 'team') {
    return (T.state.water || []).length > 0 &&
           (!tutorialOpp || (T.state.oppWater || []).length > 0);
  }
  return T.state.me.number != null;
}

/* The first chip in `want` that is not yet in `have`, as a selector. One per
   call on purpose: every chip tap re-renders the whole setup sheet, so a loop
   that tapped all seven would be tapping six orphaned nodes. */
function pickMissing(container, attr, want, have) {
  have = have || [];
  for (var i = 0; i < want.length; i++) {
    if (have.indexOf(want[i]) < 0) return container + ' [data-' + attr + '="' + want[i] + '"]';
  }
  return null;
}

function setField(sel, v) {
  var e = q(sel);
  if (!e) return;
  e.readOnly = false;
  e.value = v;
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
}

/* One tick of the state machine that gets from wherever we are to "tracking".
   Written as a poll rather than a fixed sequence because each tap re-renders
   the sheet, and the next thing to do is decided from what is on screen. */
function setUpTick() {
  if (!T.isOpen()) { T.open(); return; }
  if (sheetOpen() && q('#xgtGo')) {
    // Both halves, and in this order: the squad chips only exist once the sheet
    // is in coach + team, and every one of these taps re-renders the sheet.
    if (T.state.trackingMode !== tutorialMode) {
      clickThrough('#xgtTm [data-tm="' + tutorialMode + '"]'); return;
    }
    if (T.state.playerRole !== tutorialRole) {
      clickThrough('#xgtRl [data-role="' + tutorialRole + '"]'); return;
    }
    if (!fieldValue('#xgtHome')) {
      setField('#xgtLoc', 'WP City');
      setField('#xgtAway', 'Black Octopus');
      setField('#xgtHome', 'WP City Waves');
      return;
    }
    if (tutorialRole === 'team') {
      var missing = pickMissing('#xgtSquad', 'n', DEMO_SQUAD, T.state.squad);
      if (missing) { clickThrough(missing); return; }
      if (tutorialOpp) {
        if (!T.state.opponentTracked) { clickThrough('#xgtOppToggle'); return; }
        var missingOpp = pickMissing('#xgtOppSquad', 'opp-n', DEMO_OPP_SQUAD, T.state.oppSquad);
        if (missingOpp) { clickThrough(missingOpp); return; }
      }
    } else if (!fieldValue('#xgtNum')) {
      setField('#xgtNum', tutorialRole === 'goalkeeper' ? '1' : '7');
      return;
    }
    clickThrough('#xgtGo');
    return;
  }
  if (sheetOpen() && q('#xgtFresh')) { clickThrough('#xgtFresh'); return; }
  // No session and no way in to make one -- the landing screen has been closed
  // at some point. Reopening the tracker is the only route back to it.
  if (!sheetOpen()) { T.close(); T.open(); }
}

function goToLesson(n) {
  var startIdx = lessonStarts[n];
  if (!running || startIdx == null) return;

  // Everything still in flight belongs to the lesson being left.
  demoToken++;
  clearHints();
  advancing = false;
  idx = -1;                 // no current step, so nothing validates or advances
  allowedNow = null;        // and nothing on screen is tappable meanwhile
  ringOverride = null;
  var ring = el('xgtuRing'); if (ring) ring.style.display = 'none';
  el('xgtuLesson').textContent = 'Going to lesson ' + (n + 1);
  el('xgtuText').innerHTML = 'Setting the screen up…';
  el('xgtuAck').style.display = 'none';
  el('xgtuNext').style.display = 'none';
  positionChrome(true);

  var tries = 0;
  (function settle() {
    if (!running || idx !== -1) return;         // exited, or a second jump won
    if (++tries > 70) { finishJump(); return; } // never hang on this screen
    // Order matters. The landing screen and the setup form are themselves
    // sheets, so sheets are only force-closed once a session exists -- closing
    // them first is how the rebuild used to shut the very screen it then needed.
    if (statsOpen()) { clickThrough('#xgtSb'); setTimeout(settle, 90); return; }
    if (T.state.draft) { clickThrough('#xgtX'); setTimeout(settle, 90); return; }
    T.state.editingZoneNumbers = false;

    if (n === 0) {
      if (T.isOpen()) { T.close(); setTimeout(settle, 160); return; }
      if (!q('#xgtFresh')) { T.open(); setTimeout(settle, 240); return; }
      finishJump(); return;
    }
    if (!T.isOpen() || !sessionReady()) { setUpTick(); setTimeout(settle, 130); return; }
    if (sheetOpen()) { clickThrough('#xgtX'); setTimeout(settle, 90); return; }
    if (n === 1 && T.state.running) { clickThrough('#xgtT'); setTimeout(settle, 110); return; }
    finishJump();
  })();

  function finishJump() {
    el('xgtuAck').style.display = '';
    el('xgtuNext').style.display = '';
    goTo(startIdx);
  }
}

/* -------------------------------------------------------------- dialogue */
function openDialog(kind) {
  if (el('xgtuDlg')) return;
  var complete = kind === 'complete';
  var dlg = make('div', 'xgtuDlg');
  var h = make('h2');
  h.textContent = complete ? 'Lessons complete' : 'Leave the tutorial?';
  dlg.appendChild(h);

  var p = make('div');
  p.textContent = complete
    ? 'You have been through the whole workflow and every major function of the tracker. Nothing you did here was saved — your own games are untouched.'
    : 'You can jump to another lesson, or leave. Nothing you did in the tutorial is saved either way.';
  p.style.maxWidth = '460px';
  dlg.appendChild(p);

  if (lessonStarts.length > 1) {
    var label = make('div');
    label.textContent = complete ? 'Replay any lesson:' : 'Or jump straight to a lesson:';
    label.style.cssText = 'font:700 14px system-ui;color:#cfeaea;margin-top:4px;';
    dlg.appendChild(label);
    var sel = make('select', 'xgtuLessonSelect');
    lessonTitles.forEach(function (t, i) {
      var o = document.createElement('option');
      o.value = String(i); o.textContent = (i + 1) + '. ' + t;
      sel.appendChild(o);
    });
    // Defaults to the NEXT lesson, so the common "skip ahead" is one tap on Go.
    var cur = currentLesson();
    sel.value = String(complete ? 0 : Math.min(cur + 1, lessonTitles.length - 1));
    dlg.appendChild(sel);
  }

  var row = make('div'); row.className = 'row';
  if (!complete) row.appendChild(dlgBtn('Keep going', '#4bb8bd', '#0b2b2b', function () {
    dlg.remove();
  }));
  if (lessonStarts.length > 1) row.appendChild(dlgBtn('Go to lesson', '#1b7373', '#fff', function () {
    var v = parseInt(el('xgtuLessonSelect').value, 10) || 0;
    dlg.remove();
    goToLesson(v);
  }));
  row.appendChild(dlgBtn(complete ? 'Close' : 'Leave tutorial', '#8a3a3a', '#fff', function () {
    dlg.remove();
    stop();
  }));
  dlg.appendChild(row);
  document.body.appendChild(dlg);
}

function dlgBtn(text, bg, fg, fn) {
  var b = make('button');
  b.className = 'xgtuBtn';
  b.textContent = text;
  b.style.cssText = 'background:' + bg + ';color:' + fg + ';font:800 15px system-ui;padding:12px 22px;border-radius:999px;';
  b.onclick = fn;
  return b;
}

function currentLesson() {
  var c = 0;
  for (var i = 0; i < lessonStarts.length; i++) if (idx >= lessonStarts[i]) c = i;
  return c;
}

/* ------------------------------------------------------------ start/stop */
function flatten(ls) {
  lessons = ls;
  steps = []; lessonStarts = []; lessonTitles = [];
  ls.forEach(function (lesson, li) {
    lessonStarts.push(steps.length);
    lessonTitles.push(lesson.title);
    lesson.steps.forEach(function (s, i) {
      s._lessonTitle = lesson.title;
      s._lessonNo = li + 1;
      s._nInLesson = i + 1;
      s._ofLesson = lesson.steps.length;
      steps.push(s);
    });
  });
}

function start(which) {
  T = window.XquiXGameTracker;
  if (!T || typeof T.setTutorialMode !== 'function') {
    window.alert('The Game Tracker tutorial needs a newer Game Tracker — reload the page and try again.');
    return false;
  }
  if (running) return true;
  running = true;

  // Everything below runs against the real tracker with persistence off, so a
  // game already in progress is never written over and nothing invented here
  // reaches the coach's library.
  T.setTutorialMode(true);

  injectCss();
  tutorialRole = (which === 'goalkeeper') ? 'goalkeeper'
               : (which === 'team' || which === 'fullgame') ? 'team' : 'field';
  tutorialMode = (tutorialRole === 'team') ? 'coach' : 'parent';
  tutorialOpp = (which === 'fullgame');
  flatten(buildLessons(which || 'field'));
  if (!T.isOpen()) T.open();
  buildChrome();
  window.addEventListener('click', interactionGuard, true);
  window.addEventListener('keydown', keyGuard, true);
  // Zone renumbering is the one thing a tutorial can change that tutorialMode
  // does not cover: it has its own localStorage key, written the moment a zone
  // is renamed. Snapshotted here and put back on the way out, so practising the
  // rename in Lesson 3 does not permanently renumber a coach's own field.
  try { zoneNumBackup = localStorage.getItem(ZONE_NUM_KEY); } catch (err) { zoneNumBackup = null; }
  goTo(0);
  rafHandle = requestAnimationFrame(tick);
  return true;
}

var ZONE_NUM_KEY = 'xgtZoneNumbersV1';   // the tracker's own key; see start()
var zoneNumBackup = null;

function stop() {
  if (!running) return;
  running = false;
  allowedNow = null;
  clearHints();
  window.removeEventListener('click', interactionGuard, true);
  window.removeEventListener('keydown', keyGuard, true);
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  removeChrome();
  idx = -1;
  try {
    if (T) {
      // The tutorial never turns renaming on any more, but a coach can have
      // left it on before starting one -- and with it on, every zone tap
      // renumbers instead of logging, which would make the whole tutorial
      // silently do nothing. Cheap to guarantee, expensive to diagnose.
      T.state.editingZoneNumbers = false;
      if (zoneNumBackup === null) localStorage.removeItem(ZONE_NUM_KEY);
      else localStorage.setItem(ZONE_NUM_KEY, zoneNumBackup);
      try { T.state.zoneNumberOverrides = JSON.parse(zoneNumBackup || '{}'); } catch (e2) { T.state.zoneNumberOverrides = {}; }
    }
  } catch (err) { console.error('XquiX tutorial: zone restore threw', err); }
  try {
    if (T) {
      if (T.isOpen()) T.close();
      T.setTutorialMode(false);   // after close(), so the closing path stays suppressed too
    }
  } catch (err) { console.error('XquiX tutorial: teardown threw', err); }
  if (typeof window.xquixShowHome === 'function') { try { window.xquixShowHome(); } catch (err) {} }
}
/* ======================================================================= */
/* THE LESSONS                                                             */
/*                                                                         */
/* Two tutorials so far, and deliberately not one tutorial with branches.  */
/* A goalkeeper coach may never take the field-player one, so B has to     */
/* stand alone: the same seven lessons, the same shape, its own content    */
/* wherever the tracker actually behaves differently.                      */
/*                                                                         */
/* Three lessons ARE identical and are built once, below: setting a        */
/* session up, the clock, and ending the game. What they differ in is      */
/* passed in -- which role button the demo taps, and which event the clock */
/* lesson logs. The rest is written out per tutorial, because sharing      */
/* lessons that merely look alike is how one tutorial's feedback silently  */
/* edits the other.                                                       */
/*                                                                         */
/* A - FIELD PLAYER: tracking one specific field player. The Parent /      */
/* Coach switch does not change this flow at all (singlePlayerMode() is    */
/* true for every combination except Coach + Team), so it is said once.    */
/*                                                                         */
/* B - GOALKEEPER: the same tracker from the other end. The field zone     */
/* means WHERE THE OPPONENT SHOT FROM; there is no Mine / Teammate /       */
/* Opponent row (stepAction renders it only for !gk); a shot belongs to    */
/* the opponent and everything else to the keeper; and the tree carries    */
/* shot types, Defender Block and the outlet pass.                         */
/*                                                                         */
/* No required step in either uses a gated action. On the free tier the    */
/* keeper tree is trimmed to shot / personal foul / steal and the          */
/* shot-type step is dropped entirely (freeTierActions), so every Pro-only */
/* screen is either described in a read-only step or reached through an    */
/* OPTIONAL '?' link in an auto-complete chain -- never asked for.         */
/* ======================================================================= */
function buildLessons(which) {
  var base = 0;         // action-count baseline, reset per step that needs one
  var clockTarget = 0;  // the exact time L2 asks the coach to dial in
  var scrollFrom = 0;   // #stageWrap scroll position when the scroll step began
  var mark = function () { base = actions().length; };
  /* "Done" means the event is COMMITTED, not merely that a matching one exists.
     With an open draft still on screen, a baseline left over from an earlier
     step reads as success and advances the tutorial with a sheet the next step
     may not allow anyone to close. Every event step marks its own baseline and
     waits for the draft to clear. */
  var logged = function (want) {
    return function () { return !T.state.draft && loggedSince(base, want); };
  };
  /* The sideline scroll strip -- but only its upper half, as a plain rectangle.
     The strip itself runs almost the full height of the water, and a box that
     has to clear something 600px tall on an 844px phone has nowhere to go: in
     the team tutorials, where the roster bar is two columns and the band is
     shorter still, it ended up overlapping the very thing it was pointing at.
     Half a strip is still unmistakably "this edge", and it leaves the box a
     place to stand. */
  var scrollStrip = function () {
    var e = null;
    var r = document.getElementById('fcScrollZoneRight');
    if (r && r.style.display === 'block') e = r;
    else {
      var l = document.getElementById('fcScrollZoneLeft');
      if (l && l.style.display === 'block') e = l;
    }
    if (!e) return null;
    var b = e.getBoundingClientRect();
    if (!b.height) return e;
    return { top: b.top, left: b.left, right: b.right, bottom: b.top + b.height * 0.5,
             width: b.width, height: b.height * 0.5 };
  };

  /* A squad chip that has not been picked yet, for the demo and for the ring.
     The setup sheet is re-rendered on every chip tap, so this is re-evaluated
     each time rather than held. */
  var nextSquadChip = function () {
    return pickMissing('#xgtSquad', 'n', DEMO_SQUAD, T.state.squad);
  };
  var nextOppChip = function () {
    return pickMissing('#xgtOppSquad', 'opp-n', DEMO_OPP_SQUAD, T.state.oppSquad);
  };
  /* Tap what is still missing, one chip at a time, re-querying between taps.
     Used by the squad steps' autoComplete -- "Next step" has to be able to
     finish a step the coach started half-way through. */
  var fillChips = function (pick) {
    return function () {
      (function once() {
        if (!running) return;
        var sel = pick();
        if (!sel) return;
        clickThrough(sel);
        setTimeout(once, 90);
      })();
    };
  };

  /* ---- C and D only: the squad, the keepers, and (D) the other squad ----
     Where A and B ask for one cap number, the team tutorials build a roster.
     go() enforces a real minimum here -- SEVEN numbers, and seven more for the
     opposing squad when it is tracked -- and refuses with an error message
     otherwise, so these steps are the only ones in any tutorial whose
     requirement comes from the tracker rather than from the lesson. */
  function squadSteps(opts) {
    var steps = [

    { instruction: 'Now the squad. <b>Tap every cap number that is dressed today</b> — at least <b>seven</b>, or the tracker will not start.\n\nTap <b>1</b> through <b>7</b> for now.',
      highlight: nextSquadChip,
      allow: '#xgtSquad',
      validate: function () { return T.state.squad.length >= 7; },
      autoComplete: fillChips(nextSquadChip),
      success: 'Squad in' },

    // #1 auto-marks as a goalkeeper the moment it enters the squad, which is
    // right almost always and wrong often enough to be worth a sentence -- some
    // clubs cap their keeper 13.
    { ack: true,
      calmRing: true,
      highlight: '#xgtKeepers',
      instruction: 'Under the squad are the same numbers again, for the <b>goalkeepers</b>. <b>#1 marked itself</b> when it went into the squad — tap it again to un-mark it if your keeper wears something else, and tap any number to add a second keeper.\n\n' +
        'This matters more than it looks: every opponent action you log is credited to whichever keeper is <b>in the water at the time</b>. Their whole game comes free.' },

    { ack: true,
      instruction: 'If your competition labels a backup keeper <b>1A</b> or <b>1B</b> instead of giving them their own cap number, there is a box for that under each keeper. Optional — leave it blank and the number shows.' }

    ];

    if (!opts.opponent) return steps;

    return steps.concat([

    { instruction: 'This is the tutorial that tracks <b>both</b> teams, so switch on <b>Track opposing team too</b>.',
      highlight: '#xgtOppToggle',
      allow: '#xgtOppToggle',
      validate: function () { return T.state.opponentTracked === true; },
      autoComplete: function () { click('#xgtOppToggle'); },
      success: 'Both teams' },

    { ack: true,
      instruction: 'Be honest with yourself about what you just took on: <b>roughly twice the taps</b>, for a whole game, on your own.\n\n' +
        'What you get back is the other half of the picture — every shot your keeper faces has a name on it, and you can read the opponent’s game the same way you read your own.' },

    { instruction: 'Their squad works the same way. <b>Tap at least seven</b> of their numbers — <b>1</b> through <b>7</b> again is fine.',
      highlight: nextOppChip,
      allow: '#xgtOppSquad',
      validate: function () { return (T.state.oppSquad || []).length >= 7; },
      autoComplete: fillChips(nextOppChip),
      success: 'Their squad in' },

    // Deliberately an ack, not a task: nothing downstream needs their keeper
    // marked, and #1 does NOT auto-mark on the opponent side, so asking for it
    // would be asking for a tap the tracker does not require.
    { ack: true,
      calmRing: true,
      highlight: '#xgtOppKeepers',
      instruction: 'And their <b>goalkeepers</b>, from the numbers you just picked. Nothing marks itself on this side, so if you know which one it is, tap it — that is what puts a name on the keeper who stops your shots.' }

    ]);
  }

  /* ---- the three lessons all four tutorials share, built once ---------- */
  function lessonSetup(opts) {
    return   { title: 'Set up a session', steps: [
    { ack: true,
      // Deliberately not "you will track a full game". You will not -- you will
      // log a handful of events to learn the shape of the thing. Promising a
      // full game sets up the wrong expectation for what the next ten minutes
      // actually are.
      instruction: 'Welcome to the <b>Game Tracker</b>.\n\n' +
        'These lessons teach you the <b>workflow</b> and the <b>main functions</b>: how an event gets logged, how the clock works, what the stats show you while you track, and how a game is closed out.\n\n' +
        'The Game Tracker is part of the <b>free version</b>. A few of the functions along the way are <b>Pro</b> only — the lessons say so when one comes up, and Pro can be booked at any time.' },

    { ack: true,
      // The ring is pointed at the button the coach is about to press, so the
      // sentence explaining it is demonstrated by the thing itself -- and it is
      // red, not the calm ring, because this one really is meant to be pressed.
      highlight: '#xgtuAck',
      redRing: true,
      instruction: 'Two things about how this works.\n\n' +
        'A <b>pulsing red ring</b> marks the one thing to tap — like the one around <b>Got it</b> right now. A calm <b>amber ring</b> just means "look here", nothing to press.\n\n' +
        'Each step moves on by itself the moment you have done it. If you would rather not, <b>Next step →</b> does it for you.' },

    { instruction: 'Tap <b>Start a new game</b> to set up a fresh one.\n\n' +
        'If you had left a game unfinished, a <b>Resume this game</b> option would be here too — a session survives closing the app.',
      highlight: '#xgtFresh',
      allow: '#xgtFresh',
      validate: function () { return sheetOpen() && !!el('xgtGo'); },
      autoComplete: function () { click('#xgtFresh'); } },

    // Four beats, two seconds each, ringed one at a time. The two segments used
    // to be a step of their own, chosen by the coach; MIZE asked for them
    // demonstrated at the same pace as the typed fields, and a step that only
    // re-selects what the demo has already selected is a step for nothing.
    // Read first, watch second. The animation used to start the moment the step
    // arrived, with this text alongside it -- so the coach was reading and
    // watching at once and felt they were missing whichever they were not doing.
    // Now the words wait behind Got it, and the demo runs with the box silent.
    { ack: true,
      highlight: '#xgtuAck',
      redRing: true,
      instruction: 'Next, the top of the setup fills itself in — one thing at a time. Tap <b>Got it</b> and watch.\n\n' +
        (opts.squad
          // The one load-bearing instruction in C and D. A team parent who
          // picks "Parent" never sees the squad UI -- it renders only for
          // coach + team -- and gets stuck on the setup screen with nothing
          // to enter and no explanation.
          ? '<b>Who is tracking</b> has to be <b>Coach / Team</b> here, whoever you are. A parent keeping stats for the whole squad picks it too: the squad only appears in that combination.\n\n' +
            '<b>Tracking role</b> is <b>Team</b> — that is what turns one player into a whole roster.\n\n'
          : '<b>Who is tracking</b> is only a label on the record. <b>Tracking role</b> is the one that decides what you tap during the game — and this tutorial is the <b>' + opts.roleName + '</b> one.\n\n') +
        'Then the game itself. Worth entering for real: these names replace <b>Us</b> and <b>Them</b> on every button and in every export.' },

    { instruction: '',
      quiet: true,
      auto: true,
      onEnter: function () {
        demoDone = false;
        autoTap('#xgtTm [data-tm="' + (opts.mode || 'parent') + '"]', function () {
          autoTap('#xgtRl [data-role="' + opts.role + '"]', function () {
            autoType('#xgtLoc', 'WP City', function () {
              autoType('#xgtAway', 'Black Octopus', function () { ringOverride = null; demoDone = true; });
            });
          });
        });
      },
      validate: function () { return demoDone; },
      autoComplete: function () {
        ringOverride = null;
        // Skipping the demo must still leave the mode AND the role set -- every
        // lesson after this one depends on which flow the tracker is in, and
        // squad tracking needs both halves.
        if (T.state.trackingMode !== (opts.mode || 'parent')) clickThrough('#xgtTm [data-tm="' + (opts.mode || 'parent') + '"]');
        if (T.state.playerRole !== opts.role) clickThrough('#xgtRl [data-role="' + opts.role + '"]');
        demoDone = true;
      } },

    { instruction: 'Your turn. <b>Tap the field</b>, type <b>your own team’s name</b>, then press <b>Enter</b> to confirm it.',
      highlight: '#xgtHome',
      allow: '#xgtHome',
      commit: '#xgtHome',
      validate: function () { return inputCommitted && !!fieldValue('#xgtHome'); },
      autoComplete: function () { autoType('#xgtHome', 'WP City Waves', function () {}); } },

    ].concat(opts.squad ? squadSteps(opts) : [

    { instruction: '<b>Tap the next field</b> and enter the <b>cap number</b> of the ' + opts.who + ' you are tracking, then <b>Enter</b> to confirm.',
      highlight: '#xgtNum',
      allow: '#xgtNum',
      commit: '#xgtNum',
      validate: function () { return inputCommitted && !!fieldValue('#xgtNum'); },
      // 1 for the keeper, 7 for the field player -- the demo should not type a
      // cap number no goalkeeper wears.
      autoComplete: function () {
        autoType('#xgtNum', opts.role === 'goalkeeper' ? '1' : '7', function () {});
      } }

    ]).concat([

    { instruction: 'Tap <b>Start tracking</b>.',
      highlight: '#xgtGo',
      allow: '#xgtGo',
      // NOT #xgtPres: the bar renders as soon as the tracker opens, so that was
      // already true before this button was pressed -- which is why the tutorial
      // once jumped to lesson 2 on its own. go() closes the setup sheet and
      // commits the cap number, so those two together are the real signal.
      //
      // In team mode there IS no cap number -- go()'s own check is skipped for
      // coach + team and S.me stays {number:null}. What go() commits instead is
      // the starting seven, as presence events, so that is the signal there.
      validate: opts.squad
        ? function () { return !sheetOpen() && T.state.water.length > 0; }
        : function () { return !sheetOpen() && T.state.me.number != null; },
      autoComplete: function () { click('#xgtGo'); },
      success: 'Tracking' },

    // The two sideline strips are Studio's own drag-to-scroll zones, and the
    // tracker's shield cuts a hole in itself for exactly this (positionShield's
    // clip-path). Without being told, nobody finds them -- they are 2m wide and
    // look like part of the deck.
    // Kept short on purpose. This box has to share an 844px phone with a ring
    // that runs down the whole sideline, and the team tutorials' two-column
    // roster bar takes another slice off the bottom.
    { instruction: 'The pool carries on past the top of the screen. To move up and down it, <b>drag on the narrow strip along either sideline</b> — the middle is for tapping field zones.\n\nTry it now.',
      gesture: true,
      highlight: scrollStrip,
      onEnter: function () { var w = stageWrap(); scrollFrom = w ? w.scrollTop : 0; },
      validate: function () {
        var w = stageWrap();
        if (!w) return true;
        // On a screen tall enough to show the whole pool there is nothing to
        // scroll, and asking for it would be a dead end rather than a lesson.
        if (w.scrollHeight - w.clientHeight < 12) return true;
        return Math.abs(w.scrollTop - scrollFrom) > 8;
      },
      autoComplete: function () {
        var w = stageWrap();
        if (!w) return;
        // Whichever way there is room. Scrolling down unconditionally is a
        // no-op when the field is already at the bottom -- which is where the
        // two-column roster bar of the team tutorials happens to leave it, so
        // "Next step" could not finish this step at all there.
        var room = w.scrollHeight - w.clientHeight;
        var by = Math.min(120, Math.max(20, room));
        w.scrollTop = (w.scrollTop + by <= room) ? w.scrollTop + by : Math.max(0, w.scrollTop - by);
      },
      success: 'That is the pool' }
  ])};
  }

  function lessonClock(opts) {
    return   { title: 'The clock', steps: [
    { ack: true,
      // Nothing is clickable on an ack step, so the clock cannot be started here.
      instruction: 'At the top of the screen you can see the current <b>quarter</b> and the <b>game clock</b>.\n\n' +
        'The clock counts down from <b>8:00</b>. If your competition plays shorter quarters, the quarter time can be adjusted — in the time sheet behind the quarter button, which this lesson comes to shortly.',
      highlight: '#xgtClock' },

    { instruction: 'Tap the clock to start it.',
      highlight: '#xgtT',
      allow: '#xgtT',
      validate: function () { return T.state.running === true; },
      autoComplete: function () { click('#xgtT'); },
      success: 'Running' },

    { ack: true,
      // Split in two. As one step this was eight lines on a phone and the box
      // pushed down over the field it was talking about.
      instruction: 'Here is the part nobody expects, and it is worth knowing.\n\n' +
        'When you <b>start entering an event</b>, the tracker remembers the clock at that instant — but keeps it running. It does not freeze while you choose.' },

    { ack: true,
      instruction: 'What happens when you finish depends on what you logged.\n\n' +
        'If it <b>stops play</b> — a goal, or a personal foul — the clock jumps back to the moment you started, and stops there.\n\n' +
        'If it does not stop play — a blocked shot — the clock is left alone, because it was right all along.' },

    { instruction: 'Let’s watch that happen. <b>Tap the water anywhere in front of the goal</b> — never mind the field zones and the numbers for now.',
      onEnter: mark,
      allowZone: '*',
      validate: function () { return !!(T.state.draft && T.state.draft.fieldZone); },
      autoComplete: function () { tapZone('z3'); } },

    { instruction: opts.goalInstruction,
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      validate: logged({ action: 'shot', outcome: 'goal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z3'); }].concat(opts.goalChain));
      },
      success: 'Goal logged' },

    { ack: true,
      instruction: 'Look at the clock — it stopped on its own, at the moment you started the event. The seconds you spent choosing were not taken off the game.',
      highlight: '#xgtT' },

    { instruction: 'To correct the clock, or to change quarter, tap the <b>quarter button</b> at the top left — the one showing <b>Q1</b> with a pencil on it. The pencil is what marks it as editable.',
      highlight: '#xgtQ',
      allow: '#xgtQ',
      validate: function () { return !!el('xgtDone'); },
      autoComplete: function () { click('#xgtQ'); } },

    { ack: true,
      instruction: '',   // written by onEnter, which knows the real target time
      onEnter: function () {
        clockTarget = Math.max(0, T.state.clock - 11);
        setText('This is the sheet. The <b>quarter chips</b> are along the top, and <b>SO</b> is there for a potential penalty shootout.\n\n' +
          'Say the official pool clock is <b>11 seconds behind</b> yours. Take the 11 seconds off: tap <b>−0:10</b>, then <b>−0:01</b>, then <b>Done</b> — aiming for <b>' + mmss(clockTarget) + '</b>. The red ring leads.\n\n' +
          'Events you have already logged keep their own timestamps; this only moves the clock.');
      } },

    // Quiet on purpose. On a phone this box covered half the time sheet, and a
    // coach who never sees the sheet whole does not recognise it when they meet
    // it for real. The instruction is on the step above, behind Got it; here the
    // ring alone leads -- and clockTarget is NOT recomputed, or the target would
    // move with every tap.
    { instruction: '',
      quiet: true,
      // #xgtQ as well as the sheet: tap Done at the wrong time and you need a
      // way back in to correct it. Without this the step could only be escaped
      // with "Next step", which is a rescue, not a route.
      allow: ['#xgtSheet', '#xgtQ'],
      // Three taps in a fixed order, and all three buttons are on screen at
      // once -- so the ring is driven by how far the clock has actually come,
      // not by which of them happens to be visible.
      highlight: function () {
        var c = T.state.clock;
        if (c < clockTarget) return q('[data-d="1"]');    // overshot: come back up
        if (c > clockTarget + 1) return q('[data-d="-10"]');
        if (c > clockTarget) return q('[data-d="-1"]');
        return q('#xgtDone');
      },
      // Both the exact time AND the sheet being closed: adjusting without
      // confirming is not the same as finishing the step.
      validate: function () { return !sheetOpen() && T.state.clock === clockTarget; },
      autoComplete: function () { chain(['[data-d="-10"]', '[data-d="-1"]', '#xgtDone']); },
      success: 'Clock corrected' }
  ]};
  }

  /* opts.extraSteps land after the post-game-foul step and before the Menu --
     which is where the shootout belongs, because it is the other thing that can
     still happen once regulation is over. A has none; B has the shootout. */
  function lessonEnding(opts) {
    opts = opts || {};
    return   { title: 'Ending the game', steps: [
    { ack: true,
      instruction: 'Four quarters — and you change quarter from the same time sheet you used earlier, on the <b>quarter button</b> at the top left.',
      highlight: '#xgtQ' },

    { ack: true,
      instruction: 'When the clock hits 0:00 in Q4, regulation ends by itself and the field stops taking taps — there is no meaningful "where on the field" once it is over.' },

    { ack: true,
      instruction: 'But since there is the chance that misconducts happen after the buzzer, certain options stay available: <b>Menu → Log Post-Game Foul</b> appears at that point, and only then.',
      highlight: '#xgtOptionsBtn' }
  ].concat(opts.extraSteps || []).concat([

    { instruction: 'To finish a game, open the <b>Menu</b> again.',
      highlight: '#xgtOptionsBtn',
      allow: '#xgtOptionsBtn',
      validate: function () { return sheetOpen() && !!el('xgtOptEndSave'); },
      autoComplete: function () { click('#xgtOptionsBtn'); } },

    { ack: true,
      calmRing: true,
      highlight: '#xgtOptEndSave',
      instruction: '<b>End &amp; Save Session</b> is here. Be reassured rather than anxious about it: the session has been saved after every single tap, so this saves nothing new — it marks the game finished.' },

    { ack: true,
      calmRing: true,
      highlight: '#xgtOptCsv',
      instruction: '<b>Export CSV</b> and <b>Export JSON</b> are free on every tier, for the game in front of you.\n\nCSV opens in a spreadsheet; JSON keeps every field including coordinates.' },

    { instruction: 'Close the menu with the ✕.',
      highlight: '#xgtX',
      allow: '#xgtX',
      validate: function () { return !sheetOpen(); },
      autoComplete: function () { click('#xgtX'); } },

    { ack: true,
      instruction: 'On <b>Pro</b>, sessions also get saved into your online library, to be accessible across any device and to be able to see combined stats across multiple games you have tracked — and the heat map and goal map export as a PDF you can hand a player.' }
  ])};
  }

  /* The shootout, for the goalkeeper tutorial only. A keeper faces it, so it
     belongs here -- but what the tracker does with it has to be said straight.
     actionEvents() excludes anything carrying context.shootout, and that one
     filter feeds BOTH the live stats panel and the four-quarter score. So the
     attempts are recorded, tallied and exported, and they do NOT move the save
     percentage. Saying otherwise would be the kind of promise a parent checks. */
  var shootoutSteps = [
    { ack: true,
      calmRing: true,
      highlight: '#xgtQ',
      instruction: 'And then there is the <b>penalty shootout</b>. It lives on the time sheet, as an <b>SO</b> chip beside the quarter chips.' },

    { ack: true,
      instruction: 'Every attempt is recorded: who took it, and whether your keeper saved it. Shooting order is enforced for you, with an override for competitions that do it differently.' },

    { ack: true,
      instruction: 'One thing to know about the numbers. A shootout keeps its <b>own score</b>, separate from the four quarters — so it does not change the game score, and it does not move the save percentage in your stats.\n\n' +
        'The attempts are all there in the <b>full log</b> and in the <b>export</b>.' }
  ];

  /* The same three beats for a team. Wording differs because nothing here is
     about one keeper's save percentage -- and because in team mode the panel
     has no full log to point at (openTeamStats does not render one), so the
     export is the only place to send someone. */
  var teamShootoutSteps = [
    { ack: true,
      calmRing: true,
      highlight: '#xgtQ',
      instruction: 'And then there is the <b>penalty shootout</b>. It lives on the time sheet, as an <b>SO</b> chip beside the quarter chips.' },

    { ack: true,
      instruction: 'Every attempt is recorded: who took it, and whether it went in. Shooting order is enforced for you, with an override for competitions that do it differently.' },

    { ack: true,
      instruction: 'A shootout keeps its <b>own score</b>, separate from the four quarters. It does not move the game score and it does not move any player’s shooting percentage — the attempts are in the <b>export</b>, counted as their own thing.' }
  ];

  if (which === 'field') return [
    lessonSetup({ role: 'field', roleName: 'Field Player', who: 'player' }),
    lessonClock({
      goalInstruction: 'Now log a <b>Shot</b> by tapping that button, then log a <b>Goal</b> with the button that appears next, and tap roughly where in the net it went.\n\n' +
        'On <b>Pro</b> you then get the chance to log the <b>assist giver</b> \u2014 or to skip that step.',
      goalChain: ['.xgtOpts [data-a="shot"]', '[data-s="goal"]', '.gz[data-p="low_left"]', '?#xgtAssistSkip']
    }),
  { title: 'Field zones', steps: [
    { ack: true,
      instruction: 'The core idea of the Game Tracker is simple:\n\n' +
        '<b>Tap the field zone</b> where the event happened, then tap the <b>action</b>, then the <b>outcome</b> — and any follow-up the tracker asks for.\n\n' +
        'Field zone → action → outcome. Every event starts with the field zone; there is no other way in.' },

    { ack: true,
      instruction: 'The water is divided into <b>field zones</b>: the area right in front of the goal, a ring of zones around it, and the wider areas further out. Anything in the opposite half is the little <b>OPPO</b> area.\n\n' +
        'They are there so you can say exactly <b>where</b> something happened — to yourself when you read the stats back, and to anyone else you share them with.',
      highlight: '#xgtZoneLayer' },

    // The zone itself is ringed, which is only possible because every wedge
    // carries data-zone. It is the semi-circle right in front of the goal --
    // named by where it is on the field, never by its number, which is
    // per-device (rule 7.9).
    { instruction: 'Tap the <b>field zone</b> right in front of the goal — the semi-circle the ring is around.',
      highlight: '#xgtZoneLayer path[data-zone="z6"]',
      allowZone: 'z6',
      validate: function () { return !!(T.state.draft && T.state.draft.fieldZone === 'z6'); },
      autoComplete: function () { tapZone('z6'); },
      success: 'Logged the zone' },

    { instruction: 'Tapped the wrong place? Close the sheet with the ✕ and nothing is recorded.\n\nDo that now.',
      highlight: '#xgtX',
      allow: '#xgtX',
      validate: function () { return !T.state.draft; },
      autoComplete: function () { click('#xgtX'); },
      success: 'Nothing logged' },

    { instruction: 'Last thing in this lesson. Open the <b>Menu</b>.',
      highlight: '#xgtOptionsBtn',
      allow: '#xgtOptionsBtn',
      validate: function () { return sheetOpen() && !!el('xgtOptEditNums'); },
      autoComplete: function () { click('#xgtOptionsBtn'); } },

    // Renaming and hiding used to be practised here, three steps of it. They are
    // mentioned instead: neither changes how anything is logged, and the rename
    // flow left a mode switched on that quietly broke every later zone tap.
    { instruction: 'The field zones have two options in here. You can <b>rename</b> them, if your club numbers them differently — and you can <b>hide</b> them, if you find the numbers distracting. Both are personal to this device.\n\nThen close the menu with the ✕.',
      // Both rows, not just one: a ring around Hide Field Zones alone reads as
      // "Rename is not what we are being told about", which is how it landed on
      // a device -- "there is no amber circle around Rename Field Zones".
      highlight: function () { return spanOf(['#xgtOptEditNums', '#xgtOptZones']); },
      calmRing: true,          // amber: this is being pointed out, not asked for
      then: '#xgtX',           // …and after a beat the ring moves to what to tap
      thenAfter: 3000,
      allow: '#xgtX',
      validate: function () { return !sheetOpen(); },
      autoComplete: function () { click('#xgtX'); } }
  ]},
  { title: 'Actions and outcomes', steps: [
    { instruction: 'Tap any <b>field zone</b> to open the action sheet again.',
      onEnter: mark,
      allowZone: '*',
      validate: function () { return !!(T.state.draft && T.state.draft.fieldZone); },
      autoComplete: function () { tapZone('z2'); } },

    { ack: true,
      instruction: 'The row at the top is easy to miss and worth knowing: <b>Mine / Teammate / Opponent</b>.\n\n' +
        'It defaults to your player, so the usual case needs no tap — but this is how you log an action where your player was not the committing part, like a drawn exclusion or a drawn penalty.',
      highlight: '#xgtAttr' },

    // The ring follows the sheet through its three screens. Fixed to the first
    // button it goes blank for the rest of the step, which reads as "nothing to
    // tap here" at exactly the moment there is.
    { instruction: 'Log a <b>blocked shot</b>: tap <b>Shot</b>, then <b>Blocked Shot</b>, then tap the part of the goal where it was stopped.\n\n' +
        'A blocked shot is a shot that <b>reached the goal</b> — so it is the opponent’s <b>goalkeeper</b> who stopped it. That is why this one asks you where in the goal.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['.xgtOpts [data-a="shot"]', '[data-s="blocked"]', '.xgtGoal']),
      // Done when the placement is tapped, not when the whole event commits --
      // on Pro a follow-up sheet comes after it, and that gets its own step.
      validate: function () {
        return (T.state.draft && T.state.draft.goalPlacement) ||
               loggedSince(base, { action: 'shot', outcome: 'blocked' });
      },
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z2'); },
                   '.xgtOpts [data-a="shot"]', '[data-s="blocked"]', '.gz[data-p="middle_center"]']);
      },
      success: 'Save logged' },

    // Placed here rather than after the missed-shot explanation because on Pro
    // this sheet is open RIGHT NOW -- describing it two steps later would mean
    // talking about something the coach already had to answer or dismiss.
    { ack: true,
      allow: '#xgtSheet',
      instruction: 'On <b>Pro</b>, a blocked or missed shot is followed by one more question: <b>how the situation went on</b>.\n\n' +
        'A save does not end the play — the ball can rebound and stay in the water, or go out. That is what puts a corner throw or a goalie ball into the numbers later.',
      // Whatever is left open when they move on gets cancelled, so the next
      // step starts from a clean field.
      onLeave: function () { if (T.state.draft) clickThrough('#xgtX'); } },

    { ack: true,
      instruction: 'Any shot that does <b>not</b> reach the goal is a <b>Missed Shot</b> — including a blocked shot by a field player, or hitting the frame of the goal.' },

    { instruction: 'Let’s log a <b>Missed Shot</b> now to test it.\n\nTap a field zone, then <b>Shot</b>, then <b>Missed Shot</b>.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['.xgtOpts [data-a="shot"]', '[data-s="missed"]']),
      validate: function () { return !!(T.state.draft && T.state.draft.outcome === 'missed'); },
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z4'); },
                   '.xgtOpts [data-a="shot"]', '[data-s="missed"]']);
      } },

    { ack: true,
      calmRing: true,
      highlight: '.xgtGoal',
      instruction: 'This map is the goal and everything around it — the posts, the crossbar, wide on either side, over the bar, and short into the water.' },

    { ack: true,
      calmRing: true,
      highlight: '.gz[data-p="blocked_field"]',
      instruction: 'And the area <b>inside the goal</b> is the one for a shot a <b>field player</b> blocked on its way in.' },

    { instruction: 'Now tap where the shot went.',
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['.xgtGoal', '.xgtOpts [data-a="shot"]']),
      validate: logged({ action: 'shot', outcome: 'missed' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z4'); },
                   '.xgtOpts [data-a="shot"]', '[data-s="missed"]', '.gz[data-p="blocked_field"]']);
      },
      success: 'Miss logged' },

    { instruction: 'Now the <b>major fouls</b>. Tap a field zone, then <b>Personal Foul</b>, then <b>Exclusion (20 s)</b>.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      // Penalty is described in the next step, not offered here: choosing it
      // launches the penalty-shot flow, which this lesson has not prepared
      // anyone for. Denied rather than narrowing `allow`, so the ✕ and the back
      // arrow stay live and a mis-tap is never a dead end.
      deny: '[data-s="penalty"]',
      highlight: firstVisible(['.xgtOpts [data-a="exclusion"]', '[data-s="exclusion"]']),
      validate: logged({ action: 'exclusion' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z5'); },
                   '.xgtOpts [data-a="exclusion"]', '[data-s="exclusion"]']);
      },
      success: 'Foul logged' },

    { ack: true,
      instruction: '<b>Penalty (5 m)</b> sits in that same list — pick it when the foul was a penalty rather than an exclusion.\n\n' +
        'The tracker then opens the resulting penalty shot by itself. That shot belongs to the <b>other team</b>, so following one of your own field players you can simply close it — it is there for tracking a whole game.' },

    { instruction: 'One more: a <b>Steal</b>. Tap a field zone and pick it — there is no outcome to choose, it is a single tap.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['.xgtOpts [data-a="steal"]']),
      validate: logged({ action: 'steal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z6'); }, '.xgtOpts [data-a="steal"]']);
      },
      success: 'Steal logged' },

    { ack: true,
      instruction: 'The pill at the bottom is your player going in and out of the water. Tap it when they get subbed in or out, so that you can log the playing time.',
      highlight: '#xgtPres' },

    { ack: true,
      instruction: 'On <b>Pro</b> the same sheet also carries <b>Turnover</b> as its own action — offensive foul, pass intercepted, shot clock — plus more detailed options for foul outcomes.' }
  ]},
  { title: 'Reading the stats', steps: [
    { instruction: 'You can read the live statistics during the game, without stopping it. Tap <b>Stats</b>.\n\n' +
        'Depending on your screen size you may have to scroll up and down to follow the next steps.',
      highlight: '#xgtStatsBtn',
      allow: '#xgtStatsBtn',
      validate: statsOpen,
      autoComplete: function () { click('#xgtStatsBtn'); } },

    // Every section of the stats panel gets an amber ring while it is being
    // described, and is scrolled into view first -- the panel is taller than any
    // phone, so a ring on a section below the fold is a ring nobody sees.
    { ack: true,
      calmRing: true,
      highlight: statsTiles,
      onEnter: reveal(statsTiles),
      instruction: 'Goals, shots, shooting percentage, steals, exclusions drawn and given, assists, time in the water — all live, from what you have logged.' },

    { ack: true,
      calmRing: true,
      highlight: statsSection(/where it happened|shot origin/i),
      onEnter: reveal(statsSection(/where it happened|shot origin/i)),
      instruction: 'The heat diagram below shows where the events happened. The darker the field zone, the more action has been logged there.' },

    { ack: true,
      calmRing: true,
      highlight: statsSection(/goal placement/i),
      onEnter: reveal(statsSection(/goal placement/i)),
      instruction: 'Below that you can see the <b>Shot Placement</b> graphic, which shows the shots on and around the goal.\n\n' +
        'Every shot that got taken lands somewhere on this picture. Over a season it is where a shooter’s habit shows up.' },

    { ack: true,
      calmRing: true,
      highlight: statsSection(/origin/i),
      onEnter: reveal(statsSection(/origin/i)),
      instruction: '<b>Origin → outcome → placement</b> is stored per event, not worked out afterwards.\n\nThat is exactly why the tracker asks you for a field zone every single time.' },

    { ack: true,
      calmRing: true,
      highlight: statsSection(/full log/i),
      onEnter: reveal(statsSection(/full log/i)),
      instruction: 'Under it is the <b>full log</b>. Tap any line to correct or delete it, and <b>+ Add Event</b> for the one you missed.' },

    { instruction: 'Scroll back up to the top, then close the stats with <b>‹ Back</b>.',
      highlight: '#xgtSb',
      onEnter: reveal('#xgtSb'),
      allow: ['#xgtSb', '#xgtStats'],
      validate: function () { return !statsOpen(); },
      autoComplete: function () { click('#xgtSb'); } }
  ]},
    lessonEnding(),
  { title: 'Track it yourself', steps: [
    { ack: true,
      instruction: 'Last part. From here the tutorial stops pointing at buttons — you get told what happened in the game, and you log it.\n\n' +
        'Three moments, one at a time. If you get stuck, wait a few seconds and a hint appears.' },

    // No zone is named, by number or by position. What is being practised is the
    // order -- field zone, then action, then outcome -- and naming a particular
    // zone would make the exercise about finding it instead.
    { instruction: 'Now try it yourself. Your player <b>scores</b>.',
      onEnter: function () { mark(); practice = { done: [] }; },
      allowZone: '*',
      allow: ['#xgtSheet', '#xgtUn'],
      hints: [
        'Start with the <b>field zone</b> — the water is where every event begins.',
        'Tap the field zone the shot was taken from, then <b>Shot</b>.',
        'Then <b>Goal</b>, and roughly where in the net it went.'
      ],
      misstep: function () {
        var e = stray(base, { action: 'shot', outcome: 'goal' });
        if (!e) return null;
        return 'That logged a <b>' + nameOf(e) + '</b>. Tap <b>↩</b> at the bottom to undo it, then log a goal.';
      },
      validate: logged({ action: 'shot', outcome: 'goal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z3'); }, '.xgtOpts [data-a="shot"]', '[data-s="goal"]',
                   '.gz[data-p="top_right"]', '?#xgtAssistSkip']);
      },
      success: 'That is the one' },

    // Own-team events only. An opponent's shot that the tracked player was not
    // part of is not something a single-player tracker records at all, so using
    // one as practice teaches the wrong instinct.
    { instruction: 'Your player takes a shot and it is <b>blocked</b>.',
      onEnter: mark,
      allowZone: '*',
      allow: ['#xgtSheet', '#xgtUn'],
      hints: [
        'Field zone first — wherever the shot came from.',
        'Then <b>Shot</b>, then <b>Blocked Shot</b>, then where in the goal the keeper stopped it.'
      ],
      misstep: function () {
        var e = stray(base, { action: 'shot', outcome: 'blocked' });
        if (!e) return null;
        return 'That logged a <b>' + nameOf(e) + '</b>. Tap <b>↩</b> at the bottom to undo it, then log a blocked shot.';
      },
      validate: logged({ action: 'shot', outcome: 'blocked' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z1'); }, '.xgtOpts [data-a="shot"]', '[data-s="blocked"]',
                   '.gz[data-p="middle_center"]', '?[data-br="gk_in"]']);
      },
      success: 'Blocked' },

    { instruction: 'Your player <b>steals the ball</b> — anywhere on the field you like.',
      onEnter: mark,
      allowZone: '*',
      allow: ['#xgtSheet', '#xgtUn'],
      hints: [
        'Tap any <b>field zone</b> first.',
        '<b>Steal</b> is a single tap — there is no outcome to choose after it.'
      ],
      misstep: function () {
        var e = stray(base, { action: 'steal' });
        if (!e) return null;
        return 'That logged a <b>' + nameOf(e) + '</b>. Tap <b>↩</b> at the bottom to undo it, then log a steal.';
      },
      validate: logged({ action: 'steal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z13'); }, '.xgtOpts [data-a="steal"]']);
      },
      success: 'Steal' },

    { ack: true,
      instruction: 'That is the tracker.\n\n<b>Field zone, what happened, outcome</b> — and the stats build themselves while you watch the game.' }
  ]}
  ];

  if (which === 'goalkeeper') return [
    lessonSetup({ role: 'goalkeeper', roleName: 'Goalkeeper', who: 'goalkeeper' }),
    lessonClock({
      // A goal against is the keeper's own stopping event. On Pro the shot-type
      // step sits between Shot and Goal, so it is optional in the chain and
      // named in the text rather than assumed away.
      goalInstruction: 'Now log the goal: tap <b>Shot</b>, then <b>Goal</b>, and tap roughly where in the net it went.\n\n' +
        'On <b>Pro</b> the tracker asks what kind of shot it was first \u2014 Regular, Skip, Lob or Penalty.',
      goalChain: ['.xgtOpts [data-a="shot"]', '?[data-v="regular"]', '[data-s="goal"]', '.gz[data-p="low_left"]']
    }),
  { title: 'Field zones', steps: [
    { ack: true,
      instruction: 'The core idea of the Game Tracker is simple:\n\n' +
        '<b>Tap the field zone</b> where the event happened, then tap the <b>action</b>, then the <b>outcome</b> — and any follow-up the tracker asks for.\n\n' +
        'Field zone → action → outcome. Every event starts with the field zone; there is no other way in.' },

    // The one reframe this whole tutorial turns on. Said here, done in the next
    // step, and said again in Lesson 4 -- a keeper who reads the field zone as
    // "where my keeper was" records every shot in the same place.
    { ack: true,
      instruction: 'For a goalkeeper, the field zone is <b>where the event starts</b> — for a shot, <b>where the opponent shot from</b>, not where your keeper was standing.' },

    { ack: true,
      instruction: 'The water is divided into <b>field zones</b>: the area right in front of the goal, a ring of zones around it, and the wider areas further out. Anything in the opposite half is the little <b>OPPO</b> area.\n\n' +
        'They are there so you can say exactly <b>where</b> a shot came from — to yourself when you read the stats back, and to anyone else you share them with.',
      highlight: '#xgtZoneLayer' },

    { instruction: 'Tap the <b>field zone</b> right in front of the goal — the semi-circle the ring is around. That is a shot from close range.',
      highlight: '#xgtZoneLayer path[data-zone="z6"]',
      allowZone: 'z6',
      validate: function () { return !!(T.state.draft && T.state.draft.fieldZone === 'z6'); },
      autoComplete: function () { tapZone('z6'); },
      success: 'Logged the zone' },

    { instruction: 'Tapped the wrong place? Close the sheet with the ✕ and nothing is recorded.\n\nDo that now.',
      highlight: '#xgtX',
      allow: '#xgtX',
      validate: function () { return !T.state.draft; },
      autoComplete: function () { click('#xgtX'); },
      success: 'Nothing logged' },

    { instruction: 'Last thing in this lesson. Open the <b>Menu</b>.',
      highlight: '#xgtOptionsBtn',
      allow: '#xgtOptionsBtn',
      validate: function () { return sheetOpen() && !!el('xgtOptEditNums'); },
      autoComplete: function () { click('#xgtOptionsBtn'); } },

    { instruction: 'The field zones have two options in here. You can <b>rename</b> them, if your club numbers them differently — and you can <b>hide</b> them, if you find the numbers distracting. Both are personal to this device.\n\nThen close the menu with the ✕.',
      // Both rows, not just one: a ring around Hide Field Zones alone reads as
      // "Rename is not what we are being told about", which is how it landed on
      // a device -- "there is no amber circle around Rename Field Zones".
      highlight: function () { return spanOf(['#xgtOptEditNums', '#xgtOptZones']); },
      calmRing: true,
      then: '#xgtX',
      thenAfter: 3000,
      allow: '#xgtX',
      validate: function () { return !sheetOpen(); },
      autoComplete: function () { click('#xgtX'); } }
  ]},

  { title: 'Actions and outcomes', steps: [
    { instruction: 'Tap any <b>field zone</b> — the spot the opponent is shooting from.',
      onEnter: mark,
      allowZone: '*',
      validate: function () { return !!(T.state.draft && T.state.draft.fieldZone); },
      autoComplete: function () { tapZone('z3'); } },

    // The attribution row the Field Player tree shows is absent here by design
    // (stepAction() renders it only for singlePlayerMode() && !gk). It used to
    // be explained; MIZE cut that -- describing what is NOT on screen is a note
    // about the build, not something the coach needs.
    { ack: true,
      instruction: 'Look at the header: <b>Opponent action from here</b>.\n\n' +
        'The tracker already knows who did what. A <b>shot</b> is the opponent’s. Everything else in the list is your keeper’s.' },

    { instruction: 'Log a save. Tap <b>Shot</b>, then <b>Blocked / Save</b>, then tap the part of the goal where your keeper stopped it.\n\n' +
        'On <b>Pro</b>, one extra question comes first: what kind of shot it was — Regular, Skip, Lob or Penalty.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['.xgtOpts [data-a="shot"]', '[data-v="regular"]', '[data-s="blocked"]', '.xgtGoal']),
      validate: function () {
        return (T.state.draft && T.state.draft.goalPlacement) ||
               loggedSince(base, { action: 'shot', outcome: 'blocked' });
      },
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z3'); },
                   '.xgtOpts [data-a="shot"]', '?[data-v="regular"]', '[data-s="blocked"]',
                   '.gz[data-p="middle_center"]']);
      },
      success: 'Save logged' },

    { ack: true,
      allow: '#xgtSheet',
      instruction: 'On <b>Pro</b> a save is followed by one more question: did the ball <b>stay in play</b>, or <b>go out</b> for a corner throw.\n\n' +
        'A save does not end the play, and which of those happened is what a rebound count is made of.',
      onLeave: function () { if (T.state.draft) clickThrough('#xgtX'); } },

    // The outcome that keeps save percentage honest, and the reason the keeper
    // tree has no in-cage "blocked by a field player" miss target.
    { ack: true,
      instruction: '<b>Defender Block</b> is its own outcome in that list — a shot one of <i>your own</i> field players stopped, not your keeper. Keeping it separate is what keeps the save percentage honest. (<b>Pro</b>.)' },

    { instruction: 'Now a goal against. Tap a field zone, then <b>Shot</b>, then <b>Goal</b>, and tap where in the net it went.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['.xgtOpts [data-a="shot"]', '[data-v="regular"]', '[data-s="goal"]', '.xgtGoal']),
      validate: logged({ action: 'shot', outcome: 'goal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z4'); },
                   '.xgtOpts [data-a="shot"]', '?[data-v="regular"]', '[data-s="goal"]',
                   '.gz[data-p="low_left"]']);
      },
      success: 'Goal against logged' },

    // Three beats, not two. The map used to be described a whole step AFTER the
    // miss was committed and the map was gone -- "it doesn't make sense at all".
    // Same shape as the Field Player tutorial: reach the map, talk about it
    // while it is on screen, then tap.
    { instruction: 'And a shot that misses. Tap a field zone, then <b>Shot</b>, then <b>Missed</b>.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['.xgtOpts [data-a="shot"]', '[data-v="regular"]', '[data-s="missed"]']),
      validate: function () { return !!(T.state.draft && T.state.draft.outcome === 'missed'); },
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z2'); },
                   '.xgtOpts [data-a="shot"]', '?[data-v="regular"]', '[data-s="missed"]']);
      } },

    { ack: true,
      calmRing: true,
      allow: '#xgtSheet',
      highlight: '.xgtGoal',
      instruction: 'That map is the goal and everything around it — the posts, the crossbar, wide on either side, over the bar, and short into the water.\n\n' +
        'It has no in-goal area for a block by a field player, because for a keeper that is <b>Defender Block</b> instead.' },

    { instruction: 'Now tap where the shot went.',
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['.xgtGoal', '.xgtOpts [data-a="shot"]']),
      validate: logged({ action: 'shot', outcome: 'missed' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z2'); },
                   '.xgtOpts [data-a="shot"]', '?[data-v="regular"]', '[data-s="missed"]',
                   '.gz[data-p="crossbar"]']);
      },
      success: 'Miss logged' },

    { instruction: 'Your keeper’s own actions are in the same list. Log a <b>Steal</b>: tap a field zone, then <b>Steal</b>.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['.xgtOpts [data-a="steal"]', '[data-sr="gk_has_ball"]', '[data-ot="lead"]', '[data-oo="regular"]']),
      validate: logged({ action: 'steal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z13'); }, '.xgtOpts [data-a="steal"]',
                   '?[data-sr="gk_has_ball"]', '?[data-ot="lead"]', '?[data-oo="regular"]']);
      },
      success: 'Steal logged' },

    { ack: true,
      instruction: 'On <b>Pro</b> that steal is followed by <b>what happened to the ball</b> — your keeper has it, a teammate picked it up, the opponent recovered, or it went out.\n\n' +
        'And if your keeper came away with it, the <b>outlet pass</b> opens by itself: what kind (Lead, Dry or Wet) and how it ended (Advantage / Goal, Regular Possession, or Turnover).' },

    { ack: true,
      instruction: 'That outlet pass is recorded as its own event, with its own time — because it is the start of the counter-attack, not a footnote to the steal.' },

    { ack: true,
      instruction: 'The pill at the bottom is your keeper going in and out of the water. Tap it when they get subbed in or out, so that you can log the playing time.',
      highlight: '#xgtPres' },

    { ack: true,
      instruction: 'On <b>Pro</b> this tree also carries the <b>shot types</b>, <b>Defender Block</b>, <b>Outlet Pass</b> as an action of its own, <b>Turnover</b>, and more detailed options for foul outcomes.' }
  ]},

  { title: 'Reading the stats', steps: [
    { instruction: 'You can read the live statistics during the game, without stopping it. Tap <b>Stats</b>.\n\n' +
        'Depending on your screen size you may have to scroll up and down to follow the next steps.',
      highlight: '#xgtStatsBtn',
      allow: '#xgtStatsBtn',
      validate: statsOpen,
      autoComplete: function () { click('#xgtStatsBtn'); } },

    { ack: true,
      calmRing: true,
      highlight: statsTiles,
      onEnter: reveal(statsTiles),
      instruction: 'Shots on goal faced, saves, <b>save percentage</b>, goals allowed, off target, defender blocks, post and crossbar, penalties faced and saved, steals, turnovers, exclusions drawn — and outlets.' },

    // gkTypeTable() is inserted straight after the tiles with no heading of its
    // own, so it cannot be found by heading text the way the others are.
    { ack: true,
      calmRing: true,
      highlight: '#xgtStats .xgtTiles + .xgtCard',
      onEnter: reveal('#xgtStats .xgtTiles + .xgtCard'),
      instruction: 'Under them, the <b>save rate by shot type</b>: how many Regular, Skip, Lob and Penalty attempts were on goal, how many your keeper saved, and how many went off.\n\n' +
        'This is the table that answers "what do they actually beat us with".' },

    { ack: true,
      calmRing: true,
      highlight: statsSection(/shot origin/i),
      onEnter: reveal(statsSection(/shot origin/i)),
      instruction: 'The heat diagram shows <b>where they shot from</b>. The darker the field zone, the more attempts came from there.' },

    { ack: true,
      calmRing: true,
      highlight: statsSection(/goal placement/i),
      onEnter: reveal(statsSection(/goal placement/i)),
      instruction: 'Below that is your <b>own goal</b>, seen from the front, with every shot placed on it.\n\n' +
        'For a shooter this picture shows a habit. For a keeper it shows a hole.' },

    { ack: true,
      calmRing: true,
      highlight: statsSection(/origin/i),
      onEnter: reveal(statsSection(/origin/i)),
      instruction: '<b>Origin → outcome → placement</b> is stored per event, not worked out afterwards.\n\nThat is exactly why the tracker asks you for a field zone every single time.' },

    { ack: true,
      calmRing: true,
      highlight: statsSection(/full log/i),
      onEnter: reveal(statsSection(/full log/i)),
      instruction: 'Under it is the <b>full log</b>. Tap any line to correct or delete it, and <b>+ Add Event</b> for the one you missed.' },

    { instruction: 'Scroll back up to the top, then close the stats with <b>‹ Back</b>.',
      highlight: '#xgtSb',
      onEnter: reveal('#xgtSb'),
      allow: ['#xgtSb', '#xgtStats'],
      validate: function () { return !statsOpen(); },
      autoComplete: function () { click('#xgtSb'); } }
  ]},
    lessonEnding({ extraSteps: shootoutSteps }),
  { title: 'Track it yourself', steps: [
    { ack: true,
      instruction: 'Last part. From here the tutorial stops pointing at buttons — you get told what happened in the game, and you log it.\n\n' +
        'Three moments, one at a time. If you get stuck, wait a few seconds and a hint appears.' },

    { instruction: 'Now try it yourself. The opponent shoots, and your keeper <b>saves</b> it.',
      onEnter: function () { mark(); practice = { done: [] }; },
      allowZone: '*',
      allow: ['#xgtSheet', '#xgtUn'],
      hints: [
        'Start with the <b>field zone</b> — and for a shot, that is where the <b>opponent shot from</b>.',
        'Then <b>Shot</b>. On Pro you say what kind of shot it was first.',
        'Then <b>Blocked / Save</b>, and where in the goal your keeper stopped it.'
      ],
      misstep: function () {
        var e = stray(base, { action: 'shot', outcome: 'blocked' });
        if (!e) return null;
        return 'That logged a <b>' + nameOf(e) + '</b>. Tap <b>↩</b> at the bottom to undo it, then log the save.';
      },
      validate: logged({ action: 'shot', outcome: 'blocked' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z2'); }, '.xgtOpts [data-a="shot"]',
                   '?[data-v="regular"]', '[data-s="blocked"]', '.gz[data-p="top_left"]', '?[data-br="gk_in"]']);
      },
      success: 'Saved' },

    { instruction: 'This time the opponent <b>scores</b>.',
      onEnter: mark,
      allowZone: '*',
      allow: ['#xgtSheet', '#xgtUn'],
      hints: [
        'Field zone first — wherever the shot came from.',
        'Then <b>Shot</b>, then <b>Goal</b>, then where in the net it went.'
      ],
      misstep: function () {
        var e = stray(base, { action: 'shot', outcome: 'goal' });
        if (!e) return null;
        return 'That logged a <b>' + nameOf(e) + '</b>. Tap <b>↩</b> at the bottom to undo it, then log the goal.';
      },
      validate: logged({ action: 'shot', outcome: 'goal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z5'); }, '.xgtOpts [data-a="shot"]',
                   '?[data-v="regular"]', '[data-s="goal"]', '.gz[data-p="low_right"]']);
      },
      success: 'Goal against' },

    { instruction: 'Your keeper <b>steals the ball</b> — anywhere on the field you like.',
      onEnter: mark,
      allowZone: '*',
      allow: ['#xgtSheet', '#xgtUn'],
      hints: [
        'Tap any <b>field zone</b> first.',
        '<b>Steal</b> is one tap. On Pro you are then asked what became of the ball — and an outlet pass may follow.'
      ],
      misstep: function () {
        var e = stray(base, { action: 'steal' });
        if (!e) return null;
        return 'That logged a <b>' + nameOf(e) + '</b>. Tap <b>↩</b> at the bottom to undo it, then log a steal.';
      },
      validate: logged({ action: 'steal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z13'); }, '.xgtOpts [data-a="steal"]',
                   '?[data-sr="gk_has_ball"]', '?[data-ot="lead"]', '?[data-oo="regular"]']);
      },
      success: 'Steal' },

    { ack: true,
      instruction: 'That is the tracker, from your keeper’s end.\n\n<b>Where the shot came from, what happened, outcome</b> — and the save percentage builds itself while you watch the game.' }
  ]}
  ];

  /* ===================================================================== */
  /* C · YOUR TEAM  and  D · THE WHOLE GAME                                */
  /*                                                                       */
  /* One tutorial with one difference, and the difference is real enough   */
  /* to be its own banner on Home: D tracks the opposing squad too. That   */
  /* changes the setup (a second roster), the Who screen (their numbers    */
  /* instead of one Opponent button), the roster bar (two columns), and    */
  /* the stats panel (a side switcher). Everything else is identical, so   */
  /* the lessons are built from one function with an `opp` flag rather     */
  /* than written twice and drifting apart.                                */
  /*                                                                       */
  /* What team mode changes about the recording flow is ONE extra step:    */
  /*   field zone -> WHO -> action -> outcome.                             */
  /* And squad tracking is coach + team and nothing else -- which is why   */
  /* Lesson 1 says so in the words a team parent needs to hear.            */
  /*                                                                       */
  /* Two things the team stats panel genuinely does not have, so no step   */
  /* claims them: a full log, and any way to correct an event. Both are    */
  /* single-player only (openStats' other branch). Flagged to MIZE rather  */
  /* than papered over.                                                    */
  /* ===================================================================== */
  function teamLessons(opp) {
    var them = opp ? 'their number' : 'the opponent';
    return [
    lessonSetup({ role: 'team', mode: 'coach', roleName: 'Team', who: 'player',
                  squad: true, opponent: opp }),
    lessonClock({
      goalInstruction: 'Now log the goal. First <b>who</b> — tap <b>#7</b> under your own team — then <b>Shot</b>, then <b>Goal</b>, and tap roughly where in the net it went.\n\n' +
        'On <b>Pro</b> you are then offered the <b>assist</b>, or you can skip it.',
      goalChain: ['[data-us-n="7"]', '.xgtOpts [data-a="shot"]', '[data-s="goal"]',
                  '.gz[data-p="low_left"]', '?#xgtAssistSkip']
    }),

  { title: 'Field zones', steps: [
    { ack: true,
      instruction: 'The core idea of the Game Tracker is simple, and in team mode it has one extra beat:\n\n' +
        '<b>Tap the field zone</b> where it happened, tap <b>who</b> did it, then the <b>action</b>, then the <b>outcome</b>.\n\n' +
        'Field zone → who → action → outcome. Every event starts with the field zone; there is no other way in.' },

    { ack: true,
      instruction: 'The water is divided into <b>field zones</b>: the area right in front of the goal, a ring of zones around it, and the wider areas further out. Anything in the opposite half is the little <b>OPPO</b> area.\n\n' +
        'They are there so you can say exactly <b>where</b> something happened — to yourself when you read the stats back, and to anyone else you share them with.',
      highlight: '#xgtZoneLayer' },

    { instruction: 'Tap the <b>field zone</b> right in front of the goal — the semi-circle the ring is around.',
      highlight: '#xgtZoneLayer path[data-zone="z6"]',
      allowZone: 'z6',
      validate: function () { return !!(T.state.draft && T.state.draft.fieldZone === 'z6'); },
      autoComplete: function () { tapZone('z6'); },
      success: 'Logged the zone' },

    { instruction: 'Tapped the wrong place? Close the sheet with the ✕ and nothing is recorded.\n\nDo that now.',
      highlight: '#xgtX',
      allow: '#xgtX',
      validate: function () { return !T.state.draft; },
      autoComplete: function () { click('#xgtX'); },
      success: 'Nothing logged' },

    { instruction: 'Last thing in this lesson. Open the <b>Menu</b>.',
      highlight: '#xgtOptionsBtn',
      allow: '#xgtOptionsBtn',
      validate: function () { return sheetOpen() && !!el('xgtOptEditNums'); },
      autoComplete: function () { click('#xgtOptionsBtn'); } },

    { instruction: 'The field zones have two options in here. You can <b>rename</b> them, if your club numbers them differently — and you can <b>hide</b> them, if you find the numbers distracting. Both are personal to this device, not a team setting.\n\nThen close the menu with the ✕.',
      highlight: function () { return spanOf(['#xgtOptEditNums', '#xgtOptZones']); },
      calmRing: true,
      then: '#xgtX',
      thenAfter: 3000,
      allow: '#xgtX',
      validate: function () { return !sheetOpen(); },
      autoComplete: function () { click('#xgtX'); } }
  ]},

  { title: 'Who, and what they did', steps: [
    { instruction: 'Tap any <b>field zone</b> to open a new event.',
      onEnter: mark,
      allowZone: '*',
      validate: function () { return !!(T.state.draft && T.state.draft.fieldZone); },
      autoComplete: function () { tapZone('z3'); } },

    // The screen that IS team mode. stepPlayer() lists water rosters only --
    // worth saying, because a coach looking for a benched number and not
    // finding it will otherwise assume the tracker lost them.
    { ack: true,
      allow: '#xgtSheet',
      instruction: 'This screen is the whole difference. <b>Who?</b>\n\n' +
        'Your own numbers are at the top, ' + (opp ? 'theirs underneath' : 'and the other team underneath') + '. Only the players <b>in the water right now</b> are listed — the bench is not an option, because a player on the bench cannot have done it.' },

    { ack: true,
      allow: '#xgtSheet',
      instruction: opp
        ? 'Because you are tracking both squads, an opponent action gets <b>their cap number</b> too. That is what turns "a shot from the left" into "#4 shoots from the left, again".'
        : 'You are not tracking their squad in this tutorial, so the other team is <b>one button</b>. The action is recorded as theirs, without a number — which is all you need for a shot your keeper faced.' },

    { instruction: 'Log a goal by your own <b>#7</b>: tap <b>#7</b>, then <b>Shot</b>, then <b>Goal</b>, then where in the net it went.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['[data-us-n="7"]', '.xgtOpts [data-a="shot"]', '[data-s="goal"]', '.xgtGoal']),
      validate: logged({ action: 'shot', outcome: 'goal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z3'); }, '[data-us-n="7"]',
                   '.xgtOpts [data-a="shot"]', '[data-s="goal"]', '.gz[data-p="low_left"]',
                   '?#xgtAssistSkip']);
      },
      success: 'Goal logged' },

    { ack: true,
      instruction: 'On <b>Pro</b> a goal is followed by <b>who assisted</b> — the same water roster again, with <b>No assist / skip</b> for the times nobody did.' },

    // The one thing about fouls a coach gets wrong: the player you tapped is
    // always the one who COMMITTED it. stepOutcome() sets dc='committed' on any
    // exclusion outcome; there is no drawn/committed choice on this screen.
    { instruction: 'Now a foul. Tap a field zone, tap the player who <b>committed</b> it, then <b>Personal Foul</b>, then <b>Exclusion (20 s)</b>.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      // Penalty stays visible and inert, exactly as in A: choosing it launches
      // the penalty-shot flow, which is somewhere this lesson has not prepared
      // anyone for. The next step explains it instead.
      deny: ['[data-s="penalty"]'],
      highlight: firstVisible(['[data-us-n="3"]', '.xgtOpts [data-a="exclusion"]', '[data-s="exclusion"]', '#xgtFoulSkip']),
      validate: logged({ action: 'exclusion' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z2'); }, '[data-us-n="3"]',
                   '.xgtOpts [data-a="exclusion"]', '[data-s="exclusion"]', '?#xgtFoulSkip']);
      },
      success: 'Foul logged' },

    { ack: true,
      instruction: 'The player you tapped always <b>committed</b> the foul — there is no drawn-or-committed choice on that screen.\n\n' +
        'On <b>Pro</b>, the tracker then asks <b>who drew it</b>, from the other team’s water roster, with <b>Unknown / skip</b>. That is how one tap becomes both an exclusion given and an exclusion drawn.' },

    { ack: true,
      instruction: '<b>Penalty (5 m)</b> is in that same list, and it is worth knowing what it does before you tap it: choosing it opens the penalty shot straight away and asks who is taking it. It belongs to tracking a real game, not to this lesson.' },

    { instruction: 'One more. <b>Steal</b> is a single tap after the player — no outcome to choose.\n\nLog one: field zone, a player, then <b>Steal</b>.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      highlight: firstVisible(['[data-us-n="5"]', '.xgtOpts [data-a="steal"]']),
      validate: logged({ action: 'steal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z13'); }, '[data-us-n="5"]',
                   '.xgtOpts [data-a="steal"]']);
      },
      success: 'Steal logged' },

    { ack: true,
      instruction: 'On <b>Pro</b> the action list also carries <b>Turnover</b> — offensive foul, offensive exclusion, pass intercepted, shot clock expired — plus <b>Excl. + Substitution</b> and <b>Brutality</b> as foul outcomes, and the follow-up questions that go with a blocked shot.' },

    // The roster bar rides in this lesson rather than getting one of its own.
    // Seven lessons is the shape all four tutorials share, and the bar is not a
    // subject -- it is the other half of "who did it".
    { ack: true,
      calmRing: true,
      highlight: '#xgtBar',
      instruction: 'Along the bottom is the <b>roster bar</b>' + (opp ? ' — your squad on one side, theirs on the other, with the Menu and Stats between them.' : ', with the Menu and Stats beside it.') + '\n\n' +
        'The header on each side counts who is in the water: <b>' + (opp ? '5/7' : '7/7') + '</b>.' },

    { ack: true,
      calmRing: true,
      highlight: '#xgtBar',
      instruction: 'Read the chips: <b>filled green</b> means in the water right now, a <b>red outline</b> marks a goalkeeper, and a <b>teal badge</b> counts that player’s goals while a <b>red badge</b> counts fouls they have committed.\n\n' +
        'That is the live scoreboard for every player, without opening anything.' },

    // The rescue is structural, not timed -- xgtUndoAccidentalResub walks back
    // through presence events and only gives up if a DIFFERENT player has gone
    // in since. Saying "straight back" would be wrong: it covers a flying
    // substitution with minutes in between.
    { instruction: 'Substitutions are roster taps, not field events. <b>Tap a green chip</b> to take that player out.',
      onEnter: function () { base = evts().length; },
      allow: '#xgtBar',
      highlight: '#xgtBar .xgtChip.water',
      validate: function () { return T.state.water.length < 7; },
      autoComplete: function () {
        var c = q('#xgtBar .xgtChip.water:not(.goalie)') || q('#xgtBar .xgtChip.water');
        if (c) clickThrough('#xgtBar .xgtChip[data-n="' + c.getAttribute('data-n') + '"][data-side="us"]');
      },
      success: 'Out of the water' },

    { instruction: 'Now tap that <b>same player</b> again to put them back.',
      allow: '#xgtBar',
      highlight: function () {
        var w = T.state.squad.filter(function (n) { return T.state.water.indexOf(n) < 0; });
        return w.length ? q('#xgtBar .xgtChip[data-n="' + w[0] + '"][data-side="us"]') : null;
      },
      validate: function () { return T.state.water.length >= 7; },
      autoComplete: function () {
        var w = T.state.squad.filter(function (n) { return T.state.water.indexOf(n) < 0; });
        if (w.length) clickThrough('#xgtBar .xgtChip[data-n="' + w[0] + '"][data-side="us"]');
      },
      success: 'Back in' },

    { ack: true,
      instruction: 'Notice what the tracker said: it recognised that as a <b>mis-tap</b> and <b>removed the sub-out</b> rather than recording a player going out and back in.\n\n' +
        'It is not a stopwatch — it works as long as no other player has gone in since, so it covers a flying substitution too.' },

    { ack: true,
      instruction: 'Two more things the bar does on its own. <b>Seven is the limit</b> — an eighth tap is refused and tells you to sub someone out first.\n\n' +
        'And <b>three exclusions disqualifies</b> a player: the tracker takes them out of the water, greys the chip out so it cannot be tapped again, and marks it. <b>S</b> for exclusion with substitution, <b>X</b> for brutality, <b>R</b> for a red card.' }
  ]},

  { title: 'Reading the stats', steps: [
    { instruction: 'You can read the live statistics during the game, without stopping it. Tap <b>Stats</b>.\n\n' +
        'Depending on your screen size you may have to scroll up and down to follow the next steps.',
      highlight: '#xgtStatsBtn',
      allow: '#xgtStatsBtn',
      validate: statsOpen,
      autoComplete: function () { click('#xgtStatsBtn'); } },

    { ack: true,
      calmRing: true,
      highlight: statsTiles,
      onEnter: reveal(statsTiles),
      instruction: 'The <b>team’s</b> totals first: goals, shots, shooting percentage, exclusions drawn and given, steals, turnovers and assists.' }

  ].concat(opp ? [

    { ack: true,
      calmRing: true,
      highlight: '#xgtStatsSide',
      onEnter: reveal('#xgtStatsSide'),
      instruction: 'And because you are tracking both squads, there is a <b>switch at the top</b>: the same panel, for either team. Everything below it follows whichever side is selected.' }

  ] : []).concat([

    { ack: true,
      calmRing: true,
      highlight: statsSection(/shots came from/i),
      onEnter: reveal(statsSection(/shots came from/i)),
      instruction: 'The heat diagram shows <b>where your shots came from</b>. The darker the field zone, the more attempts started there.' },

    { ack: true,
      calmRing: true,
      highlight: statsSection(/shooting/i),
      onEnter: reveal(statsSection(/shooting/i)),
      instruction: 'Then <b>their goal</b>, with every shot your team took placed on it — and under that <b>your own goal</b>, with every shot you faced.\n\n' +
        'Two pictures of the same game from both ends, which is something no single-player mode can show you.' },

    { instruction: 'Under those, every player as a tile — cap number, goals, fouls. <b>Tap one</b> to open that player’s own statistics.',
      highlight: '#xgtStats .xgtPlayerTiles',
      onEnter: reveal('#xgtStats .xgtPlayerTiles'),
      allow: ['#xgtStats', '#xgtSb'],
      // openPlayerStats() replaces the whole panel, so the player grid being
      // gone while the panel is still open is the signal that one was opened.
      validate: function () { return statsOpen() && !q('#xgtStats .xgtPlayerTiles'); },
      autoComplete: function () { click('#xgtStats [data-player-n]'); },
      success: 'That player’s game' },

    { ack: true,
      calmRing: true,
      highlight: statsTiles,
      onEnter: reveal(statsTiles),
      instruction: 'One player, the same shape as the whole team — and a <b>goalkeeper</b> opens with a keeper’s numbers instead: shots faced, saves, <b>save percentage</b>, and the save rate by shot type.\n\n' +
        'That is the goalkeeper’s game, from a session where you never once tracked a keeper.' },

    { instruction: 'Scroll back up and tap <b>‹ Back</b> — once for the team, once more to close the statistics.',
      highlight: '#xgtSb',
      onEnter: reveal('#xgtSb'),
      allow: ['#xgtSb', '#xgtStats'],
      validate: function () { return !statsOpen(); },
      autoComplete: function () {
        chainFrom(['#xgtSb', '?#xgtSb']);
      } }

  ])},
    lessonEnding({ extraSteps: teamShootoutSteps }),
  { title: 'Track it yourself', steps: [
    { ack: true,
      instruction: 'Last part. From here the tutorial stops pointing at buttons — you get told what happened in the game, and you log it.\n\n' +
        'Three moments, one at a time. If you get stuck, wait a few seconds and a hint appears.' },

    { instruction: 'Now try it yourself. <b>Your #4 scores</b>.',
      onEnter: function () { mark(); practice = { done: [] }; },
      allowZone: '*',
      allow: ['#xgtSheet', '#xgtUn'],
      hints: [
        'Start with the <b>field zone</b> — wherever the shot came from.',
        'Then <b>who</b>: #4, under your own team.',
        'Then <b>Shot</b>, then <b>Goal</b>, and where in the net it went.'
      ],
      misstep: function () {
        var e = stray(base, { action: 'shot', outcome: 'goal' });
        if (!e) return null;
        return 'That logged a <b>' + nameOf(e) + '</b>. Tap <b>↩</b> at the bottom to undo it, then log the goal.';
      },
      validate: logged({ action: 'shot', outcome: 'goal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z4'); }, '[data-us-n="4"]',
                   '.xgtOpts [data-a="shot"]', '[data-s="goal"]', '.gz[data-p="top_right"]',
                   '?#xgtAssistSkip']);
      },
      success: 'Goal' },

    { instruction: 'Now the other way: <b>' + (opp ? 'their #6' : 'the other team') + ' scores</b>.',
      onEnter: mark,
      allowZone: '*',
      allow: ['#xgtSheet', '#xgtUn'],
      hints: [
        'Field zone first — where <b>they</b> shot from.',
        opp ? 'Then their <b>#6</b>, in the lower group.'
            : 'Then the <b>opponent</b> button under your own numbers.',
        // The assist step fires for ANY goal, either side -- stepAssist() gates
        // on the outcome, not on who scored. Leaving it out of the ladder was
        // what stranded this step: the sheet sat open on "Who assisted?" and
        // nothing after it could run.
        'Then <b>Shot</b>, then <b>Goal</b> — and on Pro, <b>No assist / skip</b> to finish it.'
      ],
      validate: function () {
        if (T.state.draft) return false;
        var a = actions();
        for (var i = base; i < a.length; i++) {
          var e = a[i];
          if (e.action === 'shot' && e.outcome === 'goal' && e.actor && e.actor.side === 'opp') return true;
        }
        return false;
      },
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z2'); },
                   opp ? '[data-opp-n="6"]' : '#xgtOpp',
                   '.xgtOpts [data-a="shot"]', '[data-s="goal"]', '.gz[data-p="low_left"]',
                   '?#xgtAssistSkip']);
      },
      success: 'Goal against' },

    { instruction: 'And one <b>steal</b>, by any of your own players.',
      onEnter: mark,
      allowZone: '*',
      allow: ['#xgtSheet', '#xgtUn'],
      hints: [
        'Field zone, then <b>who</b>, then <b>Steal</b>.',
        'Steal has no outcome to choose — it commits on that one tap.'
      ],
      misstep: function () {
        var e = stray(base, { action: 'steal' });
        if (!e) return null;
        return 'That logged a <b>' + nameOf(e) + '</b>. Tap <b>↩</b> at the bottom to undo it, then log a steal.';
      },
      validate: logged({ action: 'steal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z12'); }, '[data-us-n="2"]',
                   '.xgtOpts [data-a="steal"]']);
      },
      success: 'Steal' },

    { ack: true,
      instruction: 'That is the tracker, for a whole squad.\n\n<b>Where, who, what, outcome</b> — and every player’s game, ' + (opp ? 'on both teams, ' : '') + 'builds itself while you watch.' }
  ]}
  ];
  }

  if (which === 'team') return teamLessons(false);
  if (which === 'fullgame') return teamLessons(true);

  throw new Error('Only the Field Player, Goalkeeper, Your Team and Whole Game tutorials are built');
}

/* ------------------------------------------------------------------- api */
var API = {
  start: start,
  exit: stop,
  isRunning: function () { return running; },
  // Introspection for the test harness -- deliberately read-only.
  lessonTitles: function () { return lessonTitles.slice(); },
  lessonStarts: function () { return lessonStarts.slice(); },
  stepCount: function () { return steps.length; },
  stepIndex: function () { return idx; },
  // Harness introspection: proves every interactive step leaves the coach
  // something to touch. A step with no ack button and no allowed target would
  // be a dead end reachable only through "Next step".
  stepInfo: function (i) {
    var s = steps[i];
    if (!s) return null;
    return { ack: !!(s.ack || s.auto), lesson: s._lessonTitle,
             // `gesture` steps are finished by dragging, not tapping -- the
             // click guard never sees them, so "nothing is allowed" is correct
             // for them rather than a dead end.
             hasTarget: !!(s.allow || s.allowZone || s.auto || s.gesture || typeof s.highlight === 'string') };
  },
  goToStep: function (i) { if (running) goTo(i); },
  // The difference matters: goToStep moves the pointer, goToLesson rebuilds the
  // screen first. Anything a person can press goes through goToLesson.
  goToLesson: goToLesson,
  next: nextStep
};

function boot() {
  window.XquiXGameTrackerTutorial = API;
  if (window.MIZE) window.MIZE.GameTrackerTutorial = API;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
