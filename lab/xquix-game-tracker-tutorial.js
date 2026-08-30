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

/* ------------------------------------------------------------------- css */
var CSS = [
'#xgtuBox{position:fixed;left:12px;width:min(370px,calc(100vw - 24px));',
'  z-index:' + Z_BOX + ';background:#0d2422;border:1px solid #2a5f5c;border-radius:14px;',
'  padding:13px 15px;box-shadow:0 10px 30px rgba(0,0,0,.45);color:#eaf6f5;',
'  font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;pointer-events:auto;}',
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

/* Brings the thing being talked about into view. The stats panel is taller than
   any phone, so a ring on a section below the fold is a ring nobody sees. */
function reveal(fn) {
  return function () {
    var e = typeof fn === 'function' ? fn() : q(fn);
    if (e && e.scrollIntoView) { try { e.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { e.scrollIntoView(); } }
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
  positionChrome();
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
    '<div id="xgtuText"></div>' +
    '<div id="xgtuHint" style="display:none"></div>' +
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
  positionChrome();
  window.addEventListener('resize', positionChrome);
}

/* Sits below the tracker's own top pane so the clock and score stay visible --
   deliberately NOT at the bottom, where the action sheet slides up and this
   box (being higher in the stack) would cover the very buttons it is asking
   the coach to tap. */
function positionChrome() {
  var box = el('xgtuBox'); if (!box) return;
  var top = el('xgtTop');
  var y = top ? Math.round(top.getBoundingClientRect().bottom) + 8 : 12;
  box.style.top = y + 'px';
  var flash = el('xgtuFlash');
  if (flash) flash.style.top = (y + box.offsetHeight + 14) + 'px';
}

function removeChrome() {
  window.removeEventListener('resize', positionChrome);
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
  var r = target.getBoundingClientRect();
  if (!r.width && !r.height) { ring.style.display = 'none'; return; }
  ring.style.display = 'block';
  // Above the instruction box only when the thing being ringed is inside it,
  // so a ring around a tracker control never draws over the instructions.
  var box = el('xgtuBox');
  ring.style.zIndex = (box && box.contains(target)) ? (Z_BOX + 2) : Z_RING;
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
  el('xgtuAck').style.display = s.ack ? '' : 'none';
  el('xgtuNext').style.display = s.ack ? 'none' : '';
  if (s.onEnter) { try { s.onEnter(); } catch (err) { console.error('XquiX tutorial: onEnter threw', err); } }
  restartHints();
  positionChrome();
}

/* A step's instruction, rewritten after onEnter has worked something out that
   only exists at runtime -- the exact clock time L2 is asking for, above all,
   so the coach can check the number they dialled in against the one they were
   asked for instead of counting taps and hoping. */
function setText(html) {
  var t = el('xgtuText');
  if (t) { t.innerHTML = html; positionChrome(); }
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
    goTo(lessonStarts[v]);
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
/* A · FIELD PLAYER                                                        */
/* Tracking one specific field player. The setup screen's Parent / Coach   */
/* switch does not change this flow at all -- singlePlayerMode() is true   */
/* for every combination except Coach + Team -- so the tutorial says that  */
/* once and moves on.                                                      */
/*                                                                         */
/* Every required action is Shot, Personal Foul or Steal: the three the    */
/* Basic tier has. No step counts buttons or names positions, because a    */
/* Pro user sees a longer action list than a Basic one.                    */
/* ======================================================================= */function buildLessons(which) {
  if (which !== 'field') throw new Error('Only the Field Player tutorial is built yet');
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
  var scrollStrip = function () {
    var r = document.getElementById('fcScrollZoneRight');
    if (r && r.style.display === 'block') return r;
    var l = document.getElementById('fcScrollZoneLeft');
    return (l && l.style.display === 'block') ? l : null;
  };

  return [
  { title: 'Set up a session', steps: [
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
    { instruction: 'Watch — the top of the setup fills itself in, one thing at a time.\n\n' +
        '<b>Who is tracking</b> is only a label on the record. <b>Tracking role</b> is the one that decides what you tap during the game — and this tutorial is the <b>Field Player</b> one.\n\n' +
        'Then the game itself. Worth entering for real: these names replace <b>Us</b> and <b>Them</b> on every button and in every export.',
      auto: true,
      onEnter: function () {
        demoDone = false;
        autoTap('#xgtTm [data-tm="parent"]', function () {
          autoTap('#xgtRl [data-role="field"]', function () {
            autoType('#xgtLoc', 'WP City', function () {
              autoType('#xgtAway', 'Black Octopus', function () { ringOverride = null; demoDone = true; });
            });
          });
        });
      },
      validate: function () { return demoDone; },
      autoComplete: function () {
        ringOverride = null;
        // Skipping the demo must still leave the role set -- every lesson after
        // this one is the field-player flow.
        if (T.state.playerRole !== 'field') clickThrough('#xgtRl [data-role="field"]');
        demoDone = true;
      } },

    { instruction: 'Your turn. <b>Tap the field</b>, type <b>your own team’s name</b>, then press <b>Enter</b> to confirm it.',
      highlight: '#xgtHome',
      allow: '#xgtHome',
      commit: '#xgtHome',
      validate: function () { return inputCommitted && !!fieldValue('#xgtHome'); },
      autoComplete: function () { autoType('#xgtHome', 'WP City Waves', function () {}); } },

    { instruction: '<b>Tap the next field</b> and enter the <b>cap number</b> of the player you are tracking, then <b>Enter</b> to confirm.',
      highlight: '#xgtNum',
      allow: '#xgtNum',
      commit: '#xgtNum',
      validate: function () { return inputCommitted && !!fieldValue('#xgtNum'); },
      autoComplete: function () { autoType('#xgtNum', '7', function () {}); } },

    { instruction: 'Tap <b>Start tracking</b>.',
      highlight: '#xgtGo',
      allow: '#xgtGo',
      // NOT #xgtPres: the bar renders as soon as the tracker opens, so that was
      // already true before this button was pressed -- which is why the tutorial
      // once jumped to lesson 2 on its own. go() closes the setup sheet and
      // commits the cap number, so those two together are the real signal.
      validate: function () { return !sheetOpen() && T.state.me.number != null; },
      autoComplete: function () { click('#xgtGo'); },
      success: 'Tracking' },

    // The two sideline strips are Studio's own drag-to-scroll zones, and the
    // tracker's shield cuts a hole in itself for exactly this (positionShield's
    // clip-path). Without being told, nobody finds them -- they are 2m wide and
    // look like part of the deck.
    { instruction: 'You are looking at the attacking half. The pool carries on past the top of the screen.\n\n' +
        'To move up and down it, <b>drag on the narrow strip along either sideline</b> — the far left or far right edge of the water. The middle is for tapping field zones, so the scrolling lives at the edges.\n\n' +
        'Try it now.',
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
        if (w) w.scrollTop = w.scrollTop + Math.min(120, Math.max(20, w.scrollHeight - w.clientHeight));
      },
      success: 'That is the pool' }
  ]},

  { title: 'The clock', steps: [
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

    { instruction: 'Now log a <b>Shot</b> by tapping that button, then log a <b>Goal</b> with the button that appears next, and tap roughly where in the net it went.\n\n' +
        'On <b>Pro</b> you then get the chance to log the <b>assist giver</b> — or to skip that step.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      validate: logged({ action: 'shot', outcome: 'goal' }),
      autoComplete: function () {
        chainFrom([function () { if (!sheetOpen()) tapZone('z3'); },
                   '.xgtOpts [data-a="shot"]', '[data-s="goal"]', '.gz[data-p="low_left"]', '?#xgtAssistSkip']);
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
          'Say the official pool clock is <b>11 seconds behind</b> yours. You would take 11 seconds off here — which is the next step.\n\n' +
          'Events you have already logged keep their own timestamps; this only moves the clock.');
      } },

    { instruction: '',   // written by onEnter, which knows the real target time
      onEnter: function () {
        clockTarget = Math.max(0, T.state.clock - 11);
        setText('Tap <b>−0:10</b>, then <b>−0:01</b>, then <b>Done</b>.\n\n' +
          'You are aiming for <b>' + mmss(clockTarget) + '</b> — check the display against that before you tap Done.');
      },
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
  ]},

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
      highlight: '#xgtOptZones',
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

  { title: 'Ending the game', steps: [
    { ack: true,
      instruction: 'Four quarters — and you change quarter from the same time sheet you used earlier, on the <b>quarter button</b> at the top left.',
      highlight: '#xgtQ' },

    { ack: true,
      instruction: 'When the clock hits 0:00 in Q4, regulation ends by itself and the field stops taking taps — there is no meaningful "where on the field" once it is over.' },

    { ack: true,
      instruction: 'But since there is the chance that misconducts happen after the buzzer, certain options stay available: <b>Menu → Log Post-Game Foul</b> appears at that point, and only then.',
      highlight: '#xgtOptionsBtn' },

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
  ]},

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
  next: nextStep
};

function boot() {
  window.XquiXGameTrackerTutorial = API;
  if (window.MIZE) window.MIZE.GameTrackerTutorial = API;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
