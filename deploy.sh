#!/usr/bin/env bash
# Deploy XquiX Studio.
#
# The repo IS the site: Cloudflare serves the repo root with no build step, so
# whatever is committed here is live about two minutes after it is pushed. That
# also means a syntax error in a root .js file goes live. This script refuses to
# push if one is present.
#
#   ./deploy.sh "what changed"
#
# Must be run from a normal Terminal, never through the Claude device bridge --
# git constantly creates and deletes lock files and the bridge cannot delete.

set -euo pipefail
cd "$(dirname "$0")"

if [ $# -eq 0 ]; then
  echo "usage: ./deploy.sh \"what changed\"" >&2
  exit 1
fi

echo "==> Checking JavaScript syntax"
for f in *.js; do
  [ -e "$f" ] || continue
  node --check "$f" || { echo "!! $f has a syntax error - nothing pushed." >&2; exit 1; }
  echo "    ok  $f"
done

echo "==> Checking index.html still loads its modules"
for m in xquix-game-tracker.js xquix-player-rig.js xquix-pose-resolver.js; do
  grep -q "<script src=\"$m\">" index.html \
    || { echo "!! index.html has no <script src=\"$m\"> - nothing pushed." >&2; exit 1; }
  [ -f "$m" ] || { echo "!! $m is missing from the repo - nothing pushed." >&2; exit 1; }
  echo "    ok  $m linked and present"
done

echo "==> Checking index.html still wires up the Game Tracker tutorial"
# More than one Claude chat edits index.html. On 2026-08-29 one of them wrote
# back a copy it had read BEFORE the tutorial was wired in, silently discarding
# it -- and because the file still looked healthy, it deployed. Nothing warned.
# These markers are cheap and they turn that class of loss into a refusal.
for f in xquix-game-tracker-tutorial.js xquixHomeBanner_gametracker_field.webp \
         xquixHomeBanner_gametracker_goalkeeper.webp xquixHomeBanner_gametracker_team.webp \
         xquixHomeBanner_gametracker_fullgame.webp; do
  [ -f "$f" ] || { echo "!! $f is missing from the repo - nothing pushed." >&2; exit 1; }
done
missing=""
grep -q '<script src="xquix-game-tracker-tutorial.js">' index.html || missing="$missing\n    - the tutorial <script src> tag"
grep -q 'id="xquixHomeGametrackerBanners"'              index.html || missing="$missing\n    - the Game Tracker tutorial submenu"
grep -q "tutorial === 'gametracker-field'"              index.html || missing="$missing\n    - the gametracker-field branch"
if [ -n "$missing" ]; then
  echo "!! index.html has lost the tutorial wiring:" >&2
  printf "$missing\n" >&2
  echo "   This usually means another session wrote back an older copy of" >&2
  echo "   index.html. Nothing pushed. Restore it before deploying." >&2
  exit 1
fi
echo "    ok  tutorial wired into index.html"

echo "==> Changes to publish"
git status --short
if [ -z "$(git status --porcelain)" ]; then
  echo "    nothing to do."
  exit 0
fi

echo "==> Committing and pushing"
git add -A
git commit -m "$*"
git push

echo
echo "Pushed. Cloudflare rebuilds automatically - live at https://app.xquix.com in ~2 min."
echo "Hard-reload the page (Cmd-Shift-R) to get past the browser cache."
