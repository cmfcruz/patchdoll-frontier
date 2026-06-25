#!/usr/bin/env bash
set -euo pipefail

log() {
  printf 'ember-entrypoint: %s\n' "$*" >&2
}

# Authenticate Codex: an env credential wins, otherwise fall back to device-code.
authenticate_codex() {
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    log "Authenticating Codex with OPENAI_API_KEY"
    printf '%s\n' "$OPENAI_API_KEY" | codex login --with-api-key
  elif codex login status >/dev/null 2>&1; then
    log "Codex is already authenticated"
  else
    log "No Codex env credential found; starting device-code auth"
    codex login --device-auth
  fi
}

# Claude Code reads CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY from the
# environment at run time; there is no login step, so just report what we found.
authenticate_claude() {
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    log "Claude Code OAuth token found in the environment"
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    log "Anthropic API key found in the environment"
  elif claude auth status >/dev/null 2>&1; then
    log "Claude Code is already authenticated"
  else
    log "No Claude Code credential found; set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or run 'claude setup-token'"
  fi
}

# EMBER_PROVIDER is baked into the image variant (see Dockerfile); there is no
# default and no runtime override.
case "${EMBER_PROVIDER:-}" in
  codex) authenticate_codex ;;
  claude) authenticate_claude ;;
  *)
    log "EMBER_PROVIDER must be 'codex' or 'claude' (set by the image variant); got: '${EMBER_PROVIDER:-}'"
    exit 1
    ;;
esac

exec "$@"
