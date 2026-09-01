# INSTRUCTION · Restore the Game Tracker tutorial wiring in `index.html`

*For the Studio chat, from the Game Tracker tutorial chat, 2026-09-01.*

`index.html` has lost every piece of the Game Tracker tutorial wiring. This note
says exactly what to put back and where. Nine edits, all additive except one
attribute swap. Nothing else in the file needs to change.

## Read this part first

**Do not restore by reverting the file.** `index.html` gained real Studio work in
the same window the wiring disappeared — the `#exitPresentationBtn` visibility
rules, the timeline panel losing its drag and undock, and `attackDirectionBtn`.
A checkout of an older copy would take all of that with it. Apply the nine edits
below to the file as it stands.

**What went missing, and when.** The file was last written **2026-08-31 21:13**.
Before that it had all nine pieces; after it has none of them — no script tag, no
submenu, no handlers, no router branch. `GameTrackerTutorial` does not appear in
the file at all. This is the same failure the lab was built after: a session
writing back an `index.html` it had read before the wiring was added. It has now
happened three times.

**Nothing has shipped in this state.** `deploy.sh` greps for three of these
markers and refuses to push without them, so the live site is still the last good
build. That refusal is the only reason this was caught.

Every block below is verbatim from the 2026-08-31 15:33 copy, which is the last
one known to have them. Line numbers are from `index.html` as it is now
(25,797 lines). Each edit adds lines, so every number below it shifts — apply
them **bottom-up (9 → 1)**, or ignore the numbers and anchor on the quoted text.

---

## 1 · The module's script tag

**Line 21203** currently reads:

```html
<script src="xquix-game-tracker.js"></script>
```

Add the tutorial module directly after it:

```html
<script src="xquix-game-tracker-tutorial.js"></script>
```

`deploy.sh` greps for `<script src="xquix-game-tracker-tutorial.js">` exactly.

## 2 · Bottom padding on the banner group

**Line 1188.** Add `padding-bottom:28px;` before the closing brace:

```css
  .xquixHomeTutorialBanners { display:flex; flex-direction:column; gap:10px; margin-top:18px; width:min(380px,82vw); padding-bottom:28px; }
```

Without it the last banner sits flush against the bottom edge of a phone screen.

## 3 · The drill-down CSS

Insert after **line 1193** (`.xquixHomeTutorialBanner:nth-child(3)`):

```css
  .xquixHomeTutorialBanner:nth-child(4){ animation-delay:.24s; }
  /* Drill-down, not unfold. Four more full-width banners appended under the
     three existing ones made the list scroll and read as "seven things", with
     no signal that the last four were a choice within the third. Opening the
     Game Tracker group therefore REPLACES the top level instead of extending
     it: same list length, one obvious question on screen, and no new artwork
     needed (these pills are 4.7:1, so a 2x2 grid would render them ~39px tall
     and the subtitles would be unreadable). */
  .xquixHomeTutorialBanners.drilled > .xquixHomeTutorialBanner { display:none; }
  .xquixHomeSubHead { display:flex; align-items:center; gap:8px; margin-bottom:2px; }
  .xquixHomeSubHead button { font:800 12px system-ui; color:#cfeaea; background:#123c3a;
    border:1px solid #2a5f5c; border-radius:8px; padding:6px 10px; cursor:pointer; touch-action:manipulation; }
  .xquixHomeSubHead span { font:800 10px system-ui; letter-spacing:.08em; text-transform:uppercase; color:#4bb8bd; }
  .xquixHomeTutorialBanner:nth-child(5){ animation-delay:.31s; }
```

## 4 · The parent banner opens a submenu instead of launching

**Line 2510**, the `<img id="xquixHomeBanner_gametracker">` with the inline
base64 `src`. Swap one attribute — leave the rest of the tag alone:

```
-  data-tutorial="gametracker"
+  data-submenu="xquixHomeGametrackerBanners"
```

## 5 · The submenu markup

Insert directly after that `<img>` (so **after line 2510**, before the `</div>`
on line 2511). It is a sibling of the three banners, inside the same
`#xquixHomeTutorialBanners` container — that nesting is what makes the
`.drilled > .xquixHomeTutorialBanner` rule in edit 3 hide the top level while
leaving this group visible:

```html
        <!-- Game Tracker has four tutorials, so its banner opens a second
             level rather than launching one. Same .open toggle the Tutorials
             circle already uses for the group above. Only FIELD PLAYER is
             built; the other three fall through to the "not built yet" toast
             on purpose, so the submenu can be checked before they exist. -->
        <div class="xquixHomeTutorialBanners" id="xquixHomeGametrackerBanners">
          <div class="xquixHomeSubHead"><button type="button" id="xquixHomeGametrackerBack">‹ Back</button><span>Game Tracker · pick one</span></div>
          <img class="xquixHomeTutorialBanner" id="xquixHomeBanner_gametracker_field" src="xquixHomeBanner_gametracker_field.webp" data-tutorial="gametracker-field" alt="Game Tracker tutorial: Field Player" tabindex="0" role="button">
          <img class="xquixHomeTutorialBanner" id="xquixHomeBanner_gametracker_goalkeeper" src="xquixHomeBanner_gametracker_goalkeeper.webp" data-tutorial="gametracker-goalkeeper" alt="Game Tracker tutorial: Goalkeeper" tabindex="0" role="button">
          <img class="xquixHomeTutorialBanner" id="xquixHomeBanner_gametracker_team" src="xquixHomeBanner_gametracker_team.webp" data-tutorial="gametracker-team" alt="Game Tracker tutorial: Your Team" tabindex="0" role="button">
          <img class="xquixHomeTutorialBanner" id="xquixHomeBanner_gametracker_fullgame" src="xquixHomeBanner_gametracker_fullgame.webp" data-tutorial="gametracker-fullgame" alt="Game Tracker tutorial: The Whole Game" tabindex="0" role="button">
        </div>
```

The comment is stale as written: all four tutorials are now built in `lab/`.
Only FIELD PLAYER is *published*, which is the point edit 9 turns on. Worth
rewording to "only FIELD PLAYER is published" while you are in there.

The four `.webp` files are all still in the repo and `deploy.sh` already checks
for them.

## 6 · Opening the Tutorials group scrolls it into view

**Line 4087** currently reads:

```js
  document.getElementById('xquixHomeTutorialBanners')?.classList.toggle('open');
```

Replace with:

```js
  const g = document.getElementById('xquixHomeTutorialBanners');
  const opened = g?.classList.toggle('open');
  if(opened) requestAnimationFrame(()=>{ g.scrollIntoView({ block:'end', behavior:'smooth' }); });
```

Five mode circles already fill a phone screen, so anything opened below them
lands under the fold.

## 7 · The `data-submenu` branch in the banner click handler

**Line 4099**, inside `const handler = function(){ … }`. Insert before the
existing `document.dispatchEvent(...)` line:

```js
    // A banner carrying data-submenu opens a nested group instead of launching
    // anything -- one more level of exactly the mechanism the Tutorials circle
    // already uses. Everything else dispatches as before.
    const sub = this.dataset.submenu;
    if(sub){
      const group = document.getElementById(sub);
      const parent = this.parentElement;
      group?.classList.add('open');
      parent?.classList.add('drilled');   // hide the top level while drilled in
      // The five mode circles already fill a phone screen, so anything opened
      // below them lands under the fold -- which is what made four banners feel
      // like a long list rather than a choice. Bring the whole group into view.
      requestAnimationFrame(()=>{ group?.scrollIntoView({ block:'end', behavior:'smooth' }); });
      return;
    }
```

## 8 · The Back button, and leaving the group cleanly

Insert after **line 4104** (the closing `});` of the banner `forEach`):

```js
document.getElementById('xquixHomeGametrackerBack')?.addEventListener('click', (e)=>{
  e.stopPropagation();
  const group = document.getElementById('xquixHomeGametrackerBanners');
  group?.classList.remove('open');
  group?.parentElement?.classList.remove('drilled');
});
// Leaving the Tutorials group entirely must not strand it drilled in, or the
// next open shows the sub-level with no way to tell how you got there.
document.getElementById('xquixHomeCircle_tutorials')?.addEventListener('click', ()=>{
  const group = document.getElementById('xquixHomeGametrackerBanners');
  group?.classList.remove('open');
  group?.parentElement?.classList.remove('drilled');
});
```

## 9 · The router branch

In the `xquixHomeTutorialSelected` listener, after the `waterpolo` branch —
i.e. after **line 4514** (`MIZE.Parent.start();`) and before the `} else {`
toast on line 4515:

```js
  } else if(tutorial === 'gametracker-field' && typeof MIZE !== 'undefined' && MIZE.GameTrackerTutorial && typeof MIZE.GameTrackerTutorial.start === 'function'){
    xquixHideHome();
    closeToolPanels();
    MIZE.GameTrackerTutorial.start('field');
```

**`gametracker-field` only, and this matters.** The shipping
`xquix-game-tracker-tutorial.js` is the 2026-08-29 build and can only build that
one tutorial. A branch that routes a tutorial the module cannot build makes
`start()` throw *after* tutorial mode is already on and the tracker is already
opening — the banner becomes a crash rather than a toast. `deploy.sh` treats
that mismatch as fatal and will refuse the push. The other three banners fall
through to "not built yet" on purpose, and the tutorial chat widens the branch in
the lab copy only, where the lab's newer module answers.

If you widen this branch, the tutorial module has to be promoted in the same
commit. That is the tutorial chat's call to make, not a change to fold in here.

---

## Verifying the repair

```
./deploy.sh "restore game tracker tutorial wiring"
```

It refuses unless the script tag, `id="xquixHomeGametrackerBanners"` and
`tutorial === 'gametracker-field'` are all present, and prints
`ok  tutorial wired into index.html` when they are.

A quick manual check before that: open Home, tap **Tutorials**, tap the **Game
Tracker** banner. The three top-level banners should be replaced by a `‹ Back`
header reading "Game Tracker · pick one" and four banners under it. FIELD PLAYER
starts a tutorial; the other three toast "not built yet".

## One request

If this file is going to keep being rewritten wholesale, the Game Tracker
tutorials need a way into the lab that does not run through `index.html` — three
outages in a week is enough evidence. The tutorial chat has offered to add
launch buttons to the LAB panel that `pin-lab.sh` already generates, which would
make this file's state irrelevant to tutorial work. No action needed from you;
noted here so the constraint is written down somewhere both chats can see it.
