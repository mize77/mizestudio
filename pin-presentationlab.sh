#!/usr/bin/env bash
# Pin the Presentation Lab to the current XquiX Studio.
#
#   ./pin-presentationlab.sh        # snapshot the Studio into presentationlab/
#
# Same idea as pin-lab.sh (the Game Tracker lab): a FROZEN COPY of the real
# Studio with one difference -- the Presentation Mode tutorial module is loaded,
# which the shipping index.html does not do yet. Tutorial work happens against
# the actual app, on its own page, in its own storage namespace, so nothing here
# can touch the Studio or a coach's real data.
#
# presentationlab/xquix-presentation-tutorial.js is NEVER touched here -- it is
# the work in progress. Everything else in presentationlab/ is regenerated.
#
# Afterwards: ./deploy.sh "…"    then open app.xquix.com/presentationlab/

set -euo pipefail
cd "$(dirname "$0")"
LAB=presentationlab
mkdir -p "$LAB"

echo "==> Pinning Studio modules into $LAB/"
for f in xquix-game-tracker.js xquix-game-tracker-tutorial.js xquix-player-rig.js xquix-pose-resolver.js xquix-poses.json parent-experience.js; do
  if [ -f "$f" ]; then cp "$f" "$LAB/$f"; echo "    pinned  $f"; else echo "    absent  $f (skipped)"; fi
done
[ -f "$LAB/xquix-presentation-tutorial.js" ] || cp xquix-presentation-tutorial.js "$LAB/xquix-presentation-tutorial.js"
echo "    kept    $LAB/xquix-presentation-tutorial.js (work in progress, never overwritten)"
for f in homography.js va-geometry.js va-detect.js va-model.json xquix-video-analysis.js; do
  if [ -f "$LAB/$f" ]; then echo "    kept    $LAB/$f (Video Analysis test, lab-owned, never overwritten)"; else echo "    absent  $LAB/$f (Video Analysis test not installed - Analyze will be missing)"; fi
done

echo "==> Building $LAB/index.html from the live index.html"
(
LAB="$LAB" python3 - <<'PY'
import datetime, os

LAB = os.environ['LAB']
src = open('index.html', encoding='utf-8').read()
stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

# --- 1. Everything relative resolves to the Studio root; storage is namespaced
#        (the lab is same-origin with the Studio and would otherwise share its
#        localStorage -- library cache, auth session, the coach's saved game).
head = """<head>
<base href="../">
<meta name="robots" content="noindex, nofollow">
<script>
/* PRESENTATION LAB STORAGE IS NAMESPACED. Same origin as the Studio, so
   without this the lab would read and overwrite the coach's real data.
   Patched before any other script runs. The lab therefore has its own,
   signed-out session. */
(function () {
  var NS = 'plab:', P = Storage.prototype;
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

# --- 2. Lab-owned modules load from the lab folder, cache-busted on every load
#        (see pin-lab.sh for why the buster must be per load, not per pin).
def loader(files):
    lines = ''.join(
        """  d.write('<scr' + 'ipt src="%s/%s?t=' + t + '"><\\/scr' + 'ipt>');\n""" % (LAB, f)
        for f in files)
    return ('<script>\n'
            '/* Presentation Lab only: every reload fetches the current file. See pin-presentationlab.sh. */\n'
            '(function () { var d = document, t = Date.now();\n' + lines + '})();\n'
            '</script>')

for f in ['xquix-game-tracker.js', 'xquix-game-tracker-tutorial.js', 'xquix-player-rig.js', 'xquix-pose-resolver.js', 'parent-experience.js']:
    tag = '<script src="%s"></script>' % f
    if tag in src:
        src = src.replace(tag, loader([f]), 1)

# The Presentation tutorial: after the Game Tracker tutorial's loader if the
# live index.html has not wired it, in place of its own tag if it has.
PT = '<script src="xquix-presentation-tutorial.js"></script>'
if PT in src:
    src = src.replace(PT, loader(['xquix-presentation-tutorial.js']), 1)
    print('    index.html already loads the Presentation tutorial - lab loads its own copy instead')
else:
    anchor = loader(['xquix-game-tracker-tutorial.js'])
    assert anchor in src, 'game tracker tutorial tag not found - cannot place the presentation tutorial'
    src = src.replace(anchor, anchor + '\n' + loader(['xquix-presentation-tutorial.js']), 1)
    print('    added the Presentation tutorial loader (production does not load it yet)')

# --- 2b. Video Analysis test (Phase E, video-analysis/PHASE-E-LAB.md): lab-only, lab-owned files.
#         Screens -> Left gets "Analyze"; the left screen's File also takes a screenshot.
VA = ['homography.js', 'va-geometry.js', 'va-detect.js', 'xquix-video-analysis.js']
if all(os.path.exists(os.path.join(LAB, f)) for f in VA):
    pt = loader(['xquix-presentation-tutorial.js'])
    assert pt in src, 'presentation tutorial loader not found - cannot place the video analysis test'
    src = src.replace(pt, pt + '\n' + loader(VA), 1)
    print('    added the Video Analysis test loader (lab only)')
else:
    print('    Video Analysis test files absent - not loaded')

# --- 3. An unmistakable banner, and a small LAB panel with a direct launcher.
banner = """<div id="labBanner">Presentation Lab · pinned Studio snapshot · not the live app</div>
<style>
 #labBanner{position:fixed;left:0;right:0;top:0;z-index:2147483000;background:#4a2a7a;color:#e9dcff;
   font:800 11px system-ui;letter-spacing:.08em;text-transform:uppercase;text-align:center;
   padding:4px 8px;padding-top:calc(4px + env(safe-area-inset-top));pointer-events:none;}
 #labTools{position:fixed;right:8px;bottom:8px;bottom:calc(8px + env(safe-area-inset-bottom));
   z-index:2147482000;display:flex;flex-direction:column;align-items:flex-end;gap:6px;}
 #labTools button{font:800 10px system-ui;letter-spacing:.06em;background:#4a2a7a;color:#e9dcff;
   border:1px solid #6b3fb0;border-radius:8px;padding:6px 9px;cursor:pointer;touch-action:manipulation;}
 #labTools .panel{display:none;flex-direction:column;gap:6px;background:rgba(10,31,29,.96);
   border:1px solid #2a5f5c;border-radius:10px;padding:9px;width:min(250px,calc(100vw - 24px));}
 #labTools .panel.open{display:flex;}
 #labTools .panel button{background:#1b7373;color:#fff;border-color:#2a5f5c;}
 #labTools .info{font:11px/1.4 ui-monospace,Menlo,monospace;color:#9ec9c7;}
 body.tutorialModeActive #labTools{display:none;}
</style>
<div id="labTools">
  <div class="panel" id="labPanel">
    <div class="info" id="labInfo"></div>
    <button id="labStart">Start Presentation tutorial</button>
    <button id="labReset">Reset first-use (forget qualification)</button>
    <button id="labPro">Simulate Pro tier: off</button>
    <button id="labClear">Clear lab storage</button>
  </div>
  <button id="labToggle">LAB</button>
</div>
<script>
(function () {
  var panel = document.getElementById('labPanel');
  document.getElementById('labToggle').onclick = function(){ panel.classList.toggle('open'); info(); };
  document.getElementById('labStart').onclick = function () {
    panel.classList.remove('open');
    if (typeof window.startPresentationTutorial === 'function') { if (typeof xquixHideHome === 'function') xquixHideHome(); window.startPresentationTutorial(); }
    else info('xquix-presentation-tutorial.js did not load');
  };
  // Forget that the Presenting mode was qualified, so Switch Mode -> Presenting
  // runs the first-use path again.
  document.getElementById('labReset').onclick = function () {
    try { var q = JSON.parse(localStorage.getItem('xquixModeQualified') || '{}'); delete q.presenting; localStorage.setItem('xquixModeQualified', JSON.stringify(q)); } catch (e) {}
    // Since the tutorial system's Step 1 the first-use state also lives in XQLearn's
    // device cache (the lab is signed out): forget qs.presenting there too.
    try { var d = JSON.parse(localStorage.getItem('xquixLearnV1:device') || '{}'); delete d['qs.presenting']; localStorage.setItem('xquixLearnV1:device', JSON.stringify(d)); } catch (e) {}
    info('presenting is unqualified again: Switch Mode -> Presenting runs the tutorial first');
  };
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
    Object.keys(localStorage).filter(function (k) { return k.indexOf('plab:') === 0; })
      .forEach(function (k) { localStorage.removeItem(k.slice(5)); });
    info('lab storage cleared - the Studio\\u2019s own storage was never touched');
  };
  function info(msg) {
    var U = window.MIZE && MIZE.PresentationTutorial;
    var qual = false; try { qual = (typeof hasModeTutorialQualification === 'function') ? hasModeTutorialQualification('presenting') : !!(JSON.parse(localStorage.getItem('xquixModeQualified') || '{}').presenting); } catch (e) {}
    document.getElementById('labInfo').textContent =
      (msg ? msg + '\\n' : '') +
      'pinned: ' + (window.LAB_PINNED || '?') +
      '\\ntutorial: ' + (U ? (U.buildSteps().length + ' steps' + (U.isRunning() ? ' · running' : '')) : 'not loaded') +
      '\\npresenting: ' + (document.body.classList.contains('presentation') ? 'on' : 'off') +
      '  · qualified: ' + (qual ? 'yes' : 'no');
  }
  setInterval(function(){ if(panel.classList.contains('open')) info(); }, 800);
})();
</script>
</body>"""
assert src.count('</body>') == 1
src = src.replace('</body>', banner, 1)

# The cloud-synced mount intermittently refuses to overwrite an existing file,
# so write a fresh temp and let the shell rename it into place.
tmp = '%s/.index.new.%d' % (LAB, os.getpid())
open(tmp, 'w', encoding='utf-8').write(src)
print('    built   %s  (%d bytes, pinned %s)' % (tmp, len(src.encode('utf-8')), stamp))
print('TMPFILE=' + tmp)
PY
) 2>&1 | tee /tmp/pinplab.$$ ; TMP=$(grep '^TMPFILE=' /tmp/pinplab.$$ | cut -d= -f2)
[ -n "$TMP" ] || { echo "!! the build produced no file - nothing changed." >&2; exit 1; }
mv -f "$TMP" "$LAB/index.html"
rm -f /tmp/pinplab.$$

echo
echo "Presentation Lab pinned. Deploy, then open app.xquix.com/$LAB/"
