# INSTRUCTION · Wire Sound Studio into `index.html`

*For the Studio chat, from the Sound Box chat, 2026-09-10. Read
`soundbox/ARCHITECTURE.md` §7 for the why; this note is only the what.*

Sound Studio is a finished, self-contained module — `xquix-sound-studio.js`,
46 KB, no dependencies, 21 headless checks green in its harness. It attaches
exactly the way the Game Tracker does. **Five edits, all additive.** Nothing
else in `index.html` changes, and the module never touches Studio state.

Two of the five need a detail only `index.html` can answer (marked **CONFIRM**):
this chat has never had the file and will not guess at its handler names.
Everything else is exact.

---

## 0 · Get the file into the repo

`soundbox/xquix-sound-studio.js` in the project → `~/Documents/mizestudio/xquix-sound-studio.js`
(repo root, next to `xquix-game-tracker.js`). It is generated; do not edit it —
edits go to `soundbox/sound-studio.src.js`, then `python3 build_module.py`.

## 1 · The script tag

After the last module tag (currently `xquix-game-tracker-tutorial.js`, and the
presentation tutorial if that has landed):

```html
<script src="xquix-sound-studio.js"></script>
```

Loading it does nothing visible. It defines `MIZE.SoundStudio` and waits.

## 2 · Tell it how to save sessions — **CONFIRM the accessor**

Directly after the tag:

```html
<script>
  // Sound Studio saves an athlete's session only when it can get the signed-in
  // user's access token. Point this at the Studio's Supabase client.
  MIZE.SoundStudio.config.getAccessToken = async function () {
    try {
      const { data } = await supabase.auth.getSession();   // CONFIRM: the Studio's client variable
      return data && data.session ? data.session.access_token : null;
    } catch (e) { return null; }
  };
  MIZE.SoundStudio.onExit = function () { /* CONFIRM: the call that shows Home again, e.g. xquixShowHome() */ };
</script>
```

If the Studio's client is not a global named `supabase`, use whatever it is —
the module needs only a function that resolves to the JWT string or `null`.
Returning `null` is not an error: sessions play and are not saved.

## 3 · The sixth mode circle

Home currently has five mode circles. Add a sixth with the same class and
markup as the existing ones, `id="xquixHomeCircle_soundbox"`. **The athlete
sees "Sound Box"** — that is the name on the artwork MIZE supplied 2026-09-11;
"Sound Studio" stays the internal name of the function and the module.

Artwork — the project cannot hold binary files, so both were delivered in the Sound Box chat on 2026-09-11 (MIZE has them); transparent WebP:

| File | Use | Size |
|---|---|---|
| `xquixHomeCircle_soundbox.webp` | the mode circle | 512 × 510 |
| `xquixHomeBanner_soundbox.webp` | a full-width banner in the Tutorials-style pill format, 4.7:1, if Home uses a banner for this entry instead of (or as well as) a circle | 2160 × 460 |

Copy whichever Home needs into the repo root next to the existing
`xquixHomeBanner_*.webp` files, and add it to the `deploy.sh` file check.
Keep the same `animation-delay` progression the others use.

## 4 · The router branch — **CONFIRM the handler shape**

Wherever a mode circle tap is dispatched, add:

```js
// Sound Studio: a self-contained overlay. Guard on the module so a missing
// file degrades to the toast rather than a crash (same rule as the tutorials).
if (MIZE.SoundStudio && typeof MIZE.SoundStudio.start === "function") {
  if (typeof Entitlements !== "undefined" && Entitlements.canFunction && !Entitlements.canFunction("M01")) { /* show the usual gate message */ return; }
  xquixHideHome();
  closeToolPanels();
  MIZE.SoundStudio.start();
} else {
  /* the "not built yet" toast */
}
```

`M01` is the gate row (`function_gates`, module *Sound Studio*, all plans
Included; rows M01–M04 exist as of 2026-09-10). `S01–S04` were **not** used —
those ids belong to the Tactical Studio.

`MIZE.SoundStudio.start()` needs to run inside the tap handler (a user gesture),
or iOS will refuse the first `audio.play()`.

## 5 · `deploy.sh`

Add `xquix-sound-studio.js` to the list of files whose `<script src>` must be
present and whose file must exist, alongside the tracker and rig modules. Same
reason as before: a stale `index.html` must not be able to ship without it.

---

## Verifying

Open Home, tap **Sound Box**. The overlay covers the Studio; three questions;
**Build my session**; **Start** — the first track plays from
`sound.xquix.com`. Tap **‹ Home**: the overlay is gone, audio stopped, and
`document.getElementById("xqSoundStudio")` is `null`. Signed in, finishing a
session and tapping a rating writes one row to `sound_sessions` (owner-only RLS;
check with `select count(*) from sound_sessions`).

## What this does NOT include

- **Athlete accounts** (phase 6): a signup choice and an `athlete_free` plan.
  Until then any signed-in account can open Sound Studio — intended for testing.
- **The lab**: if you want it in `lab/` first, `pin-lab.sh` needs one more line
  to carry `xquix-sound-studio.js`; the module has no Home dependency, so it
  also runs in `soundbox/harness.html` with no Studio at all.
