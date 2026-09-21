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
 * What it teaches, in order: enter Presentation Mode from the Menu · the three
 * screens and the camera arrows · playing and stepping the frames with the
 * Remote Control · the Spotlight · the Shot Clock · exit. Every required action
 * is in the Free version (function_gates P01, P02–P04, P12, SC01–SC04); the
 * Pro-only functions met along the way are named as such and never required.
 *
 * What it must never do:
 *   - lose the coach's work. The engine clears the board on start (that is
 *     what the First Coaching Session does too), so the frames and the current
 *     scene are snapshotted before start and put back on teardown.
 *   - leave presentation state behind. Exit Tutorial, completion, and
 *     MIZE.PresentationTutorial.exit() all run the same idempotent cleanup:
 *     presentation off, spotlight off, shot clock off, panels closed, Remote
 *     and Quick Command Bar visibility restored.
 *   - highlight something that does not exist. #presentationModeHandle is
 *     referenced by index.html but is not in its DOM (2026-09-05 build); this
 *     tutorial goes through the Menu, which is the path that exists.
 * ==========================================================================*/
(function () {
'use strict';

var SEQUENCE_NAME = 'Tutorial - First Coaching Session'; // 11 frames, embedded in index.html (TUTORIAL_EMBEDDED_DATA)

var running = false;
var saved = null;        // what to put back on teardown
var observer = null;     // watches body.tutorialModeActive so "Exit Tutorial" also cleans up

/* --------------------------------------------------------------- helpers */
function $(id) { return document.getElementById(id); }
function q(sel) { try { return document.querySelector(sel); } catch (err) { return null; } }
function inPresentation() { return document.body.classList.contains('presentation'); }
function menuOpen() { var p = $('controlsPanel'); return !!p && p.classList.contains('open'); }
function panelOpen(id) { var p = $(id); return !!p && p.classList.contains('open'); }
function presentCategory() { return q('.cmdCategory[data-cat="present"]'); }
function presentCategoryOpen() { var c = presentCategory(); return !!c && c.classList.contains('open'); }
function spot() { return (window.MIZE && MIZE.State && MIZE.State.spotlight) || {}; }
function clock() { return (window.MIZE && MIZE.State && MIZE.State.shotClock) || {}; }
function frameIdx() { return typeof studioFrameIndex === 'number' ? studioFrameIndex : 1; }
function lastFrame() { return (typeof frames !== 'undefined' && frames && frames.length) ? frames.length - 1 : 0; }
function isPlaying() { return typeof playing !== 'undefined' && !!playing; }
function acked() { return typeof tutorialManualAck !== 'undefined' && !!tutorialManualAck; }

function click(sel) { var e = q(sel); if (e && typeof e.click === 'function') { e.click(); return true; } return false; }
function openMenu() { var p = $('controlsPanel'); if (p) p.classList.add('open'); if (typeof syncPresentationPanelBackdrop === 'function') syncPresentationPanelBackdrop(); }
function closeMenu() { var p = $('controlsPanel'); if (p) p.classList.remove('open'); if (typeof syncPresentationPanelBackdrop === 'function') syncPresentationPanelBackdrop(); }
function reveal(sel) { if (typeof tutorialRevealElement === 'function') tutorialRevealElement(sel); else openMenu(); var e = q(sel); if (e && e.scrollIntoView) { try { e.scrollIntoView({ block: 'center' }); } catch (err) {} } }
function visibleStageLights() { return Array.prototype.slice.call(document.querySelectorAll('#stageLights .stageLight')).filter(function (e) { return e.getClientRects().length > 0; }); }
function showRemote() { if (typeof tutorialShowTimelineRemote === 'function') tutorialShowTimelineRemote(); }
function hideRemote() { if (typeof tutorialHideTimelineRemote === 'function') tutorialHideTimelineRemote(); }

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
function cleanup() {
  if (!running) return;
  running = false;
  if (observer) { observer.disconnect(); observer = null; }
  try {
    // Order matters: leave presentation first (it disarms the spotlight,
    // closes the modal Menu/panels and resets the field geometry itself),
    // then the things togglePresentation() does not own.
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
    document.querySelectorAll('.cmdCategory.open').forEach(function (c) { c.classList.remove('open'); });
    document.querySelectorAll('.cmdCategoryGrid.hasOpenCategory').forEach(function (g) { g.classList.remove('hasOpenCategory'); });
    var back = $('cmdCategoryBackBtn'); if (back) back.style.display = 'none';
  } catch (err) { console.error('Presentation tutorial cleanup', err); }
  restore();
  if (typeof fitBoardToScreen === 'function') safe(fitBoardToScreen);
}

/* ------------------------------------------------------------------- steps */
function buildPresentationModeSteps() {
  var spotStart = null; // where the spotlight was placed, for the move/resize step

  return [

    /* ---------------------------------------------------- welcome (pre-step) */
    {
      isPreStep: true, requiresAcknowledge: true, skipSuccessMessage: true, bannerSide: 'left',
      instruction: 'Welcome! In this tutorial you present a play to your team: you switch the Studio into Presentation Mode, move between its three screens, play the sequence frame by frame, put a spotlight and a shot clock on the board, and come back to editing.\n\nThroughout, the pulsing red frame marks the one thing to tap next.\n\nTap "Got it" to begin.',
      onEnter: function () {
        hideRemote();
        if (!loadTutorialSequence()) {
          if (typeof MizeDialog !== 'undefined') MizeDialog.alert('Something is wrong with the tutorial’s built-in reference data: the play to present could not be read. This shouldn’t normally happen since it’s embedded in the app itself.');
        }
      },
      highlight: '#tutorialAcknowledgeBtn',
      validate: { type: 'custom', fn: acked },
      autoComplete: function () { var b = $('tutorialAcknowledgeBtn'); if (b) b.click(); }
    },

    /* ---------------------------------------- Lesson 1 · enter Presentation Mode */
    { // 1
      instruction: 'A play is on the board. To show it to your team full-screen, open the Menu: tap the Menu tab at the right edge of the screen.',
      bannerSide: 'left',
      highlight: '#sidebarToggleTab',
      validate: { type: 'custom', fn: function () { return menuOpen() || inPresentation(); } },
      autoComplete: function () { if (!click('#sidebarToggleTab')) openMenu(); }
    },
    { // 2
      instruction: 'Tap Presentation.',
      bannerSide: 'left', skipDimPhase: true, useShadeHighlight: true,
      highlight: '.cmdCategory[data-cat="present"] .cmdCatHeader',
      allowedSelectors: '#controlsPanel', // the whole Menu, so it can still be scrolled on a small screen (same trade the First Coaching Session makes)
      validate: { type: 'custom', fn: function () { return presentCategoryOpen() || inPresentation(); } },
      // Deferred: the Skip button's own click bubbles to the Studio's
      // document-level "click outside a category closes it" handler, which
      // would shut the category the very same tick this opens it.
      autoComplete: function () { setTimeout(function () { reveal('#presentationBtn'); }, 0); }
    },
    { // 3
      instruction: 'Tap Presentation Mode.',
      bannerSide: 'left', skipDimPhase: true, useShadeHighlight: true,
      onEnter: function () { reveal('#presentationBtn'); },
      highlight: '#presentationBtn',
      allowedSelectors: ['#presentationBtn'],
      validate: { type: 'custom', fn: inPresentation },
      autoComplete: function () { if (!inPresentation() && typeof togglePresentation === 'function') togglePresentation('fit'); }
    },
    ack('You are presenting. The editing tools are gone and the studio backdrop with its stage lights is on.\n\nThis opening view is the Panorama: all three screens side by side, with the board in the middle.\n\nA short intro jingle plays each time you enter; you can mute it in the Menu under Presentation → Presentation Sound.\n\nThe Menu tab stays at the edge of the screen, so every tool in this tutorial is one tap away.', { bannerSide: 'left', skipDimPhase: true }),

    /* ------------------------------------------------ Lesson 2 · the three screens */
    { // 5
      instruction: 'The three screens: a video screen on the left, the board in the middle, and a stats screen on the right. Tapping a screen moves the camera to it; the arrows at the edges turn the camera too, and the row of dots at the top shows where it is. The ring at the end of that row brings the Panorama back.\n\nTap the right arrow to turn to the stats screen.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: '#studioNavRight',
      validate: { type: 'custom', fn: function () { return frameIdx() === 2; } },
      autoComplete: function () { if (typeof goToStudioFrame === 'function') goToStudioFrame(2); }
    },
    ack('This screen holds an image, a PDF or a website — a stats sheet, for instance. The video screen on the other side holds a video or a video page.\n\nLoading content onto these two screens is a Pro function. The screens themselves and the camera moves are part of the Free version.', { bannerSide: 'left', skipDimPhase: true }),
    { // 7
      instruction: 'Tap the left arrow twice to swing past the board to the video screen.',
      bannerSide: 'right', skipDimPhase: true,
      highlight: '#studioNavLeft',
      validate: { type: 'custom', fn: function () { return frameIdx() === 0; } },
      autoComplete: function () { if (typeof goToStudioFrame === 'function') goToStudioFrame(0); }
    },
    { // 8
      instruction: 'Tap the right arrow to return to the board.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: '#studioNavRight',
      validate: { type: 'custom', fn: function () { return frameIdx() === 1; } },
      autoComplete: function () { if (typeof goToStudioFrame === 'function') goToStudioFrame(1); }
    },

    /* ---------------------------------------------- Lesson 3 · playing the frames */
    ack('The play on the board has several frames. In Presentation Mode you step through them with the Remote Control at the bottom of the screen: ⏮ jumps back to the first frame, ◀ and ▶ step one frame at a time, and the large ▶ Play runs the whole sequence.', {
      bannerSide: 'left', skipDimPhase: true,
      onEnter: function () { showRemote(); if (typeof currentFrame === 'number' && currentFrame !== 0 && typeof loadFrame === 'function') loadFrame(0); }
    }),
    { // 10
      instruction: 'Tap ▶ Play and watch the play run to its last frame.',
      bannerSide: 'left', skipSuccessMessage: true, skipDimPhase: true,
      onEnter: function () { showRemote(); },
      // The Play button is two halves while idle (◀ reverse | ▶ forward) and
      // one Pause button while playing; the ring goes on the forward half
      // only, which is the one the instruction names.
      highlight: function () { return isPlaying() ? null : '#tcPlayForwardHalf'; },
      allowedSelectors: function () { return isPlaying() ? '#tcPlayPauseBtn' : '#tcPlayForwardHalf'; },
      validate: { type: 'custom', fn: function () { return lastFrame() > 0 && currentFrame === lastFrame() && !isPlaying(); } },
      autoComplete: function () {
        if (isPlaying()) return;
        if (typeof animateToFrame === 'function') { playing = true; var target = lastFrame(); animateToFrame(target, 1.0, function () { currentFrame = target; playing = false; if (typeof syncPlayPauseUI === 'function') syncPlayPauseUI(); if (typeof renderFrames === 'function') renderFrames(); }); }
        else if (typeof loadFrame === 'function') loadFrame(lastFrame());
      }
    },
    { // 11
      instruction: 'Tap ⏮ to jump back to the first frame.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: '#tcRewindToStartBtn',
      validate: { type: 'custom', fn: function () { return currentFrame === 0 && !isPlaying(); } },
      autoComplete: function () { if (typeof loadFrame === 'function') loadFrame(0); }
    },
    { // 12
      instruction: 'Tap ▶ Next Frame once. Stepping one frame at a time is how you talk your team through a play one movement at a time.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: '#tcNextFrameBtn',
      validate: { type: 'custom', fn: function () { return currentFrame >= 1 && !isPlaying(); } },
      autoComplete: function () { if (typeof loadFrame === 'function') loadFrame(1); }
    },

    /* ------------------------------------------------------ Lesson 4 · spotlight */
    { // 13
      instruction: 'Now put a spotlight on the board. Open the Menu.',
      bannerSide: 'left', skipDimPhase: true,
      onEnter: function () { hideRemote(); },
      highlight: '#sidebarToggleTab',
      validate: { type: 'custom', fn: function () { return menuOpen() || spot().armed; } },
      autoComplete: function () { if (!click('#sidebarToggleTab')) openMenu(); }
    },
    { // 14
      instruction: 'Spotlight sits under Presentation → Coaching & Display Tools. Tap Spotlight.',
      bannerSide: 'left', skipDimPhase: true, useShadeHighlight: true,
      onEnter: function () { reveal('#spotlightToggleBtn'); },
      highlight: '#spotlightToggleBtn',
      allowedSelectors: '#controlsPanel',
      validate: { type: 'custom', fn: function () { return !!spot().armed; } },
      autoComplete: function () { if (!spot().armed && typeof armSpotlight === 'function') armSpotlight(); }
    },
    { // 15
      instruction: 'Close the Menu with ✕, then tap the board where the spotlight should be.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: function () { return menuOpen() ? '#closeSidebarBtn' : '#board'; },
      allowedSelectors: ['#closeSidebarBtn', '#spotlightOverlay'],
      validate: { type: 'custom', fn: function () { return !!spot().placed; } },
      onValidated: function () { spotStart = { x: spot().x, y: spot().y, r: spot().r }; },
      autoComplete: function () { closeMenu(); var c = boardCenter(); if (typeof placeSpotlight === 'function') placeSpotlight(c.x, c.y); }
    },
    { // 16
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
    { // 17
      instruction: 'To switch the spotlight off, tap one of the stage lights above the board — or tap Spotlight in the Menu again.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: function () {
        var lights = visibleStageLights();
        if (lights.length) return lights;
        return menuOpen() ? '#spotlightToggleBtn' : '#sidebarToggleTab'; // no stage lights on this screen size: fall back to the Menu route
      },
      allowedSelectors: function () { return visibleStageLights().concat(['#sidebarToggleTab', '#controlsPanel']); },
      validate: { type: 'custom', fn: function () { var s = spot(); return !s.armed && !s.placed; } },
      onValidated: function () { closeMenu(); },
      autoComplete: function () { if (typeof disarmSpotlight === 'function') disarmSpotlight(); closeMenu(); }
    },

    /* ----------------------------------------------------- Lesson 5 · shot clock */
    { // 18
      instruction: 'A shot clock on the board makes a drill feel like a game. Open the Menu.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: '#sidebarToggleTab',
      validate: { type: 'custom', fn: function () { return menuOpen() || !!clock().active; } },
      autoComplete: function () { if (!click('#sidebarToggleTab')) openMenu(); }
    },
    { // 19
      instruction: 'Tap Shot Clock, right next to Spotlight under Coaching & Display Tools.',
      bannerSide: 'left', skipDimPhase: true, useShadeHighlight: true,
      onEnter: function () { reveal('#shotClockToggleBtn'); },
      highlight: '#shotClockToggleBtn',
      allowedSelectors: '#controlsPanel',
      validate: { type: 'custom', fn: function () { return !!clock().active; } },
      autoComplete: function () { if (!clock().active) click('#shotClockToggleBtn'); }
    },
    { // 20
      instruction: 'The Shot Clock panel opens. Tap Start.',
      bannerSide: 'right', // Start sits at the panel's left; on a phone the panel is full-width, so the banner keeps to the right skipDimPhase: true, useShadeHighlight: true,
      highlight: '#shotClockStartBtn',
      allowedSelectors: '#shotClockPanel',
      validate: { type: 'custom', fn: function () { return !!clock().running; } },
      autoComplete: function () { if (!click('#shotClockStartBtn') && typeof startShotClock === 'function') startShotClock(); }
    },
    { // 21
      instruction: 'Tap OK to close the panel, then close the Menu. The clock keeps counting in the corners of the board.',
      bannerSide: 'right', skipDimPhase: true, useShadeHighlight: true,
      highlight: function () { return panelOpen('shotClockPanel') ? '#shotClockOkBtn' : (menuOpen() ? '#closeSidebarBtn' : null); },
      allowedSelectors: ['#shotClockOkBtn', '#closeSidebarBtn'],
      validate: { type: 'custom', fn: function () { return !panelOpen('shotClockPanel') && !menuOpen(); } },
      autoComplete: function () { if (typeof closeToolPanels === 'function') closeToolPanels(); closeMenu(); }
    },
    ack('In that panel you also set the seconds, put the clock at the top of the screen instead of in the corners, and reset it. Counting up and syncing the clock to a play’s duration are Pro functions.\n\nTo remove the clock, tap Shot Clock in the Menu again.\n\nUnder the same Coaching & Display Tools you will find 3D View, which tilts the field like a stadium camera, with a slider for the angle.', { bannerSide: 'left', skipDimPhase: true }),

    /* ------------------------------------------------------------ Lesson 6 · exit */
    { // 23
      instruction: 'Time to go back to editing. Open the Menu.',
      bannerSide: 'left', skipDimPhase: true,
      highlight: '#sidebarToggleTab',
      validate: { type: 'custom', fn: function () { return menuOpen() || !inPresentation(); } },
      autoComplete: function () { if (!click('#sidebarToggleTab')) openMenu(); }
    },
    { // 24
      instruction: 'Under Presentation, the button that brought you here now reads Exit Presentation. Tap it.',
      bannerSide: 'left', skipDimPhase: true, useShadeHighlight: true,
      onEnter: function () { reveal('#presentationBtn'); },
      highlight: '#presentationBtn',
      allowedSelectors: '#controlsPanel',
      validate: { type: 'custom', fn: function () { return !inPresentation(); } },
      autoComplete: function () { if (inPresentation() && typeof togglePresentation === 'function') togglePresentation(); }
    },
    ack('You are back in editing, and the board is as you left it.\n\nOn a computer, Esc also leaves Presentation Mode, the ← → keys move between the three screens, and 0 1 2 3 jump to the Panorama, video, board and stats screens.\n\nEverything you used — Presentation Mode, the three screens, the Remote Control, the spotlight and the shot clock — is part of the Free version.', { bannerSide: 'left', skipDimPhase: true })
  ];
}

/* ------------------------------------------------------------------- start */
function start() {
  if (typeof startTutorial !== 'function') { console.error('Presentation tutorial: the Studio tutorial engine (startTutorial) is not available.'); return false; }
  if (running) exit();
  if (typeof xquixHideHome === 'function') safe(xquixHideHome);
  if (typeof closeToolPanels === 'function') safe(closeToolPanels);
  snapshot();
  // The engine's own reset assumes the editing view; entering from inside a
  // presentation would leave the modal Menu and the widened field in the way.
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
