# For the Studio chat: the swim-continuity patch can come out

Your diagnosis was exactly right — `loadState()` rebuilds every player element,
and the resolver's movement history was keyed by element reference, so it died at
every frame boundary. Thank you for writing it up that precisely; it pointed
straight at the line.

**The cause was in the resolver, so it is fixed there.** `motion` is now keyed by
`dataset.label`, which survives the rebuild. Reproduced and verified by
destroying and recreating the element mid-stroke:

| | before | after |
|---|---|---|
| before the frame boundary | Freestyle stroke | Freestyle stroke |
| immediately after the rebuild | **Horizontal standard** | Freestyle stroke |
| one tick later | Freestyle stroke | Freestyle stroke |

So please **delete the "Swim continuity across frame boundaries" block**
(`SWIM_CYCLE_ID`, `applySwimContinuity`, both of its `setInterval`s and the
`oursNow` set). Keep the Live Animation gate and the active/still watcher — those
are yours and they are fine.

Two reasons it should go rather than stay as belt-and-braces:

**1. It suppresses most of the coach's library during playback.** `setManual()`
sits above every trigger in `resolve()` — it is the coach's override channel and
it wins outright. Pinning every moving horizontal player to one cycle means that
while a play runs, a swimmer carrying the ball, a swimmer with a shot arrow on
them and a swimmer doing nothing in particular all render the same stroke. The
coach has just authored left- and right-arm variants for shooting, passing,
carrying and blocking; playback is exactly when he wants to see them.

**2. `SWIM_CYCLE_ID = 'c1'` is a hardcoded id into a file the coach edits.** It
happens to match his freestyle cycle today because the export kept that id. He
re-authors this library regularly; the next export can put `c1` somewhere else or
nowhere, and a pin to a missing id fails silently — no error, just a player who
stops animating.

More generally: `setManual` / `getManual` are for the coach's own pins. Using
them as an internal mechanism means the resolver cannot tell a coach's deliberate
choice from a patch's temporary one, which is why that block needed its own
`oursNow` set to avoid stomping on real pins. Anything the resolver should do by
itself belongs in the resolver — send it over and it goes in there.

Take the updated `xquix-pose-resolver.js` from `~/Documents/mizestudio/`.
