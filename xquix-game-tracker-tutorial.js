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
'@keyframes xgtuPulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.55;transform:scale(1.04);}}',
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
var allowedNow = null;   // { sels: [..], zone: 'z3' | '*' | null }

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

function interactionGuard(e) {
  if (!running) return;
  if (clickAllowed(e)) return;
  e.stopPropagation();
  e.preventDefault();
  nudgeRing();
}

function nudgeRing() {
  var r = el('xgtuRing');
  if (!r || r.style.display === 'none') return;
  r.classList.remove('nudge');
  void r.offsetWidth;                                     // restart the animation
  r.classList.add('nudge');
}

/* A step is finished the moment the field is committed -- Enter, Tab, or moving
   away from it -- rather than on the first keystroke, which would advance on the
   '1' of '17'. */
var inputCommitted = false;
function armCommit(sel) {
  var e = q(sel);
  if (!e) return;
  var fire = function () { if ((e.value || '').trim()) inputCommitted = true; };
  e.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === 'Tab') setTimeout(fire, 0);
  });
  e.addEventListener('blur', fire);
  e.addEventListener('change', fire);
}
function fieldValue(sel) { var e = q(sel); return e ? (e.value || '').trim() : ''; }

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
function paintRing() {
  var ring = el('xgtuRing'); if (!ring) return;
  var s = step();
  var target = s && s.highlight ? (typeof s.highlight === 'function' ? s.highlight() : q(s.highlight)) : null;
  if (!target) { ring.style.display = 'none'; return; }
  var r = target.getBoundingClientRect();
  if (!r.width && !r.height) { ring.style.display = 'none'; return; }
  ring.style.display = 'block';
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
  var s = steps[idx];

  // What the coach may touch on this step, and nothing else.
  var sels = s.allow ? (typeof s.allow === 'string' ? [s.allow] : s.allow.slice()) : [];
  if (!sels.length && typeof s.highlight === 'string') sels.push(s.highlight);
  allowedNow = { sels: sels, zone: s.allowZone || null };
  inputCommitted = false;
  if (s.commit) setTimeout(function () { armCommit(s.commit); }, 0);

  el('xgtuLesson').textContent = s._lessonTitle + '  ·  step ' + (s._nInLesson) + ' of ' + s._ofLesson;
  el('xgtuText').innerHTML = s.instruction;
  el('xgtuAck').style.display = s.ack ? '' : 'none';
  el('xgtuNext').style.display = s.ack ? 'none' : '';
  if (s.onEnter) { try { s.onEnter(); } catch (err) { console.error('XquiX tutorial: onEnter threw', err); } }
  positionChrome();
}

function succeed() {
  if (!running || advancing) return;
  advancing = true;
  var s = step();
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
  if (!s || s.ack || advancing || !s.validate) return;
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
    // Fall through only if we are STILL on the step this was pressed for.
    // Without the idx check, a fallback armed for one step fires after normal
    // validation has already advanced, and silently skips the next step --
    // which is exactly how several action steps appeared to pass while
    // recording nothing at all.
    setTimeout(function () {
      if (idx === from && !advancing) succeed();
    }, 1800);
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
  h.textContent = complete ? 'Tutorial complete' : 'Leave the tutorial?';
  dlg.appendChild(h);

  var p = make('div');
  p.textContent = complete
    ? 'You have tracked a full game end to end. Nothing you did here was saved — your own games are untouched.'
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
  ls.forEach(function (lesson) {
    lessonStarts.push(steps.length);
    lessonTitles.push(lesson.title);
    lesson.steps.forEach(function (s, i) {
      s._lessonTitle = lesson.title;
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
  goTo(0);
  rafHandle = requestAnimationFrame(tick);
  return true;
}

function stop() {
  if (!running) return;
  running = false;
  allowedNow = null;
  window.removeEventListener('click', interactionGuard, true);
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  removeChrome();
  idx = -1;
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
/* ======================================================================= */
function buildLessons(which) {
  if (which !== 'field') throw new Error('Only the Field Player tutorial is built yet');
  var base = 0;   // action-count baseline, reset per step that needs one
  var mark = function () { base = actions().length; };

  return [
  { title: 'Set up a session', steps: [
    { ack: true,
      instruction: 'Welcome to the <b>Game Tracker</b>.\n\n' +
        'In about ten minutes you will have tracked a full game — every shot, foul and steal, with the stats building themselves as you go.\n\n' +
        'You will do it on the real thing, not a demo. Watch for the <b>pulsing red ring</b>: it marks what to tap next, and only that will respond.' },

    { instruction: 'This is the start screen. <b>Resume</b> comes back to a game you left; a session survives closing the app.\n\nTap <b>Start a new game</b>.',
      highlight: '#xgtFresh',
      allow: '#xgtFresh',
      validate: function () { return sheetOpen() && !!el('xgtGo'); },
      autoComplete: function () { click('#xgtFresh'); } },

    { instruction: 'Two switches at the top.\n\n<b>Tracking role</b> is the one that matters — it decides what you tap during the game. Choose <b>Field Player</b>.\n\n' +
        '<b>Who is tracking</b> is only a label on the record. A parent and a coach following one player use an identical tracker.',
      highlight: '#xgtRl',
      allow: '#xgtRl',
      validate: function () { return T.state.playerRole === 'field'; },
      autoComplete: function () { click('#xgtRl [data-role="field"]'); },
      success: 'Field Player' },

    { instruction: 'Type your team’s name. Worth the four seconds: it replaces <b>Us</b> and <b>Them</b> on every button and in every export.\n\n' +
        '<b>Track game score</b> below is off by default — the score is worked out from your events either way, this only decides whether it sits on screen.',
      highlight: '#xgtHome',
      allow: '#xgtHome',
      commit: '#xgtHome',
      // Commits on Enter, Tab or moving away -- not on the first keystroke,
      // which would advance mid-word. S.game is only read on the tracker's own
      // redraws, so the field itself is the source of truth here.
      validate: function () { return inputCommitted && !!fieldValue('#xgtHome'); },
      autoComplete: function () {
        var i = el('xgtHome'); if (!i) return;
        i.value = 'Marin';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      } },

    { instruction: 'Now the player you are tracking — enter their cap number.',
      highlight: '#xgtNum',
      allow: '#xgtNum',
      commit: '#xgtNum',
      validate: function () { return inputCommitted && !!fieldValue('#xgtNum'); },
      autoComplete: function () {
        var i = el('xgtNum'); if (!i) return;
        i.value = '7';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      } },

    { instruction: 'Tap <b>Start tracking</b>.\n\nThe view switches to Front Court by itself — that is expected, not something going wrong.',
      highlight: '#xgtGo',
      allow: '#xgtGo',
      // NOT #xgtPres: the bar renders as soon as the tracker opens, so that was
      // already true before this button was pressed -- which is why the tutorial
      // jumped to lesson 2 on its own. go() closes the setup sheet and commits
      // the cap number, so those two together are the real signal.
      validate: function () { return !sheetOpen() && T.state.me.number != null; },
      autoComplete: function () { click('#xgtGo'); },
      success: 'Tracking' }
  ]},

  { title: 'The clock', steps: [
    { ack: true,
      instruction: 'Top of the screen: the <b>quarter</b> and the <b>clock</b>. The clock counts down from 8:00.',
      highlight: '#xgtClock' },

    { instruction: 'Tap the clock to start it.',
      highlight: '#xgtT',
      allow: '#xgtT',
      validate: function () { return T.state.running === true; },
      autoComplete: function () { click('#xgtT'); },
      success: 'Running' },

    { ack: true,
      instruction: 'Here is the part nobody expects, and it is worth knowing.\n\n' +
        'When you tap a zone the tracker <b>remembers the clock at that instant</b> but keeps it running — it does not freeze while you choose.\n\n' +
        'When you finish, if what you logged <b>stops play</b> (a goal, or a personal foul) the clock jumps back to the moment you tapped, and stops there. If it does not stop play — a blocked shot, say — the clock is left alone, because it was right all along.' },

    { instruction: 'Let’s watch that happen. Tap anywhere on the field, in front of the goal.',
      onEnter: mark,
      allowZone: '*',
      validate: function () { return !!(T.state.draft && T.state.draft.fieldZone); },
      autoComplete: function () { tapZone('z3'); } },

    { instruction: 'Now log a goal: <b>Shot</b>, then <b>Goal</b>, then tap roughly where in the net it went.\n\nIf it then asks who assisted, name them or skip — speed beats completeness during a game.',
      allow: '#xgtSheet',
      validate: function () { return loggedSince(base, { action: 'shot', outcome: 'goal' }); },
      autoComplete: function () {
        // The assist sheet only appears where Advanced Tracking Actions are
        // available, so it is optional, never an assumption.
        chain(['.xgtOpts [data-a="shot"]', '[data-s="goal"]', '.gz[data-p="low_left"]', '?#xgtAssistSkip']);
      },
      success: 'Goal logged' },

    { ack: true,
      instruction: 'Look at the clock — it stopped on its own, at the moment you tapped the zone. The seconds you spent choosing were not taken off the game.',
      highlight: '#xgtT' },

    { instruction: 'To correct the clock or change quarter, tap the quarter button.',
      highlight: '#xgtQ',
      allow: '#xgtQ',
      validate: function () { return !!el('xgtDone'); },
      autoComplete: function () { click('#xgtQ'); } },

    { instruction: 'Quarter chips along the top, then plus and minus to match the pool clock. <b>SO</b> is the penalty shootout — we come back to that.\n\n' +
        'Adjust the time however you like, then tap <b>Done</b>.\n\nEvents you have already logged keep their own timestamps; this only moves the clock.',
      highlight: '#xgtDone',
      allow: '#xgtSheet',
      validate: function () { return !sheetOpen(); },
      autoComplete: function () { chain(['[data-d="-60"]', '#xgtDone']); } }
  ]},

  { title: 'Zones', steps: [
    { ack: true,
      instruction: 'One rule makes the whole tracker make sense:\n\n<b>Every event starts by tapping where on the field it began.</b>\n\nZone, then what happened, then the outcome. There is no other way in.' },

    { ack: true,
      instruction: 'The numbers on the water are the zones: the centre, the five around the arc, and three further out. Anything in the far half is <b>OPPO</b>.',
      highlight: '#xgtZoneLayer' },

    { instruction: 'Tap <b>zone 3</b> — straight out from the goal.',
      allowZone: 'z3',
      validate: function () { return !!(T.state.draft && T.state.draft.fieldZone === 'z3'); },
      autoComplete: function () { tapZone('z3'); },
      success: 'Zone 3' },

    { instruction: 'Tapped the wrong place? Close the sheet with the ✕ and nothing is recorded.\n\nDo that now.',
      highlight: '#xgtX',
      allow: '#xgtX',
      validate: function () { return !T.state.draft; },
      autoComplete: function () { click('#xgtX'); },
      success: 'Nothing logged' },

    { ack: true,
      instruction: 'Your club numbers its zones differently? <b>Menu → Rename Field Zones</b>, and tap any zone to renumber it. That is personal to this device, not a team setting. <b>Hide Field Zones</b> is next to it if you would rather see clean water.',
      highlight: '#xgtOptionsBtn' }
  ]},

  { title: 'Actions and outcomes', steps: [
    { instruction: 'Tap zone 2 to open the action sheet again.',
      onEnter: mark,
      allowZone: '*',
      validate: function () { return !!(T.state.draft && T.state.draft.fieldZone); },
      autoComplete: function () { tapZone('z2'); } },

    { ack: true,
      instruction: 'The row at the top is easy to miss and worth knowing: <b>mine / Team-mate / Opponent</b>.\n\nIt defaults to your player, so the usual case needs no tap — but it is how you log the shot your player did <i>not</i> take.',
      highlight: '#xgtAttr' },

    { instruction: 'Log a blocked shot: <b>Shot</b>, then <b>Blocked Shot</b>.',
      allow: '#xgtSheet',
      validate: function () { return !!(T.state.draft && T.state.draft.outcome === 'blocked') || loggedSince(base, { action: 'shot', outcome: 'blocked' }); },
      autoComplete: function () {
        chain(['.xgtOpts [data-a="shot"]', '[data-s="blocked"]']);
      } },

    { instruction: 'Now the follow-up most people miss — <b>who</b> blocked it, and did the ball stay in play. Pick whichever you like.\n\nThat is the difference between a save and a field block, and it is what makes the numbers honest later.',
      allow: '#xgtSheet',
      validate: function () { return loggedSince(base, { action: 'shot', outcome: 'blocked' }); },
      autoComplete: function () { click('[data-br="gk_in"]'); },
      success: 'Blocked shot logged' },

    { instruction: 'Next: a miss. Tap a zone, then <b>Shot</b>, then <b>Missed Shot</b>, and tap where it went.\n\nThe miss map is not the goal grid — it has the posts, the bar, wide, and short into the water.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      validate: function () { return loggedSince(base, { action: 'shot', outcome: 'missed' }); },
      autoComplete: function () {
        chain([function () { tapZone('z4'); }, '.xgtOpts [data-a="shot"]', '[data-s="missed"]', '.gz[data-p="crossbar"]']);
      },
      success: 'Miss logged' },

    { instruction: 'Now a foul. Tap a zone, then <b>Personal Foul</b>, then <b>Exclusion</b>.\n\nThe player you tapped is always the one who <b>committed</b> it — there is no drawn-or-committed choice to make.\n\nPick <b>Penalty</b> instead and the tracker opens the resulting penalty shot straight away, by itself. Worth expecting, so it does not feel like the app running away with you.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      validate: function () { return loggedSince(base, { action: 'exclusion' }); },
      autoComplete: function () {
        chain([function () { tapZone('z5'); }, '.xgtOpts [data-a="exclusion"]', '[data-s="exclusion"]']);
      },
      success: 'Foul logged' },

    { instruction: 'One more: a <b>Steal</b>. Tap a zone and pick it — there is no outcome to choose, it is a single tap.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      validate: function () { return loggedSince(base, { action: 'steal' }); },
      autoComplete: function () {
        chain([function () { tapZone('z6'); }, '.xgtOpts [data-a="steal"]']);
      },
      success: 'Steal logged' },

    { ack: true,
      instruction: 'The pill at the bottom is your player going in and out of the water — tap it when they sub, and their time in the water is counted for you.',
      highlight: '#xgtPres' },

    { ack: true,
      instruction: 'On <b>Pro</b> the same sheet also carries <b>Turnover</b> as its own action — offensive foul, pass intercepted, shot clock — plus the fuller foul outcomes.\n\nEverything you have just done is on the free tier.' }
  ]},

  { title: 'Reading the stats', steps: [
    { instruction: 'You can read the numbers mid-game, without stopping. Tap <b>Stats</b>.',
      highlight: '#xgtStatsBtn',
      allow: '#xgtStatsBtn',
      validate: statsOpen,
      autoComplete: function () { click('#xgtStatsBtn'); } },

    { ack: true,
      instruction: 'Goals, shots, shooting percentage, steals, exclusions drawn and given, assists, time in the water — all live, from what you have logged in the last few minutes.' },

    { ack: true,
      instruction: 'Below that, <b>where it happened</b>: the field shaded by how much came from each zone. The darkest zone is where your player’s game is being played.' },

    { ack: true,
      instruction: 'Then <b>goal placement</b> — the same nine squares you have been tapping. Over a season this is where a shooter’s habit shows up.' },

    { ack: true,
      instruction: '<b>Origin → outcome → placement</b> further down is stored per event, not worked out afterwards. That is exactly why the tracker asks you for a zone every single time.\n\nUnder it is the full log — tap any line to correct or delete it, and <b>+ Add Event</b> for the one you missed.' },

    { instruction: 'Close the stats with <b>‹ Back</b>.',
      highlight: '#xgtSb',
      allow: ['#xgtSb', '#xgtStats'],
      validate: function () { return !statsOpen(); },
      autoComplete: function () { click('#xgtSb'); } }
  ]},

  { title: 'Ending the game', steps: [
    { ack: true,
      instruction: 'Four quarters, and you change quarter from the same <b>✎</b> time sheet you used earlier.\n\nWhen the clock hits 0:00 in Q4, regulation ends by itself and the field stops taking taps — there is no meaningful "where on the field" once it is over.' },

    { ack: true,
      instruction: 'Fouls after the buzzer are real, so they stay available: <b>Menu → Log Post-Game Foul</b> appears at that point, and only then.',
      highlight: '#xgtOptionsBtn' },

    { ack: true,
      instruction: 'The <b>penalty shootout</b> lives on the time sheet as an <b>SO</b> chip beside the quarter chips. Worth remembering, because it is not obvious — "we have moved past regulation" is the same kind of decision as picking a quarter.\n\nShooting order is enforced for you, with an override for competitions that do it differently.' },

    { instruction: 'Open the <b>Menu</b>.',
      highlight: '#xgtOptionsBtn',
      allow: '#xgtOptionsBtn',
      validate: function () { return sheetOpen() && !!el('xgtOptEndSave'); },
      autoComplete: function () { click('#xgtOptionsBtn'); } },

    { ack: true,
      instruction: '<b>End &amp; Save Session</b> is here. Be reassured rather than anxious about it: the session has been saved after every single tap, so this saves nothing new — it marks the game finished.\n\n<b>Export CSV</b> and <b>Export JSON</b> are free on every tier, for the game in front of you. CSV opens in a spreadsheet; JSON keeps every field including coordinates.',
      highlight: '#xgtOptEndSave' },

    { instruction: 'Close the menu with the ✕.',
      highlight: '#xgtX',
      allow: '#xgtX',
      validate: function () { return !sheetOpen(); },
      autoComplete: function () { click('#xgtX'); } },

    { ack: true,
      instruction: 'On <b>Pro</b>, sessions also save to your library on every device, stats combine across every game you have tracked, and the heat map and goal map export as a PDF you can hand a player.' }
  ]},

  { title: 'Track it yourself', steps: [
    { ack: true,
      instruction: 'Last part, and nothing will be highlighted.\n\nThree moments, one at a time. Track each one the way you would in a game — zone first.' },

    { instruction: 'Your player <b>scores from zone 3</b>.',
      onEnter: function () { mark(); practice = { done: [] }; },
      allowZone: '*',
      allow: '#xgtSheet',
      validate: function () {
        var a = actions();
        for (var i = base; i < a.length; i++)
          if (a[i].action === 'shot' && a[i].outcome === 'goal' && a[i].fieldZone === 'z3') return true;
        return false;
      },
      autoComplete: function () {
        chain([function () { tapZone('z3'); }, '.xgtOpts [data-a="shot"]', '[data-s="goal"]',
               '.gz[data-p="top_right"]', '?#xgtAssistSkip']);
      },
      success: 'That is the one' },

    { instruction: 'Their shot <b>from the left wing is blocked</b>.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      validate: function () {
        var a = actions();
        for (var i = base; i < a.length; i++)
          if (a[i].action === 'shot' && a[i].outcome === 'blocked' && a[i].fieldZone === 'z1') return true;
        return false;
      },
      autoComplete: function () {
        chain([function () { tapZone('z1'); }, '.xgtOpts [data-a="shot"]', '[data-s="blocked"]', '[data-br="gk_in"]']);
      },
      success: 'Blocked, from the wing' },

    { instruction: 'Your player <b>steals the ball</b> anywhere you like.',
      onEnter: mark,
      allowZone: '*',
      allow: '#xgtSheet',
      validate: function () { return loggedSince(base, { action: 'steal' }); },
      autoComplete: function () {
        chain([function () { tapZone('z13'); }, '.xgtOpts [data-a="steal"]']);
      },
      success: 'Steal' },

    { ack: true,
      instruction: 'That is the whole tracker.\n\nZone, what happened, outcome — and the stats build themselves while you watch the game.' }
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
    return { ack: !!s.ack, lesson: s._lessonTitle,
             hasTarget: !!(s.allow || s.allowZone || typeof s.highlight === 'string') };
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
