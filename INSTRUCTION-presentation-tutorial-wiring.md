# INSTRUCTION · Wire the Presentation Mode tutorial into the Studio

*For whoever owns `index.html`, from the Presentation tutorial chat,
2026-09-05. Design and build record: `presentation/PRESENTATION-TUTORIAL.md`.*

`xquix-presentation-tutorial.js` is in the repo root
(`~/Documents/mizestudio/`). Nothing loads it yet. It defines
`window.startPresentationTutorial()` — the hook the Mode Switcher in
`index.html` already probes for — and `MIZE.PresentationTutorial`.

## The edit — one line

After the other module tags (currently around line 21920):

```html
<script src="xquix-game-tracker.js"></script>
<script src="xquix-game-tracker-tutorial.js"></script>
<script src="xquix-presentation-tutorial.js"></script>     <!-- add -->
```

Load order is free: the module calls Studio functions only at start time,
never at load time. It reads `startTutorial`, `togglePresentation`,
`tutorialSequenceFrames`, `frames`, `currentFrame`, `loadFrame`,
`tutorialRevealElement`, `MIZE.State.spotlight`, `MIZE.State.shotClock` and a
few others by bare name — all top-level in `index.html`'s inline script, as the
Game Tracker tutorial already relies on for `frontCourtActive`.

Nothing else changes. Specifically, **do not** touch the Mode Switcher: its
`presenting` first-use branch and its replay button both check
`typeof startPresentationTutorial === 'function'` and switch over by
themselves.

## What becomes reachable

| Where | Before | After |
|---|---|---|
| Switch Mode → **Presenting**, first time | opens Presentation Mode directly, stays unqualified | runs the tutorial; completing or exiting it qualifies the mode |
| Switch Mode → Tutorials → **Presenting** | "The Presenting tutorial is coming soon — check back after Phase 2" | runs the tutorial (replay: qualification unchanged) |

## Optional — a Home banner

Home's Tutorials list has no Presentation banner. If one is wanted, it needs a
banner image from MIZE (700 × 149 WebP, same spec as the Game Tracker set —
`gametracker/TUTORIAL-STORYBOARD.md` §2) and one branch in the
`xquixHomeTutorialSelected` handler:

```js
} else if(tutorial === 'presentation' && typeof MIZE !== 'undefined' && MIZE.PresentationTutorial && typeof MIZE.PresentationTutorial.start === 'function'){
  xquixHideHome();
  closeToolPanels();
  MIZE.PresentationTutorial.start();
```

Not required for the tutorial to ship.

## Verifying by hand

1. Hard-reload. In the console: `typeof startPresentationTutorial` → `"function"`.
2. Put a play of your own on the board (two or more frames), then Switch Mode
   → Tutorials → Presenting. The board is replaced by the tutorial's play;
   Step 1 asks for the Menu.
3. Walk it, or hold Skip to Next Step through all 25. At the end: the
   completion dialog, presentation off, no spotlight, no shot clock, and
   **your own play back on the board on the frame you left it**.
4. Start it again and tap Exit Tutorial mid-way while presenting with a
   spotlight placed. Same clean state, same play restored.

Headless equivalent: `node presentation/presentation-tutorial-test.mjs
~/Documents/mizestudio` (72 assertions).

## Two things noticed on the Studio side — not part of this instruction

- **`#presentationModeHandle` does not exist** in the current DOM but is still
  referenced at CSS line ~102 and JS lines ~11432 and ~11440 (both
  optional-chained, so they no-op). Either the edge tab was removed on
  purpose and the references can go, or it was lost and should come back.
- **Home's *Presenting* circle bypasses the first-use check.** The
  `xquixHomeModeSelected` handler (~4809) calls `togglePresentation('fit')`
  directly, while the Mode Switcher routes through `requestXquiXMode()`. A
  coach who enters from Home never meets the tutorial. If Home should behave
  like the switcher, that is a one-line change there, not here.

## `deploy.sh`

Passes as is: the new file clears `node --check`, and no marker is required
for it. Adding `<script src="xquix-presentation-tutorial.js">` to the
"still loads its modules" list would give it the same protection the other
modules have against an older `index.html` being written back.

Delete this instruction once the tag is in.
