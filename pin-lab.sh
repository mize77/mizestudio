#!/usr/bin/env bash
# Pin the Game Tracker Lab to the current XquiX Studio.
#
#   ./pin-lab.sh            # snapshot the Studio into lab/
#   ./pin-lab.sh --tracker  # also refresh lab's copy of the tracker from root
#
# The lab is a FROZEN COPY of the real Studio, not a stand-in for it. Tutorial
# work happens against the actual app — real Home, real field, real chrome — so
# what you see while building is what a coach sees. Freezing it means ongoing
# Studio development cannot move the ground under a tutorial mid-build; you
# re-pin deliberately, when you want the newer Studio.
#
# lab/xquix-game-tracker-tutorial.js is NEVER touched here — it is the work in
# progress. lab/xquix-game-tracker.js is only refreshed with --tracker, for the
# same reason: it is a working copy once tracker development moves into the lab.
#
# Afterwards: ./deploy.sh "…"    then open app.xquix.com/lab/

set -euo pipefail
cd "$(dirname "$0")"
mkdir -p lab

echo "==> Pinning Studio modules into lab/"
for f in xquix-player-rig.js xquix-pose-resolver.js xquix-poses.json parent-experience.js; do
  if [ -f "$f" ]; then cp "$f" "lab/$f"; echo "    pinned  $f"; else echo "    absent  $f (skipped)"; fi
done
if [ "${1:-}" = "--tracker" ]; then
  cp xquix-game-tracker.js lab/xquix-game-tracker.js
  echo "    pinned  xquix-game-tracker.js (--tracker)"
else
  [ -f lab/xquix-game-tracker.js ] || cp xquix-game-tracker.js lab/xquix-game-tracker.js
  echo "    kept    lab/xquix-game-tracker.js (working copy; --tracker to refresh)"
fi
[ -f lab/xquix-game-tracker-tutorial.js ] || cp xquix-game-tracker-tutorial.js lab/xquix-game-tracker-tutorial.js
echo "    kept    lab/xquix-game-tracker-tutorial.js (work in progress, never overwritten)"

echo "==> Building lab/index.html from the live index.html"
(
python3 - <<'PY'
import re, datetime, os

src = open('index.html', encoding='utf-8').read()
stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

# --- 1. Everything relative resolves to the Studio root, EXCEPT the handful of
#        files the lab owns. Without this, assets/, favicons and every other
#        relative reference would 404 under /lab/.
head = """<head>
<base href="../">
<meta name="robots" content="noindex, nofollow">
<script>
/* LAB STORAGE IS NAMESPACED -- the single most important line in this file.
   The lab is served from the SAME ORIGIN as the Studio, so without this it
   would read and overwrite the coach's real saved game, real library cache and
   real auth session. Patched on Storage.prototype before any other script
   runs, so it covers Studio, Supabase, the tracker and the tutorial alike.
   A consequence worth knowing: the lab has its own (signed-out) session. */
(function () {
  var NS = 'lab:', P = Storage.prototype;
  var g = P.getItem, s = P.setItem, r = P.removeItem;
  P.getItem    = function (k) { return g.call(this, NS + k); };
  P.setItem    = function (k, v) { return s.call(this, NS + k, v); };
  P.removeItem = function (k) { return r.call(this, NS + k); };
  window.LAB_NS = NS;
  window.LAB_PINNED = '%s';
})();
</script>""" % stamp
assert src.count('<head>') == 1
src = src.replace('<head>', head, 1)

# --- 2. Lab-owned modules load from lab/, cache-busted so a stale copy can
#        never masquerade as "the change didn't work".
OWNED = ['xquix-game-tracker.js', 'xquix-player-rig.js', 'xquix-pose-resolver.js', 'parent-experience.js']
for f in OWNED:
    src = src.replace('<script src="%s">' % f, '<script src="lab/%s?pin">' % f)
# the tutorial too, and it must exist even if the live index has not wired it yet
if 'xquix-game-tracker-tutorial.js' in src:
    src = src.replace('<script src="xquix-game-tracker-tutorial.js">',
                      '<script src="lab/xquix-game-tracker-tutorial.js?pin">')
else:
    src = src.replace('<script src="lab/xquix-game-tracker.js?pin"></script>',
                      '<script src="lab/xquix-game-tracker.js?pin"></script>\\n'
                      '<script src="lab/xquix-game-tracker-tutorial.js?pin"></script>', 1)
# a real timestamp, so every load fetches the current lab build
src = src.replace('?pin"', '?t=" + Date.now() + "') if False else src.replace(
    '?pin"', '?pin=PINSTAMP"').replace('PINSTAMP', stamp.replace(' ', '_'))

# --- 3. An unmistakable banner. This is not the Studio.
banner = """<div id="labBanner">Game Tracker Lab · pinned Studio snapshot · not the live app</div>
<style>
 #labBanner{position:fixed;left:0;right:0;top:0;z-index:2147483000;background:#7a3b00;color:#ffe9c9;
   font:800 11px system-ui;letter-spacing:.08em;text-transform:uppercase;text-align:center;
   padding:4px 8px;padding-top:calc(4px + env(safe-area-inset-top));pointer-events:none;}
 #labTools{position:fixed;right:8px;bottom:8px;bottom:calc(8px + env(safe-area-inset-bottom));
   z-index:2147482000;display:flex;flex-direction:column;align-items:flex-end;gap:6px;}
 #labTools button{font:800 10px system-ui;letter-spacing:.06em;background:#7a3b00;color:#ffe9c9;
   border:1px solid #a35400;border-radius:8px;padding:6px 9px;cursor:pointer;touch-action:manipulation;}
 #labTools .panel{display:none;flex-direction:column;gap:6px;background:rgba(10,31,29,.96);
   border:1px solid #2a5f5c;border-radius:10px;padding:9px;width:min(250px,calc(100vw - 24px));}
 #labTools .panel.open{display:flex;}
 #labTools .panel button{background:#1b7373;color:#fff;border-color:#2a5f5c;}
 #labTools .info{font:11px/1.4 ui-monospace,Menlo,monospace;color:#9ec9c7;}
</style>
<div id="labTools">
  <div class="panel" id="labPanel">
    <div class="info" id="labInfo"></div>
    <button id="labPro">Simulate Pro tier: off</button>
    <button id="labClear">Clear lab storage</button>
  </div>
  <button id="labToggle">LAB</button>
</div>
<script>
(function () {
  var panel = document.getElementById('labPanel');
  document.getElementById('labToggle').onclick = function(){ panel.classList.toggle('open'); info(); };
  // The lab has its own signed-out session, so entitlement gates resolve to the
  // free tier. This forces the paid answer instead, to check the sheets a Pro
  // account sees (assist, shot variants, the keeper-steal follow-up).
  var pro = false;
  document.getElementById('labPro').onclick = function () {
    pro = !pro;
    this.textContent = 'Simulate Pro tier: ' + (pro ? 'ON' : 'off');
    if (window.XQUIX && XQUIX.Entitlements) {
      if (pro) {
        XQUIX.Entitlements._labReal = XQUIX.Entitlements._labReal || XQUIX.Entitlements.canFunction;
        XQUIX.Entitlements.canFunction = function () { return true; };
      } else if (XQUIX.Entitlements._labReal) {
        XQUIX.Entitlements.canFunction = XQUIX.Entitlements._labReal;
      }
    }
    info();
  };
  document.getElementById('labClear').onclick = function () {
    Object.keys(localStorage).filter(function (k) { return k.indexOf('lab:') === 0; })
      .forEach(function (k) { localStorage.removeItem(k.slice(4)); });
    info('lab storage cleared — the Studio’s own storage was never touched');
  };
  function info(msg) {
    var T = window.XquiXGameTracker, U = window.MIZE && MIZE.GameTrackerTutorial;
    document.getElementById('labInfo').textContent =
      (msg ? msg + '\\n' : '') +
      'pinned: ' + (window.LAB_PINNED || '?') +
      '\\ntutorial: ' + (U ? (U.stepCount() + ' steps · ' + U.lessonTitles().length + ' lessons') : 'not loaded') +
      '\\ntracker: ' + (T ? (T.isOpen() ? 'open' : 'closed') : 'not loaded') +
      (T ? ('  · tutorial mode: ' + T.state.tutorialMode) : '');
  }
  setInterval(function(){ if(panel.classList.contains('open')) info(); }, 800);
})();
</script>
</body>"""
assert src.count('</body>') == 1
src = src.replace('</body>', banner, 1)

# The cloud-synced mount intermittently refuses to overwrite an existing file
# ("Resource deadlock avoided"), so write a fresh temp and let the shell rename
# it into place -- rename() succeeds where open-for-write does not.
tmp = 'lab/.index.new.%d' % os.getpid()
open(tmp, 'w', encoding='utf-8').write(src)
print('    built   %s  (%d bytes, pinned %s)' % (tmp, len(src.encode('utf-8')), stamp))
print('TMPFILE=' + tmp)
PY
) 2>&1 | tee /tmp/pinlab.$$ ; TMP=$(grep '^TMPFILE=' /tmp/pinlab.$$ | cut -d= -f2)
grep -v '^TMPFILE=' /tmp/pinlab.$$ | tail -2 >/dev/null
[ -n "$TMP" ] || { echo "!! the build produced no file - nothing changed." >&2; exit 1; }
mv -f "$TMP" lab/index.html
rm -f /tmp/pinlab.$$

echo
echo "Lab pinned. Deploy, then open app.xquix.com/lab/"
