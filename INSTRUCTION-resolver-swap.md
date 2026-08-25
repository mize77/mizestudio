# Instruction for the Studio chat — revised pose resolver

Copy everything below this line into the Studio chat.

---

Please swap in the revised pose resolver and remove the swim-continuity patch it
makes unnecessary. Two edits to `index.html`, both in the inlined block region.

## The file

    ~/Documents/mizestudio/xquix-pose-resolver.js
    23,255 bytes   md5 000127e0055e569bfbbd32b84c8f5227

Read it from disk — it is already there and current.

## Edit 1 — replace the inlined resolver

Replace the whole inlined resolver IIFE with the contents of that file.

**Start** at the banner line:

```
/* =====================================================================
 * XquiX Studio — pose resolver
```

**End** at the `})();` that closes it — the one immediately followed by the next
banner, `Loads the real, coach-authored pose library`. Its last three lines are:

```js
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
```

In the copy I read (2,742,934 bytes, modified 05:16) that span was lines
**26251–26727**. Treat the line numbers as a cross-check only; the anchors above
are what to match.

**Do NOT touch the block that follows it** — the `REAL_POSE_LIBRARY` constant and
its `loadIt()` loader. That block is correct and holds the coach's current
library (25 poses, 6 cycles). It stays exactly as it is.

## Edit 2 — delete the swim-continuity block

Inside the Live Animation IIFE, delete the block that starts:

```js
  /* -----------------------------------------------------------------
   * Swim continuity across frame boundaries.
```

and ends with the `setInterval(..., POLL_MS);` that releases the overrides on
playback stop — the one just before that IIFE's closing `})();`. That removes
`SWIM_CYCLE_ID`, `MIN_SWIM_DISTANCE_M`, `FRAME_POLL_MS`, `lastSeenFrame`,
`oursNow`, `applySwimContinuity`, and both of its `setInterval`s. In the same
copy that was lines **27444–27535**; keep the `})();` on 27536.

**Keep everything else in that IIFE** — the Pro gate, `allowed()`,
`disableEverything()`, the entitlement `onChange` handler, and the active/still
watcher that starts and stops the resolver. Those are correct and are not
affected.

## Why the patch comes out

Your diagnosis was exactly right, and it pointed straight at the line:
`loadState()` rebuilds every player element, and the resolver's movement history
was keyed by element reference, so it died at every frame boundary.

**That cause is now fixed in the resolver.** `motion` is keyed by
`dataset.label`, which survives the rebuild. Verified by destroying and
recreating the element mid-stroke:

| | before | after |
|---|---|---|
| before the frame boundary | Freestyle stroke | Freestyle stroke |
| immediately after the rebuild | **Horizontal standard** | Freestyle stroke |
| one tick later | Freestyle stroke | Freestyle stroke |

Leaving the patch in as belt-and-braces would cost two things:

**It suppresses most of the coach's library during playback.** `setManual()` sits
above every trigger in `resolve()` — it is the coach's override channel and wins
outright. Pinning every moving horizontal player to one cycle means that while a
play runs, a swimmer carrying the ball, a swimmer with a shot arrow on them, and
a swimmer doing nothing all render the same stroke. The coach has just authored
left- and right-arm variants for shooting, passing, carrying and blocking, and
playback is when he wants to see them. This is the behaviour he reported as "the
Studio suddenly uses the original poses, not mine".

**`SWIM_CYCLE_ID = 'c1'` is a hardcoded id into a file the coach edits.** It
matches his freestyle cycle today only because the export happened to keep that
id. He re-authors this library regularly; the next export can put `c1` elsewhere
or nowhere, and a pin to a missing id fails silently — no error, just a player who
stops animating.

More generally, `setManual` / `getManual` are for the coach's own pins. Using
them as an internal mechanism means the resolver cannot tell a deliberate choice
from a temporary one — which is why that block needed its own `oursNow` set to
avoid stomping real pins. Anything the resolver should do on its own belongs in
the resolver; send it over and it goes in there.

## Check afterwards

In the console:

```js
MIZE.PoseResolver.getLibrary().poses.length     // 25
MIZE.PoseResolver.getLibrary().cycles.length    // 6
MIZE.PoseResolver.coverage()                    // 8 of 14 slots filled, L and R symmetric
MIZE.PoseResolver.getSwimMode()                 // 'moving'
```

Then, with Live Animation on, play a sequence with a swimmer who carries the ball
partway through: the stroke should stay continuous across every frame boundary,
**and** the carrier should show a carry pose rather than stroking through it.

Also confirm these three lines are present, which is the fix itself:

```js
const motion = new Map();
function motionKey(el) { return el.dataset.label || el.dataset.id || ''; }
if (v >= SWIM_MPS) { motion.get(k).until = now + SWIM_HOLD_MS; return true; }
```
