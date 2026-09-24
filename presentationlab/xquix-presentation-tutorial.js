/* ============================================================================
 * XquiX Studio — Presentation Mode tutorial
 * ----------------------------------------------------------------------------
 * A guided walkthrough of Presentation Mode, run ON the real Studio through the
 * Studio's own tutorial engine (startTutorial / goToTutorialStep / the
 * #tutorialBanner chrome) — the same engine "First Coaching Session" uses.
 * Nothing here is a second engine: this file only builds a step list, loads a
 * play to present, and cleans up after itself.
 *
 *   <script src="xquix-presentation-tutorial.js"></script>   anywhere after the
 *   Studio's own inline script has defined startTutorial (it is called only at
 *   start time, never at load time, so load order is otherwise free).
 *
 * Exposes:
 *   window.startPresentationTutorial()   — the hook index.html's Mode Switcher
 *                                          already probes for ("Phase 2")
 *   MIZE.PresentationTutorial.start()    — same thing, namespaced
 *   MIZE.PresentationTutorial.exit()     — leave early, with full cleanup
 *   MIZE.PresentationTutorial.isRunning()
 *
 * Design context: presentation/PRESENTATION-TUTORIAL.md in the project.
 *
 * ON THE CONTROL PANEL (2026-09-24). Presentation's controls are the Workbench
 * control surface (#cwSurface) with Presentation's groups — FUNCTIONS, QUICKS,
 * PRESENT, SCREENS, CAMERA, SYSTEM (PRESENTATION-MODE.md §27) — and a mode is
 * chosen from XquiX Home (SYSTEM → Mode). Before this the tutorial hid the
 * panel and taught the Menu tab, Menu → Presentation → Spotlight / Shot Clock
 * and Exit Presentation: controls a coach never sees again afterwards. It now
 * runs on the panel (steps.tutorialOptions.surface, as the Coaching tutorial
 * does): every ring is on a panel tab or button, a Home circle, a camera arrow
 * or the board. A ring on a button whose group is not showing goes to that
 * group's tab first (the engine's cwTutTarget).
 *
 * VOICE (2026-09-23): the same Read aloud + Voice commands the Coaching tutorial
 * has, through the engine's own XQTutVoice -- nothing voice-related lives in this
 * file except the step list's options (steps.tutorialOptions: voice, exitScreen,
 * rebuild) and the welcome box that offers the two switches (voiceOptions).
 * What is read is the box's own text, so the instructions name buttons in words
 * ("the Start button") rather than by glyph: a speech engine reads a glyph by
 * its Unicode name, or not at all.
 *
 * What it teaches, in order: Mode → Presenting · the Full Studio View and the
 * camera (CAMERA, the edge arrows) · playing and stepping the frames (PRESENT)
 * · the Spotlight (CAMERA) · the Shot Clock (QUICKS) · back to the Full Studio
 * View · Mode → Coaching. Every required action is in the Free version
 * (function_gates P01, P02–P04, P12, SC01–SC04); the Pro-only functions met
 * along the way are named as such and never required.
 *
 * What it must never do:
 *   - lose the coach's work. The engine clears the board on start (that is
 *     what the First Coaching Session does too), so the frames and the current
 *     scene are snapshotted before start and put back on teardown.
 *   - leave presentation state behind. Leave tutorial, completion, and
 *     MIZE.PresentationTutorial.exit() all run the same idempotent cleanup:
 *     Home closed, presentation off, spotlight off, shot clock off, panels
 *     closed, the coach's panel group and fold back (the engine), Remote and
 *     Quick Command Bar settings restored.
 * ==========================================================================*/
(function () {
'use strict';

var SEQUENCE_NAME = 'Tutorial - First Coaching Session'; // 11 frames, embedded in index.html (TUTORIAL_EMBEDDED_DATA)

var running = false;
var saved = null;        // what to put back on teardown
var observer = null;     // watches body.tutorialModeActive so "Leave tutorial" also cleans up

/* --------------------------------------------------------------- helpers */
function $(id) { return document.getElementById(id); }
function q(sel) { try { return document.querySelector(sel); } catch (err) { return null; } }
function inPresentation() { return document.body.classList.contains('presentation'); }
function homeOpen() { return typeof XQStage !== 'undefined' && XQStage.isOpen() && XQStage.consumer() === 'home'; }
function camera() { return (typeof XQStage !== 'undefined' && XQStage.isOpen()) ? XQStage.camera() : null; }
function panelOpen(id) { var p = $(id); return !!p && p.classList.contains('open'); }
function spot() { return (window.MIZE && MIZE.State && MIZE.State.spotlight) || {}; }
function clock() { return (window.MIZE && MIZE.State && MIZE.State.shotClock) || {}; }
function lastFrame() { return (typeof frames !== 'undefined' && frames && frames.length) ? frames.length - 1 : 0; }
function isPlaying() { return typeof playing !== 'undefined' && !!playing; }
function acked() { return typeof tutorialManualAck !== 'undefined' && !!tutorialManualAck; }
function visibleStageLights() { return Array.prototype.slice.call(document.querySelectorAll('#stageLights .stageLight')).filter(function (e) { return e.getClientRects().length > 0; }); }

/* The control panel, through the engine's own helpers (coaching/COACHING-TUTORIAL.md §2):
   target(g, sel)  what to ring for "tap <sel> in <g>" -- the button when its group is
                   showing, otherwise the group's tab (or the tab that unfolds the panel)
   shown(g)        the group is on screen
   press(g, sel)   Skip: show the group and press the button, as the coach would        */
function target(g, sel) { return typeof cwTutTarget === 'function' ? cwTutTarget(g, sel || null) : null; }
function shown(g) { return typeof cwTutGroupShown === 'function' && cwTutGroupShown(g); }
function press(g, sel) { return typeof cwTutPress === 'function' && cwTutPress(g, sel); }
function showGroup(g) { if (typeof cwTutShowGroup === 'function') cwTutShowGroup(g); }
function B(id) { return '[data-id="' + id + '"]'; }

/* A step that only asks the coach to read and tap "Got it". Not isPreStep:
   pre-steps are labeled "Welcome" and left out of the step count, which is
   right for the opening screen and wrong for an explanation mid-way. */
function ack(text, extra) {
  var s = {
    requiresAcknowledge: true,
    skipSuccessMessage: true,
    instruction: text,
    highlight: '#tutorialAcknowledgeBtn',
    validate: { type: 'custom', fn: acked },
    autoComplete: function () { var b = $('tutorialAcknowledgeBtn'); if (b) b.click(); }
  };
  if (extra) Object.keys(extra).forEach(function (k) { s[k] = extra[k]; });
  return s;
}
/* "Tap the highlighted <GROUP> tab." */
function tab(id, g, text, extra) {
  var s = { id: id, instruction: text, skipDimPhase: true,
    highlight: function () { return target(g, null); },
    validate: { type: 'custom', fn: function () { return shown(g); } },
    autoComplete: function () { showGroup(g); } };
  if (extra) Object.keys(extra).forEach(function (k) { s[k] = extra[k]; });
  return s;
}

/* Board center in client coordinates -- where autoComplete drops the spotlight. */
function boardCenter() {
  var b = $('board'); if (!b) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  var r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/* ----------------------------------------------------- the play to present */
function loadTutorialSequence() {
  var seq = (typeof tutorialSequenceFrames === 'function') ? tutorialSequenceFrames(SEQUENCE_NAME) : null;
  if (!seq || !seq.length) return false;
  if (isPlaying()) {
    playing = false;
    if (typeof animFrameHandle !== 'undefined' && animFrameHandle) cancelAnimationFrame(animFrameHandle);
    if (typeof syncPlayPauseUI === 'function') syncPlayPauseUI();
  }
  frames = seq.slice();
  currentFrame = 0;
  if (typeof loadFrame === 'function') loadFrame(0);
  return true;
}

/* --------------------------------------------------------- snapshot/restore */
function snapshot() {
  var remoteCb = $('timelineRemoteToggle');
  var qcb = $('quickCommandBar');
  var qcbTab = $('showQuickCommandBarTab');
  saved = {
    frames: (typeof frames !== 'undefined' && frames) ? frames.slice() : [],
    currentFrame: (typeof currentFrame === 'number') ? currentFrame : 0,
    scene: (typeof makeFrameState === 'function') ? safe(makeFrameState) : null,
    remoteHidden: remoteCb ? remoteCb.checked : null,
    qcbDisplay: qcb ? qcb.style.display : null,
    qcbTabActive: qcbTab ? qcbTab.classList.contains('active') : null
  };
}
function safe(fn) { try { return fn(); } catch (err) { return null; } }

function restore() {
  if (!saved) return;
  var s = saved; saved = null;
  try {
    if (s.frames.length) {
      frames = s.frames;
      var i = Math.min(Math.max(0, s.currentFrame), frames.length - 1);
      currentFrame = i;
      if (typeof loadFrame === 'function') loadFrame(i);
    } else {
      frames = [];
      currentFrame = 0;
      if (s.scene && typeof loadState === 'function') loadState(s.scene);
      if (typeof renderFrames === 'function') renderFrames();
    }
  } catch (err) { console.error('Presentation tutorial: could not restore the board', err); }
  try {
    var cb = $('timelineRemoteToggle');
    if (cb && s.remoteHidden !== null && cb.checked !== s.remoteHidden) { cb.checked = s.remoteHidden; if (typeof updateTimelineRemoteVisibility === 'function') updateTimelineRemoteVisibility(); }
    if (typeof updateTimelineRemoteVisibility === 'function') updateTimelineRemoteVisibility();
  } catch (err) {}
  try {
    var qcb = $('quickCommandBar'), tab = $('showQuickCommandBarTab');
    if (qcb && s.qcbDisplay !== null) qcb.style.display = s.qcbDisplay;
    if (tab && s.qcbTabActive !== null) tab.classList.toggle('active', s.qcbTabActive);
  } catch (err) {}
}

/* ------------------------------------------------------------------ cleanup */
/* Everything the tutorial may have switched on, switched off again. Shared by
   cleanup() (the run is over) and Start over (the run begins again, so the
   coach's own board stays in the snapshot until the real end). */
function resetPresentationState() {
  try {
    // XquiX Home first (the tutorial passes through it twice): it is a stage
    // consumer of its own, and closing it lets the rest act on the Studio.
    if (homeOpen() && typeof xquixHideHome === 'function') xquixHideHome();
    // Then leave presentation (it disarms the spotlight, closes panels and
    // resets the field geometry itself), then what togglePresentation() does
    // not own.
    if (inPresentation() && typeof togglePresentation === 'function') togglePresentation();
    if (typeof disarmSpotlight === 'function' && (spot().armed || spot().placed)) disarmSpotlight();
    var sc = clock();
    if (sc.active) {
      if (typeof stopShotClock === 'function') safe(stopShotClock);
      sc.active = false;
      if (typeof updateShotClockDisplay === 'function') updateShotClockDisplay();
    }
    if (typeof closeToolPanels === 'function') closeToolPanels();
    if (typeof closePresentationPanels === 'function') closePresentationPanels();
  } catch (err) { console.error('Presentation tutorial cleanup', err); }
}
function cleanup() {
  if (!running) return;
  running = false;
  if (observer) { observer.disconnect(); observer = null; }
  resetPresentationState();
  restore();
  if (typeof fitBoardToScreen === 'function') safe(fitBoardToScreen);
}

/* ------------------------------------------------------------------- steps */
function buildPresentationModeSteps() {
  var spotStart = null; // where the spotlight was placed, for the move/resize step

  // The welcome box offers the voice, so it says what can be said -- only what
  // this browser can actually do (Firefox has no speech recognition).
  var V = (typeof XQTutVoice !== 'undefined') ? XQTutVoice : null;
  // Kept as short as the Coaching tutorial's: with the two switches under it, a
  // longer box no longer fits above Exit and Skip on a phone in landscape.
  var welcome = 'Welcome! This tutorial shows you how to present a play to your team.\nLook for the pulsing red frame. It marks exactly what to tap next.';
  if (V && V.ttsSupported && V.commandsSupported) welcome += '\nWant the instructions read aloud? You can also answer by voice: "Got it", "Next step", "Repeat" or "Exit".';
  else if (V && V.ttsSupported) welcome += '\nWant the instructions read aloud? Switch it on below.';
  welcome += '\nTap "Got it" to begin.';

  var steps = [

    /* ---------------------------------------------------- welcome (pre-step) */
    {
      id: 'welcome',
      isPreStep: true, requiresAcknowledge: true, skipSuccessMessage: true, bannerSide: 'left',
      voiceOptions: true, // the Read aloud and Voice commands switches, in the box (the engine draws them)
      instruction: welcome,
      onEnter: function () {
        if (!loadTutorialSequence()) {
          if (typeof MizeDialog !== 'undefined') MizeDialog.alert('Something is wrong with the tutorial’s built-in reference data: the play to present could not be read. This shouldn’t normally happen since it’s embedded in the app itself.');
        }
      },
      highlight: '#tutorialAcknowledgeBtn',
      validate: { type: 'custom', fn: acked },
      autoComplete: function () { var b = $('tutorialAcknowledgeBtn'); if (b) b.click(); }
    },

    /* ------------------------------------- into Presentation Mode: Mode → Presenting */
    tab('tabSystem', 'system', 'A play is on the board. Presentation Mode is one of the XquiX modes, and you choose a mode from the SYSTEM group of the control panel. Tap the highlighted SYSTEM tab.'),
    {
      id: 'modeIn',
      instruction: 'Tap the highlighted Mode button.',
      skipDimPhase: true,
      highlight: function () { return target('system', B('mode')); },
      validate: { type: 'custom', fn: function () { return homeOpen() || inPresentation(); } },
      autoComplete: function () { if (!homeOpen()) press('system', B('mode')); }
    },
    {
      id: 'presenting',
      instruction: 'These are the XquiX modes. Tap the highlighted Presenting.',
      skipDimPhase: true, bannerSide: 'right', // Home's circles: Presenting and Coaching sit left and centre
      highlight: '#xquixHomeCircle_presenting',
      validate: { type: 'custom', fn: inPresentation },
      autoComplete: function () { if (!inPresentation()) { var c = $('xquixHomeCircle_presenting'); if (c) c.click(); } }
    },
    ack('You are presenting. This opening view is the Full Studio View: all three screens, with the board in the middle.\n\nThe control panel stays with you, now with Presentation’s groups.', { id: 'studioAck', bannerSide: 'left', skipDimPhase: true }),

    /* ------------------------------------------------------------- the camera */
    tab('tabCamera', 'camera', 'Where the camera looks is in the CAMERA group. Tap the highlighted CAMERA tab.', { bannerSide: 'left' }),
    {
      id: 'camRight',
      instruction: 'Tap the highlighted Right button to turn the camera to the right screen.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: function () { return target('camera', B('camRight')); },
      validate: { type: 'custom', fn: function () { return camera() === 'right'; } },
      autoComplete: function () { if (camera() !== 'right') press('camera', B('camRight')); }
    },
    ack('The right screen shows an image, a PDF or a website, like a stats sheet. The left screen shows a video. You load them from the SCREENS group; that is a Pro function.\n\nYou can also turn the camera by tapping a screen, by swiping, or with the arrows at the edges.', { id: 'screensAck', bannerSide: 'left', skipDimPhase: true }),
    {
      id: 'arrowLeft',
      instruction: 'Try the arrows: tap the highlighted arrow at the left edge to turn back to the board.',
      bannerSide: 'right', skipDimPhase: true,
      highlight: '#studioNavLeft',
      validate: { type: 'custom', fn: function () { return camera() === 'center'; } },
      autoComplete: function () { if (typeof XQStage !== 'undefined') XQStage.setCamera('center'); }
    },

    /* --------------------------------------------------------- playing the frames */
    tab('tabPresent', 'present', 'The play has several frames. You run it from the PRESENT group. Tap the highlighted PRESENT tab.', { bannerSide: 'left' }),
    {
      id: 'play',
      instruction: 'Tap the highlighted Play button and watch the play run to its last frame.',
      bannerSide: 'left', skipSuccessMessage: true, skipDimPhase: true,
      // no ring while the play runs (the box hides too); the button stays tappable so the coach can pause
      highlight: function () { return isPlaying() ? null : target('present', B('play')); },
      allowedSelectors: function () { return target('present', B('play')); },
      validate: { type: 'custom', fn: function () { return lastFrame() > 0 && currentFrame === lastFrame() && !isPlaying(); } },
      autoComplete: function () {
        if (isPlaying()) return;
        showGroup('present');
        if (typeof animateToFrame === 'function') { var t = lastFrame(); playing = true; animateToFrame(t, 1.0, function () { currentFrame = t; playing = false; if (typeof syncPlayPauseUI === 'function') syncPlayPauseUI(); if (typeof renderFrames === 'function') renderFrames(); }); }
        else if (typeof loadFrame === 'function') loadFrame(lastFrame());
      }
    },
    {
      id: 'start',
      instruction: 'Tap the highlighted Start button to jump back to the first frame.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: function () { return target('present', B('start')); },
      validate: { type: 'custom', fn: function () { return currentFrame === 0 && !isPlaying(); } },
      autoComplete: function () { showGroup('present'); if (typeof loadFrame === 'function') loadFrame(0); }
    },
    {
      id: 'next',
      instruction: 'Tap the highlighted Next button once. Stepping one frame at a time is how you talk your team through a play one movement at a time.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: function () { return target('present', B('next')); },
      validate: { type: 'custom', fn: function () { return currentFrame >= 1 && !isPlaying(); } },
      autoComplete: function () { showGroup('present'); if (typeof loadFrame === 'function') loadFrame(1); }
    },

    /* -------------------------------------------------------------- spotlight */
    {
      id: 'spotlight',
      instruction: 'Now put a spotlight on the board. The Spotlight is in CAMERA: tap the highlighted button.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: function () { return target('camera', B('spotlight')); },
      validate: { type: 'custom', fn: function () { return !!spot().armed; } },
      autoComplete: function () { if (!spot().armed) press('camera', B('spotlight')); }
    },
    {
      id: 'spotPlace',
      instruction: 'Tap the board where the spotlight should be.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: '#board',
      allowedSelectors: '#spotlightOverlay',
      validate: { type: 'custom', fn: function () { return !!spot().placed; } },
      onValidated: function () { spotStart = { x: spot().x, y: spot().y, r: spot().r }; },
      autoComplete: function () { var c = boardCenter(); if (typeof placeSpotlight === 'function') placeSpotlight(c.x, c.y); }
    },
    {
      id: 'spotMove',
      instruction: 'Drag the center handle to move the spotlight, or the outer handle to resize it. Tapping anywhere else on the screen glides the spotlight there.\n\nMove or resize it now.',
      bannerSide: 'left', skipDimPhase: true,
      onEnter: function () { if (!spotStart) spotStart = { x: spot().x, y: spot().y, r: spot().r }; },
      highlight: ['#spotlightMoveHandle', '#spotlightResizeHandle'],
      allowedSelectors: '#spotlightOverlay',
      validate: { type: 'custom', fn: function () {
        var s = spot(); if (!s.placed || !spotStart) return false;
        return Math.abs(s.x - spotStart.x) > 12 || Math.abs(s.y - spotStart.y) > 12 || Math.abs(s.r - spotStart.r) > 12;
      } },
      autoComplete: function () { var s = spot(); if (typeof animateSpotlightTo === 'function') animateSpotlightTo(s.x + 120, s.y); else if (typeof placeSpotlight === 'function') placeSpotlight(s.x + 120, s.y); }
    },
    {
      id: 'spotOff',
      instruction: 'To switch the spotlight off, tap the highlighted Spotlight button again. Tapping one of the stage lights above the screens does the same.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: function () { return target('camera', B('spotlight')); },
      allowedSelectors: function () { var t = target('camera', B('spotlight')); return visibleStageLights().concat(t ? [t] : []); },
      validate: { type: 'custom', fn: function () { var s = spot(); return !s.armed && !s.placed; } },
      autoComplete: function () { if (typeof disarmSpotlight === 'function') disarmSpotlight(); if (typeof cwSync === 'function') cwSync(); }
    },

    /* ------------------------------------------------------------- shot clock */
    {
      id: 'shotClock',
      instruction: 'A shot clock on the board makes a drill feel like a game. It is in QUICKS: tap the highlighted Shot Clock icon.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: function () { return target('quicks', '[data-src="shotClockToggleBtn"]'); },
      validate: { type: 'custom', fn: function () { return !!clock().active; } },
      autoComplete: function () { if (!clock().active) press('quicks', '[data-src="shotClockToggleBtn"]'); }
    },
    {
      id: 'clockStart',
      instruction: 'The Shot Clock panel opens. Tap Start.',
      bannerSide: 'right', skipDimPhase: true, useShadeHighlight: true, // Start sits at the panel's left; on a phone the panel is full-width, so the banner keeps to the right
      highlight: '#shotClockStartBtn',
      allowedSelectors: '#shotClockPanel',
      validate: { type: 'custom', fn: function () { return !!clock().running; } },
      autoComplete: function () { var b = $('shotClockStartBtn'); if (b) b.click(); else if (typeof startShotClock === 'function') startShotClock(); }
    },
    {
      id: 'clockOk',
      instruction: 'Tap OK. The clock keeps counting in the corners of the board.',
      bannerSide: 'right', skipDimPhase: true, useShadeHighlight: true,
      // on a phone in landscape the panel is taller than the screen and OK is below its fold: bring it up
      onEnter: function () { [0, 350].forEach(function (ms) { setTimeout(function () { var b = $('shotClockOkBtn'); if (b && b.scrollIntoView) { try { b.scrollIntoView({ block: 'nearest' }); } catch (e) {} } }, ms); }); },
      highlight: '#shotClockOkBtn',
      validate: { type: 'custom', fn: function () { return !panelOpen('shotClockPanel'); } },
      autoComplete: function () { if (typeof closeToolPanels === 'function') closeToolPanels(); }
    },
    ack('The Shot Clock panel also sets the seconds and the position, and resets the clock. Counting up and syncing it to a play are Pro functions. Tap Shot Clock in QUICKS again to remove it.\n\nIn CAMERA you will also find Dim, which darkens the studio, and 3D, which tilts the field like a stadium camera.', { id: 'clockAck', bannerSide: 'right', skipDimPhase: true }), // right: on a phone in landscape the box is as tall as the room above Exit and Skip

    /* ------------------------------------------------------------ back out */
    {
      id: 'camStudio',
      instruction: 'Back to the whole studio: in CAMERA, tap the highlighted Studio button.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: function () { return target('camera', B('camPan')); },
      validate: { type: 'custom', fn: function () { return camera() === 'pan'; } },
      autoComplete: function () { if (camera() !== 'pan') press('camera', B('camPan')); }
    },
    tab('tabSystemOut', 'system', 'To go back to editing, you choose Coaching as the mode. Tap the highlighted SYSTEM tab.', { bannerSide: 'left' }),
    {
      id: 'modeOut',
      instruction: 'Tap the highlighted Mode button.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: function () { return target('system', B('mode')); },
      validate: { type: 'custom', fn: function () { return homeOpen() || !inPresentation(); } },
      autoComplete: function () { if (!homeOpen()) press('system', B('mode')); }
    },
    {
      id: 'coaching',
      instruction: 'Tap the highlighted Coaching.',
      bannerSide: 'right', skipDimPhase: true,
      highlight: '#xquixHomeCircle_coaching',
      validate: { type: 'custom', fn: function () { return !homeOpen() && !inPresentation(); } },
      autoComplete: function () { if (homeOpen()) { var c = $('xquixHomeCircle_coaching'); if (c) c.click(); } }
    },
    ack('You are back in editing, and the board is as you left it.\n\nOn a computer: Esc leaves Presentation Mode, the arrow keys turn the camera, and 0 to 3 jump to a screen.\n\nEverything you used is part of the Free version.', { id: 'doneAck', bannerSide: 'left', skipDimPhase: true })
  ];

  // The engine's per-tutorial options (coaching/COACHING-TUTORIAL.md §3) -- the
  // same as the Coaching tutorial's:
  //   surface    run on the control panel (body.cwTutorial): it stays on screen,
  //              starts unfolded, and the coach's own group and fold come back
  //              afterwards, in Coaching and in Presentation alike
  //   voice      Read aloud + Voice commands, with their switches next to Exit
  //   exitScreen Exit (the button or the spoken "Exit") asks first: Keep going ·
  //              Start over · Leave tutorial
  //   rebuild    what Start over runs -- see startOver() below
  steps.tutorialOptions = { surface: true, voice: true, exitScreen: true, rebuild: startOver };
  return steps;
}

/* Start over, from the leave screen. The engine calls this between its own
   exitTutorial() and a fresh startTutorial() with the same completion handling.
   Everything this run switched on goes off (Home, presentation, spotlight, shot
   clock, panels), so the new run starts from the editing view exactly as the
   first one did. The coach's own board is NOT restored here: it stays in the
   snapshot, and comes back when the tutorial really ends. `running` stays true
   and the observer stays attached -- exitTutorial() and startTutorial() run in
   the same task, so by the time the observer is told, tutorialModeActive is
   back on and cleanup() correctly does nothing. */
function startOver() {
  resetPresentationState();
  return buildPresentationModeSteps();
}

/* ------------------------------------------------------------------- start */
function start() {
  if (typeof startTutorial !== 'function') { console.error('Presentation tutorial: the Studio tutorial engine (startTutorial) is not available.'); return false; }
  if (running) exit();
  if (typeof xquixHideHome === 'function') safe(xquixHideHome);
  if (typeof closeToolPanels === 'function') safe(closeToolPanels);
  snapshot();
  // The tutorial starts from the editing view: out of Home, out of an open
  // presentation, before the engine resets the board.
  if (inPresentation() && typeof togglePresentation === 'function') togglePresentation();
  running = true;

  // "Exit Tutorial" calls the engine's exitTutorial() directly, which knows
  // nothing about presentation state -- so watch for the body class it
  // removes, and clean up whichever way the run ends.
  observer = new MutationObserver(function () {
    if (running && !document.body.classList.contains('tutorialModeActive')) cleanup();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  var pendingMode = window._modeIntroductionPending === 'presenting';
  startTutorial(buildPresentationModeSteps(), {
    completionMessage: 'Congratulations! You’ve completed the Presentation Mode tutorial.',
    onComplete: function () {
      cleanup();
      if (pendingMode && typeof setModeTutorialQualification === 'function') { setModeTutorialQualification('presenting'); window._modeIntroductionPending = null; }
      if (typeof MizeDialog !== 'undefined') MizeDialog.alert('Congratulations! You’ve completed the Presentation Mode tutorial. You can now present plays to your team with confidence — full-screen, frame by frame, spotlight and shot clock included.');
    }
  });
  return true;
}

function exit() {
  if (!running) return;
  if (typeof exitTutorial === 'function' && document.body.classList.contains('tutorialModeActive')) exitTutorial(); // cleanup() follows via the observer
  cleanup();
}

/* ----------------------------------------------------------------- exports */
window.startPresentationTutorial = start;
window.MIZE = window.MIZE || {};
MIZE.PresentationTutorial = {
  start: start,
  exit: exit,
  isRunning: function () { return running; },
  buildSteps: buildPresentationModeSteps,
  sequenceName: SEQUENCE_NAME
};

})();
