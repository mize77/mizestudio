# Sound Box → Stage: host callback contract

*From the Sound Box chat for the Studio chat, 2026-09-12, closing brief
`SOUNDBOX-STAGE-HOOKS`. **Revised the same day (round 2)** after the Studio's
first stage build: adds `config.mount`, `config.background`, `onLevel` and
`analyser()`. Module: `xquix-sound-studio.js` (rebuilt; 58 KB; 48 headless
checks green plus two real-audio tests).*

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
