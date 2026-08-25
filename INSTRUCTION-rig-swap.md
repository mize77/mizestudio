# Instruction for the Studio chat — the player rig was never updated

Copy from "The pose resolver" to the end.

---

The pose resolver in `index.html` is current — thank you, both edits landed. The
**player rig above it is still the original**, and that is what is wrong on the
board. Checked against `index.html` as of 05:55 (2,735,210 bytes):

| | in `index.html` now | should be |
|---|---|---|
| `MIZE.PlayerRig.setAngles.length` | **2** | 3 |
| `MIZE.PlayerRig.getElev` | **undefined** | function |
| `poseBox` | **absent** | present |
| `endsWith('_R') ? -1 : 1` | **3 occurrences** | 0 |

Three consequences, all of which the coach is seeing at once:

1. **The right-side mirror is still in.** His left and right variants of the same
   pose are authored as exact mirrors; with that flip they render 25–46 % of
   inked pixels apart. A right-arm carry and a left-arm carry come out as two
   unrelated shapes. It also flattens the freestyle kick, whose `hip_L: -40 /
   hip_R: +40` is the scissor.
2. **No `poseBox`,** so a posed limb is still cropped at the rest-pose rectangle —
   the ball carrier's forearm is cut off and the ball floats clear of it.
3. **`setAngles` takes two arguments,** so the third one the current resolver
   passes — limb elevation — is silently dropped. Elevation does nothing at all.

Together these are why he reports the board "showing outdated poses instead of my
file". His library *is* loaded and correct — 25 poses, `Ball protection - right
arm` present, no placeholder poses anywhere. They are simply being drawn by the
old renderer.

## The fix

Replace the inlined player rig with:

    ~/Documents/mizestudio/xquix-player-rig.js
    83,466 bytes   md5 8be17ad6e4c18e2f1b771cdbea7a9564

**Start** at the banner:

```
/* =====================================================================
 * XquiX Studio — player rig renderer
```

**End** at the `})();` immediately followed by the next banner,
`XquiX Studio — pose resolver`. Its last lines are:

```js
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
```

In that copy the span is lines **25579–26248**. Match the anchors, not the
numbers.

Nothing else changes — the resolver below it and the `REAL_POSE_LIBRARY` block
below that both stay exactly as they are.

## Please do not re-apply the mirror

It was a reasonable read of a real symptom, and the write-up was precise enough
to find the actual cause quickly. But the cause was the crop, not the sign: the
`viewBox` was the rest pose's rectangle, so a raised forearm fell outside it and
was cut, and `handOffset` kept placing the ball at a wrist that was no longer
drawn. Negating the right side happened to swing that one arm back inside the
box — it fixed the framing by drawing a different pose. `poseBox` sizes the box to
the pose instead, centred on the artwork centre so nothing moves or rescales.

## Check afterwards

```js
MIZE.PlayerRig.setAngles.length          // 3
typeof MIZE.PlayerRig.getElev            // 'function'
MIZE.PoseResolver.getLibrary().poses.length   // 25
```

Then put a treading player on the ball with `ballHand = 'right'`: the forearm
should be drawn in full with the ball at the end of it, and switching `ballHand`
to `'left'` should give a clean mirror image rather than a different shape.

## Why uploading the files does not do anything by itself

`index.html` has no `<script src="xquix-player-rig.js">` and no
`<script src="xquix-pose-resolver.js">` — I checked, both are zero. Everything is
inlined, so a newer file sitting in the folder is never read and the coach cannot
tell whether an upload took effect.

That is worth changing. Two `<script src>` lines and deleting the two inlined
blocks would mean he updates the rig or the resolver by replacing a file, with no
edit to a 2.7 MB document and no chance of a paste landing short. If you would
rather keep them inlined, that is fine — but then every change to them has to be
relayed back through this chat, and it needs saying out loud so nobody assumes an
upload was enough.
