# Sound Box → Stage: host callback contract

*From the Sound Box chat for the Studio chat, 2026-09-12, closing brief
`SOUNDBOX-STAGE-HOOKS`. **Revised the same day (round 2)** after the Studio's
first stage build: adds `config.mount`, `config.background`, `onLevel` and
`analyser()`. Module: `xquix-sound-studio.js` (rebuilt; 68 KB; 66 headless
checks green plus two real-audio tests).*

## Round 6 (2026-09-20) — the route is decided at play time, never trusted

Mac Safari: everything ran, the speaker icon lit, no sound; iPhone fine. Cause
class: the two `<audio>` elements were tied to a Web Audio `AudioContext`
(for `onLevel`) that was not `running` when the track started — Safari lets
the element "play" but the graph outputs silence, and `resume()` from a timer
never settles. `prime()` alone cannot prevent this: seconds pass between the
tap and `play()`.

Now, in `play()`/`playIndex` for every track:

1. `resume()` is awaited with a 700 ms cap.
2. Only if the context reports `running` are the elements routed through it
   (`onLevel` live).
3. If it does not, the track plays on the plain element — full sound, no
   analysis this session — and the console says
   `[SoundStudio] AudioContext is 'suspended' at play time — playing without analysis`.
4. If the elements were already routed (a later track, a context that
   dropped out mid-session) and the context refuses, the player swaps to
   fresh unrouted elements at the same position and continues; message
   `…switching to fresh unrouted elements`.
5. 1.5 s after each start, `currentTime` is checked; a stalled track is
   logged with `readyState`, `networkState`, media `error`, `ctx`, `muted`,
   `volume`, and the swap in (4) is applied if the context is the reason.

Music first, meters second. The stage should treat `onLevel` as optional per
session and keep its `onBeat`/idle animation as the fallback — on a browser
that will not run the context, that is what it gets. `route-test.mjs`
simulates a context that never resumes (62 + 4 checks green).

`prime()` stays: it is still what unlocks the elements for a timer-started
`play()`; call it in the tap that leads to playback.

## Round 5 (2026-09-16) — `prime()`: playback that starts from a timer

The Studio's countdown calls `MIZE.SoundStudio.play()` at count 0, from a
`setTimeout`, not from the athlete's tap. Safari (and iOS in particular)
blocks two things outside a user gesture: `HTMLMediaElement.play()` on an
element that has never played, and creating/resuming an `AudioContext`. So
the session built, the countdown ran, `play()` was invoked — and nothing
played. **Two blockers, not one**; the analyser context alone would not
explain it.

```js
// in the handler of the tap that starts the countdown — synchronously, before any await/setTimeout
MIZE.SoundStudio.prime();
// … later, from the countdown timer:
MIZE.SoundStudio.play();
```

`prime()` plays and immediately pauses a 10 ms silent clip on both of the
module's `<audio>` elements while the gesture is live (that marks them as
user-started for the rest of the page's life), and creates and resumes the
analyser's `AudioContext` inside the same gesture. It is idempotent and
cheap; calling it on every tap that could lead to playback is fine. The
overlay's own Start button now calls it too. Returns `false` if the overlay
is not open (call `start()` first).

Also new: when the browser refuses `play()`, the module no longer swallows
it — the console shows `[SoundStudio] play() was blocked by the browser
(NotAllowedError)…` naming this fix. Look for that line first when "no
audio" comes up again.

About the `coaching_assets` 400s reported alongside: **not the module's** —
it only ever calls `sound_collections`, `sound_functions`, `sound_tracks`,
`sound_sessions` and `sound.xquix.com`. That request is the Studio's own.
It matters only if it throws inside the same handler and aborts the
countdown before `play()` runs; the console warning above is how to tell
the two apart.

## Stage FX (2026-09-14) — fog machine + two lasers, `xquix-stage-fx.js`

MIZE rejected the stage's CSS fog and asked for the look of a real fog
machine photographed on a black stage (reference image in the Sound Box
chat: black ground, a concentrated jet that mushrooms and drifts, two thin
teal lasers from the lower corners to the apex, bright only where fog
scatters them). The Sound Box chat built it as its own module so the Studio
can drop it in behind the screen. **One WebGL fragment shader**, no sprites,
no CSS blur: domain-warped fbm noise advected upward, an emission history so
bursts rise as real puffs, a fast jet column that lets go into the plume,
settled fog along the floor, and beams whose halo is literally the fog
density they pass through. Black stays black.

```html
<script src="xquix-stage-fx.js"></script>
```
```js
const fx = MIZE.StageFX.attach(stageEl, {          // inserts a <canvas> absolute inset:0 into stageEl (position:relative)
  // Up to three fog outlets. x/y in 0..1 from left / from bottom — put each on a machine's nozzle
  // in your scene; lean in degrees (+ = blows toward the right). MIZE 2026-09-14: the fog must
  // visibly come from the outlets, so the default is one centre machine straight up and one on
  // each side blowing in toward the stage.
  sources: [{ x: 0.50, y: 0.10, lean: 0 }, { x: 0.10, y: 0.10, lean: 32 }, { x: 0.90, y: 0.10, lean: -32 }],
  spread:  0.75,                                   // how wide a plume opens with height; 1.25 is the old single-outlet look
  beams:   [[0.045, 0.085, 0.50, 1.02], [0.955, 0.085, 0.50, 1.02]],   // x0,y0,x1,y1 per laser
  teal:    [0.0, 0.84, 0.72],                      // XquiX teal
  haze:    0.30,                                   // residual fog when the machines are idle (0 = pitch black between bursts)
  resolutionScale: 0.6,                            // render scale × devicePixelRatio; 0.5 on phones is fine
});
fx.burst(seconds = 2.5, strength = 1, outlet?);   // the machines fire — all, one index (0 = centre), or a list [1, 2]
fx.set({ energy: 0..1, hit: true, laser: 0..1.5, haze, sources, spread, beams, rise });
fx.destroy();
```

Each outlet has its own emission history and turbulence phase, so `burst(3, 1,
[1, 2])` sends the side machines only, `burst(2, 0.7, 0)` the centre one.
Three outlets cost about the same as one — a plume is only evaluated near
its own axis.

Wire it to the music: `onLevel(l) → fx.set({ energy: l.level, hit: l.hit })`
(hits flare the beams for a moment; energy warms the fog), and fire
`fx.burst(3)` on `onTrackChange` for `role` **activate / launch** and a
shorter `burst(1.5, 0.6)` on **meet**; leave the rest to the haze so the
black space stays. Returns `null` when WebGL is unavailable — keep the old
stage as the fallback in that case.

Verified headlessly (`stagefx-test.mjs`, 8 checks): black space at idle, a
burst brightens the scene without filling the frame, `set()` and
`destroy()` behave. Rendered frames against the reference are in the chat;
a live preview is published as the "XquiX Stage FX" artifact. Harness:
`stagefx-harness.html`. Cost: one density evaluation per pixel (≈ 23 noise
lookups), rendered at 0.6 × DPR — light enough for a phone, but **measure on
an iPhone** before making it the default; drop `resolutionScale` to 0.45 if
the Sound Box UI stutters.

Known gap versus the reference still: the reference is a rendered still with
finer billow detail; ours trades some of that for real-time cost. If MIZE
wants it closer, the next lever is a second, finer noise octave on desktop
only (`opts.detail`), not sprites.

## Round 4 (2026-09-13) — transport: the stage drives the player

For a stage that draws its own play button after the questions and its own
play/pause/skip controls. Module 61 KB, 60 headless checks green.

```js
// Callbacks — set before start(), both optional
MIZE.SoundStudio.onSessionBuilt = function (s) { /* show the stage's Play */ };
MIZE.SoundStudio.onPlayState    = function (st) { /* swap play/pause icon, etc. */ };

// Transport — call from the stage's own controls
MIZE.SoundStudio.play();         // before Start: begins the session at track 1; when paused: resumes; when playing: nothing
MIZE.SoundStudio.pause();
MIZE.SoundStudio.togglePlay();   // before Start behaves like play()
MIZE.SoundStudio.next();
MIZE.SoundStudio.prev();         // >5 s into a track restarts it, otherwise goes back one (same as the overlay's ⏮)
MIZE.SoundStudio.state();        // current state object, same shape as onPlayState
MIZE.SoundStudio.session();      // the built session, same shape as onSessionBuilt, or null
```

`onSessionBuilt(s)` fires once, right after **Build my session** produced a
plan and before the athlete has pressed Start:

```js
{
  feeling: "nervous", situation: "game", minutes: 20,
  total: 6, durationS: 1187,
  plan: [
    { trackIndex: 1, trackId: "xquix-sound.identity", function: "Identity", role: "transform",
      durationS: 205, activity: "…one short suggestion or null…", coverKey: "covers/xquix-sound-bd0ac60c.webp" },
    …
  ]
}
```

`onPlayState(st)` fires on every change of the following and never twice
with the same values; `state()` returns the same object on demand:

```js
{ open: true, built: true, started: true, ended: false,
  playing: true, paused: false, trackIndex: 3, total: 6 }
// trackIndex is 0 before Start and after the session ends
// after exit(): open false, everything else false/0
```

Every transport call is a safe no-op when the overlay is closed, when no
session is built (`next()`, `pause()`, `prev()` before Start do nothing), or
when the athlete is on the Library tab with nothing playing. The overlay
stays in sync — its own Start button disappears when the stage calls
`play()`, its row highlight follows `next()`/`prev()`, and vice versa: the
athlete tapping the overlay's controls reaches the stage through
`onPlayState` and `onTrackChange`. A stage that draws its own controls may
hide the overlay's player bar with `#xqSoundStudio .xqss-player{display:none}`
from its own stylesheet — that rule is stable and outside the module's
reset.

Note a session played from the **Library** tab (a single track) also reports
through `onPlayState` (`built` may be false there); `onSessionBuilt` is only
for built sessions.

## Round 3 (2026-09-13) — one question per screen

Not a stage hook, but shipped in the same module: the session questions now
come **one at a time** — *How do you feel?* → *What's ahead?* → *How long?*
(→ *Sound*, only when more than one collection is usable) → **Build my
session**. Each answer advances; answered questions collapse into a row of
small chips above the current one, and tapping a chip reopens that question.
`config.questions = "all"` restores the single page. Nothing for the Studio
to wire; the fixed-position and mount behaviour is unchanged. If the stage
places the screen box, note the ready screen is short — the build button sits
just under the trail.

## Round 2 — what changed and why

Two of the problems reported after the first stage build were the module's,
not the stage's:

1. **"The screen covers the rest of the scene."** It had to: the overlay was
   `position:fixed; inset:0; z-index:100000` by construction, and no CSS
   override from the host could survive `start()` re-injecting its style.
   Now `config.mount` renders the overlay *inside* an element the host owns.
2. **"Not related to the beat and rhythm of the real song."** `onBeat` is a
   metronome derived from a stored BPM — 23 of 42 tracks have none, some
   readings are double-time, and it is not phase-aligned to the audio. It
   was never going to feel like the music. `onLevel` is the real signal: a
   Web Audio analyser on the playing track, every animation frame, with a
   per-frame onset flag. Build the stage on `onLevel`; keep `onBeat` as a
   fallback only.

The visual side — SVG versus canvas, lasers, fog, spotlight geometry — is
the Studio's and the Studio chat's diagnosis of it is right.

### One thing MIZE must do before `onLevel` works: CORS on the bucket

A cross-origin `<audio>` only feeds Web Audio when the file's response
carries CORS headers; without them the analyser hears silence. Cloudflare
dashboard → R2 → `xquix-sound` → **Settings** → **CORS Policy** → Add:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 86400
  }
]
```

`*` is fine: the bucket is public-read already and CORS never restricts
plain playback. The module probes this once at `start()` (a 2-byte range
request for a track). If the probe fails, `onLevel` stays silent, the music
plays exactly as before, and one console warning names this fix.

**Set 2026-09-13 and verified from `app.xquix.com`**: tracks and covers
answer with CORS. One exception: `covers/xquix-sound-bd0ac60c.webp` was
edge-cached before the policy existed and still answers without the
headers until purged (Cloudflare → Caching → Purge by URL) or expired.
Covers loaded as plain `<img>` are unaffected; only a `crossorigin` image or
`fetch` of that one URL fails meanwhile.

### Mounting inside the stage

```js
MIZE.SoundStudio.config.mount      = "#stageScreen";   // element or selector; the host sizes it and gives it position:relative
MIZE.SoundStudio.config.background = "transparent";    // or any CSS colour; default "#0b0f14"
MIZE.SoundStudio.start();
```

With `mount` set, the overlay is appended to that element with class
`xqss-embedded` and `position:absolute; inset:0; z-index:auto`, so it fills
whatever box the stage gives it — the screen region of the scene — and
nothing else. The host owns everything outside that box: the canvas, the
z-order, the Home button placement if it wants its own. The overlay's own
**‹ Home** still calls `exit()` → `onExit()`. Without `mount` the behaviour is
unchanged (full-viewport overlay).

Set `mount` before every `start()` (it is read at start), and keep the mount
element in the DOM for the life of the session — the module does not
re-parent on resize; the box may change size freely.

### `onLevel(l)` — every animation frame while music plays

```js
MIZE.SoundStudio.onLevel = function (l) { /* ~60 × per second */ };
{
  bass:  0.54,   // 20–150 Hz   } each 0…1, smoothed a little, mapped onto the
  mid:   0.49,   // 150–2000 Hz } range the normalised catalogue actually spans
  high:  0.53,   // 2–8 kHz     } — relative, for motion, not calibrated physics
  level: 0.22,   // RMS of the waveform, 0…1
  hit:   false,  // true on this frame only: a transient in the kick band (30–180 Hz)
  t:     41.7    // currentTime of the playing element, seconds
}
```

`hit` is a spectral-flux onset detector (rising edge over running mean +
1.8 σ, 200 ms refractory). On a synthetic 120 BPM kick it fires once per
kick at 500 ms ± 2 ms. On real tracks it fires on what the ear would call
the pulse: Patience (stored 128 BPM) produced ~129 hits per minute; Forward
(120) ~130; Velocity (147) ~157. It is a hit detector, not a tempo tracker —
it will also fire on a fill. Use it for the flash; use `bass` for the
sustained glow; use `level` for overall brightness.

Frames stop on pause and resume on play; none after `exit()`. Set
`onLevel` **before** `start()` — that is what turns analysis on
(`config.analyse: "auto"`); `true`/`false` force it either way.

### `analyser()` — the raw node

Returns the live `AnalyserNode` (fftSize 2048, no smoothing) once a track is
playing with analysis on, otherwise `null`. For a stage that wants its own
FFT drawing (a spectrum, a waveform), call `getByteFrequencyData` on it in
the same rAF loop. Do not connect or disconnect anything on it.

### Caveats the Studio should test on a phone

- **iOS and locked screens.** Routing the element through Web Audio is
  standard, but iOS has a history of suspending `AudioContext` when the
  screen locks, which would silence a session an athlete is listening to on
  the bus. The module cannot un-route once connected. **Test a session on an
  iPhone with the screen locked before shipping `onLevel`.** If it breaks,
  set `config.analyse = false` on touch devices and fall back to `onBeat`;
  the Sound Box chat will then move analysis behind a "stage visible" switch.
- The analyser hears the crossfade (both elements feed one node), which is
  what a stage should see anyway.
- Nothing else changed: `onTrackChange`, `onBeat`, the UI, the builder.

---

## Round 1 (2026-09-12, unchanged)

The module exposes optional host callbacks. Set them in the config block
that already sets `getAccessToken` and `onExit`, before `start()`. Any of
them may be left `null`; each is wrapped in `try/catch`, so a throwing host
never stops the music.

```js
MIZE.SoundStudio.onExit        = function () { /* show Home again */ };
MIZE.SoundStudio.onTrackChange = function (t) { /* new track started */ };
MIZE.SoundStudio.onBeat        = function (b) { /* one beat */ };
MIZE.SoundStudio.onLevel       = function (l) { /* one animation frame (round 2) */ };
```

## `onTrackChange(t)` — once per track start

Fires when a track actually begins: the first **Start**, every **next /
previous / tap-a-row**, every automatic crossfade completion, and a single
track played from the **Library** tab. Never on `timeupdate`, never on
pause/resume.

```js
{
  title:      "XquiX Studio Forward",  // sound_tracks.title
  function:   "Forward",               // the function's display name (null for Library plays before build — not in practice)
  trackId:    "xquix-sound.forward",
  bpm:        120,                     // sound_tracks.bpm, or null — see "About BPM"
  coverKey:   "covers/xquix-sound-bd0ac60c.webp",   // the collection's cover — see "About cover art"
  coverBase:  "https://sound.xquix.com/",
  trackIndex: 3,                       // 1-based position in the session; 1 for a Library play
  total:      7,                       // plan length; 1 for a Library play
  role:       "transform"              // meet | transform | bridge | activate | launch | close | adversity | library
}
```

Two fields beyond the brief: `function` and `trackId`. The athlete-facing
name on screen is the *function* ("Forward"), not the file title, and the
track id is what a stage cue table would key on. Free to ignore.

## `onBeat(b)` — every beat of a track with a measured BPM

```js
{ beat: 17, bpm: 120 }   // beat is 1-based and resets to 1 on every track start
```

A `setInterval` at `60000 / bpm` ms, started on track start and cleared on
track change, on `stop()`, and on exit. **Two deviations from the brief, both
deliberate:**

1. **The clock pauses when the athlete pauses** and resumes on play without
   resetting the count. A stage that keeps pulsing over silence would be
   wrong; the brief did not address pause. If the Studio wants beats to
   continue through a pause, say so and it is a one-line change.
2. During a **crossfade** (last 3 s of a track) the outgoing track's clock
   keeps running until the fade completes, then the incoming track's clock
   starts at beat 1. The fade is where the two overlap, and the stage should
   stay on the track the ear still hears most.

The interval is not phase-aligned to the audio's first downbeat — it starts
at `play()`. For fixtures that is invisible; for anything that needs sample
accuracy it is not this API.

## About BPM — what the live data actually holds

`sound_tracks.bpm` is a **measured** value from the ingest (onset-grid scoring,
`soundbox/ingest.py`), stored only when the grid caught at least 30 % of the
onsets; otherwise `null`. Today: **19 of 42 tracks carry a BPM**, 23 are
`null`. Among the XquiX Sound collection: Forward 120, Theme 120, Neutral 120,
Depth 125, Steady 125.25, Patience 128, Rise 128, Warmth 129, Momentum 132,
Motion 134, Tension 134, Velocity 147, Master 160, Reflection 166.75 — and
sixteen without. So the Studio's own 500 ms fallback timer will run for
roughly half of every session; that is expected, not a bug. Several of the
stored values are half- or double-time readings of dense material (Reflection
at 166.75 is more plausibly 83), so a fixture that must not flail on a wrong
tempo should treat `bpm > 150` with suspicion or halve it.

## About cover art — deviation from the brief

The brief expects `sound_tracks.cover_key`. **There is no such column.** Cover
art in this schema lives on the *collection* (`sound_collections.cover_key`),
because artwork is per rendering family, not per track. The module therefore
sends the **collection's** cover key as `coverKey`. As of 2026-09-12 all
seven collections have a cover in R2 (`covers/<collection_id>-<hash8>.webp`,
512×512, transparent background), verified live at `coverBase + coverKey`
(e.g. `https://sound.xquix.com/covers/xquix-sound-bd0ac60c.webp`). The stage
should still keep a default circle for the `null` case — a collection added
later may not have art yet.

## What did not change

`start`, `exit`, `isOpen`, `config`, `onExit`, the UI, the builder. Rows in
the session plan gained `bpm` (from the builder) and `cover_key` (from the
collection, added at build time in the module).

## Verified in the harness

Callbacks unset → no errors. Set → exactly one `onTrackChange` on Start, one
per next; none on `timeupdate`. Identity (no BPM) → zero beats. Forward (120)
from the Library → beats at 500 ms, `beat` 1, 2, 3…; pause stops them; play
resumes and keeps counting; **‹ Home** stops them for good. Round 2:
`coverKey` carries the collection's key; `analyser()` live after the CORS
probe, `null` after exit; `onLevel` frames while playing, none after exit;
mounted overlay fills a 300×400 host box as `position:absolute` with a
transparent background; without CORS → `analyser()` null, no frames, one
warning, playback untouched. `level-test.mjs`: real decode of a synthetic
120 BPM kick served cross-origin with CORS → 8 hits at 500 ms.
