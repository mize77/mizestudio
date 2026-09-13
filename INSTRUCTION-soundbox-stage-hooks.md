# Sound Box → Stage: host callback contract

*From the Sound Box chat for the Studio chat, 2026-09-12, closing brief
`SOUNDBOX-STAGE-HOOKS`. Module: `xquix-sound-studio.js` (rebuilt; 48 KB;
30 headless checks green, 9 of them for these hooks).*

The module now exposes three optional host callbacks. Set them in the config
block that already sets `getAccessToken` and `onExit`, before `start()`. Any
of them may be left `null`; each is wrapped in `try/catch`, so a throwing
host never stops the music.

```js
MIZE.SoundStudio.onExit        = function () { /* show Home again */ };
MIZE.SoundStudio.onTrackChange = function (t) { /* new track started */ };
MIZE.SoundStudio.onBeat        = function (b) { /* one beat */ };
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
  coverKey:   null,                    // see "About cover art"
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
resumes and keeps counting; **‹ Home** stops them for good.
