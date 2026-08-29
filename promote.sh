#!/usr/bin/env bash
# Promote the Game Tracker lab's files into the live Studio.
#
#   ./promote.sh            # show what would change, change nothing
#   ./promote.sh --apply    # copy lab/ -> repo root
#
# The lab at lab/ is the WORKING COPY. The repo root is what ships. Development
# happens in the lab, on its own page, against its own copies, and reaches the
# Studio only when this is run — so the Studio can be worked on in parallel
# without the two colliding.
#
# This does not deploy. After promoting, run ./deploy.sh as usual.

set -euo pipefail
cd "$(dirname "$0")"

FILES="xquix-game-tracker.js xquix-game-tracker-tutorial.js"
APPLY="${1:-}"

[ -d lab ] || { echo "!! no lab/ directory here." >&2; exit 1; }

echo "==> Checking the lab's files are valid"
for f in $FILES; do
  [ -f "lab/$f" ] || { echo "!! lab/$f is missing." >&2; exit 1; }
  node --check "lab/$f" || { echo "!! lab/$f has a syntax error — nothing promoted." >&2; exit 1; }
  echo "    ok  lab/$f"
done

echo "==> Differences (lab -> live)"
changed=""
for f in $FILES; do
  if cmp -s "lab/$f" "$f"; then
    echo "    same       $f"
  else
    lab_lines=$(wc -l < "lab/$f" | tr -d ' ')
    live_lines=$(wc -l < "$f" 2>/dev/null | tr -d ' ' || echo 0)
    echo "    DIFFERENT  $f   lab ${lab_lines} lines / live ${live_lines} lines"
    changed="$changed $f"
  fi
done

if [ -z "$changed" ]; then
  echo "    nothing to promote."
  exit 0
fi

if [ "$APPLY" != "--apply" ]; then
  echo
  echo "Nothing copied. Re-run with --apply to promote:"
  echo "    ./promote.sh --apply"
  exit 0
fi

echo "==> Promoting"
mkdir -p .promote-backup
for f in $changed; do
  [ -f "$f" ] && cp "$f" ".promote-backup/$f.$(date +%Y%m%d-%H%M%S)"
  cp "lab/$f" "$f"
  echo "    copied  lab/$f -> $f"
done

echo
echo "Promoted. Nothing is live yet — run:"
echo "    ./deploy.sh \"promote game tracker changes from the lab\""
