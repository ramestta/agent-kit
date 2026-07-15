#!/usr/bin/env bash
# Local <-> server drift check + one-way push for agents.ramestta.com.
#
# Root cause of past drift: there was no single push path. After a source edit,
# some files got scp'd to server, others didn't; and when the server picked up a
# hotfix (three.js assets, agent-card mirror) it wasn't mirrored back to source.
#
# Usage:
#   scripts/sync-portal.sh check   # diff local vs server, exit non-zero on drift
#   scripts/sync-portal.sh push    # rsync web/portal/ -> server; excludes .bak
#   scripts/sync-portal.sh pull    # rsync server -> web/portal/ (rescue only)
#
# All web/portal/ content is served at agents.ramestta.com (nginx root).

set -euo pipefail
CMD="${1:-check}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/web/portal/"
REMOTE="server116:/var/www/agents.ramestta.com/"
EXCLUDES=(--exclude '*.bak.*' --exclude '*.pre-v2.*' --exclude 'node_modules/')

case "$CMD" in
  check)
    echo "=== dry-run rsync $SRC -> $REMOTE ==="
    rsync -avn --delete "${EXCLUDES[@]}" \
      --exclude 'agent-card.json' \
      "$SRC" "$REMOTE"
    ;;
  push)
    echo "=== push $SRC -> $REMOTE ==="
    rsync -av "${EXCLUDES[@]}" \
      --exclude 'agent-card.json' \
      "$SRC" "$REMOTE"
    # nginx also serves /.well-known/agent-card.json from the source;
    # mirror it to /agent-card.json (root) for tools that check the plain path.
    ssh server116 'cp /var/www/agents.ramestta.com/.well-known/agent-card.json /var/www/agents.ramestta.com/agent-card.json'
    echo "OK — verify:  curl -sI https://agents.ramestta.com/docs.html"
    ;;
  pull)
    echo "=== pull $REMOTE -> $SRC (rescue) ==="
    rsync -av "${EXCLUDES[@]}" --exclude 'agent-card.json' "$REMOTE" "$SRC"
    ;;
  *)
    echo "usage: $0 {check|push|pull}"; exit 2 ;;
esac
