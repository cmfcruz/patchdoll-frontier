#!/usr/bin/env bash
set -euo pipefail

log() {
  printf 'patchdoll-entrypoint: %s\n' "$*" >&2
}

agent_env() {
  env -i \
    HOME=/home/agent \
    USER=agent \
    LOGNAME=agent \
    PATH=/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
    TERM="${TERM:-xterm-256color}" \
    DISABLE_AUTOUPDATER=1 \
    "$@"
}

run_as_agent() {
  agent_env /usr/bin/sudo -E -H -u agent -- /usr/local/bin/patchdoll-agent-run "$@"
}

prepare_runtime_dirs() {
  mkdir -p /workspace /home/agent /home/patchdoll-bridge
  chown -R agent:patchdoll-ipc /home/agent
  chmod 0700 /home/agent
  chown -R patchdoll-bridge:patchdoll-bridge /home/patchdoll-bridge
  chmod 0755 /home/patchdoll-bridge

  if chown -R agent:patchdoll-ipc /workspace; then
    find /workspace -type d -exec chmod u+rwx,g+rx,g+s,o-rwx {} +
    find /workspace -type f -exec chmod u+rw,g+r,o-rwx {} +
  else
    log "unable to prepare /workspace; Patchdoll requires CAP_CHOWN for the persistent workspace mount"
    exit 1
  fi
}

# Authenticate Codex: an env credential wins, otherwise fall back to device-code.
authenticate_codex() {
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    log "Authenticating Codex with OPENAI_API_KEY"
    printf '%s\n' "$OPENAI_API_KEY" | run_as_agent codex login --with-api-key
  elif run_as_agent codex login status >/dev/null 2>&1; then
    log "Codex is already authenticated"
  else
    log "No Codex env credential found; starting device-code auth"
    run_as_agent codex login --device-auth
  fi
}

# Claude Code reads CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY from the
# environment at run time; there is no login step, so just report what we found.
authenticate_claude() {
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    log "Claude Code OAuth token found in the environment"
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    log "Anthropic API key found in the environment"
  elif run_as_agent claude auth status >/dev/null 2>&1; then
    log "Claude Code is already authenticated"
  else
    log "No Claude Code credential found; set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or run 'claude setup-token'"
  fi
}

# PROVIDER is baked into the image variant (see Dockerfile).
provider="${PROVIDER:-}"

prepare_runtime_dirs

case "$provider" in
  codex) authenticate_codex ;;
  claude) authenticate_claude ;;
  *)
    log "PROVIDER must be 'codex' or 'claude'; got: '${provider}'"
    exit 1
    ;;
esac

exec /usr/bin/sudo -E -H -u patchdoll-bridge -- "$@"
