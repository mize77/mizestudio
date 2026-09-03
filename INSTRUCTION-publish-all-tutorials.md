# INSTRUCTION · Route all four Game Tracker tutorials from Home

*For whoever owns `index.html`, from the Game Tracker tutorial chat, 2026-09-03.*

The four tutorials are built and shipping. `xquix-game-tracker-tutorial.js` in the
repo root builds **field, goalkeeper, team and fullgame** — verified against the
promoted file, not assumed. Home still routes only `gametracker-field`, so three
finished tutorials answer their banner with "This tutorial isn't built yet".

One branch changes. Nothing else in the file.

## The edit

`index.html` **line 4766**, currently:

```js
  } else if(tutorial === 'gametracker-field' && typeof MIZE !== 'undefined' && MIZE.GameTrackerTutorial && typeof MIZE.GameTrackerTutorial.start === 'function'){
    xquixHideHome();
    closeToolPanels();
    MIZE.GameTrackerTutorial.start('field');
```

Replace those four lines with:

```js
  } else if(tutorial && tutorial.indexOf('gametracker-') === 0
            && typeof MIZE !== 'undefined' && MIZE.GameTrackerTutorial && typeof MIZE.GameTrackerTutorial.start === 'function'){
    xquixHideHome();
    closeToolPanels();
    MIZE.GameTrackerTutorial.start(({'gametracker-goalkeeper':'goalkeeper','gametracker-team':'team','gametracker-fullgame':'fullgame'})[tutorial] || 'field');
```

Leave the surrounding `} else {` toast alone — it still catches `waterpolo`,
`studio` and anything added later.

## Why it is written this way

The map defaults to `'field'`, so a `gametracker-` banner that is added later and
forgotten opens the Field Player tutorial rather than throwing. `start()` throws
on an unknown name, and it throws *after* tutorial mode is on and the tracker is
already opening — the banner becomes a crash rather than a toast. That is the one
failure mode this branch exists to avoid, and `deploy.sh` refuses a push that
creates it.

## After the edit

- **`deploy.sh` goes quiet.** It currently prints three NOTEs — goalkeeper, team
  and fullgame built but not routed. All four will match, so no notes at all.
  If it instead reports a *crash* mismatch, the module and the router have got out
  of step and nothing should be pushed until they agree.
- **`pin-lab.sh` stops patching.** Its lab-only widening matches the field-only
  branch you are replacing, so it will print `Home already routes every Game
  Tracker tutorial in index.html itself - no lab patch needed`. That is the patch
  retiring itself by design, not a failure.

## Verifying by hand

Home → Tutorials → Game Tracker. Four banners under a `‹ Back` header reading
"Game Tracker · pick one". Each one starts its own tutorial:

| Banner | Opens |
|---|---|
| FIELD PLAYER | one field player, 59 steps |
| GOALKEEPER | one keeper, 64 steps |
| YOUR TEAM | the squad, 66 steps |
| THE WHOLE GAME | both squads, 71 steps |

The quickest wrong-tutorial check: **Your Team** and **The Whole Game** both open
a *Who?* screen after the first field-zone tap. Field Player and Goalkeeper go
straight to the action list.
