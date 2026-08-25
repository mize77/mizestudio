# Instruction for the Studio chat — limb elevation

Copy from "Please take" to the end.

---

Please take the updated rig and resolver — both add per-joint limb elevation, the
third axis the plan view does not have. Neither needs any new wiring: the files
in `~/Documents/mizestudio/` replace what is inlined today, same two blocks as
before.

    xquix-player-rig.js       81 KB   — the geometry and the depth cues
    xquix-pose-resolver.js    24 KB   — carries elevation through poses and cycles

## What changed and why it is safe

Every joint now carries a second angle: how far it is lifted out of the water, or
pushed under it, measured from the water plane. A tilted bone does not change
direction on screen — it gets shorter, by the cosine of the tilt. That is the
whole of the geometry.

Cosine is even, so 40 degrees up and 40 down foreshorten identically. Depth is
therefore carried by two more things: a raised limb draws **over** the trunk and
keeps its painted colour, a submerged one draws **under** it and is mixed toward
the water.

**A library with no elevation renders exactly as before.** The field is optional
and sparse, absent means flat, and every existing pose is unchanged.

## Contract changes, all additive

| | |
|---|---|
| `PlayerRig.setAngles(el, angles, elev)` | third argument optional; `null` clears |
| `PlayerRig.getElev(el)` | new |
| `PlayerRig.markup(pose, sex, team, label, angles, elev)` | sixth argument optional |
| `el.dataset.rigElev` | new, JSON, beside `rigAngles` |
| `worldJoints(key, angles, elev)` | also returns `out.z`, each joint's height above the surface in rig pixels |

`out.z` is there for the ball: a shot released with the arm up leaves the hand
above the water, and nothing reads it yet. If you want the ball to sit higher or
draw a touch larger on a raised hand, that is the number to use — but please
propose it here first rather than adding it to the rig, so it lands in one place.

## Verified

274 renders — every pose and cycle frame, both sexes, with elevation set on
several — nothing clipped, 19 distinct box sizes, rig cache steady at 54, resolve
pass 1.8 ms median for 14 players, no page errors. Left/right pairs still mirror
at 0 % pixel difference, and coverage is unchanged.

## One thing to watch

`build_board_module.py` generates the rig file from the pose tool's own renderer,
so the tool and the board draw from the same source and cannot disagree about
depth. If you need a change in the renderer, send it here rather than editing the
inlined copy — an edit there is invisible to the generator and will be
overwritten by the next build.
