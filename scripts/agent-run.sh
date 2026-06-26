#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/agent
export USER=agent
export LOGNAME=agent
export PATH=/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
export DISABLE_AUTOUPDATER=1

case "${1:-}" in
  codex|/app/node_modules/.bin/codex)
    shift
    export CODEX_HOME=/home/agent
    exec /app/node_modules/.bin/codex "$@"
    ;;
  claude|/app/node_modules/.bin/claude)
    shift
    exec /app/node_modules/.bin/claude "$@"
    ;;
  git|/usr/bin/git)
    shift
    exec /usr/bin/git "$@"
    ;;
  *)
    printf 'patchdoll-agent-run: unsupported command: %s\n' "${1:-}" >&2
    exit 126
    ;;
esac
