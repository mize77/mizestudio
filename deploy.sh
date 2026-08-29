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
