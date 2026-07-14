#!/usr/bin/env bash
set -euo pipefail

log() {
  printf 'entrypoint: %s\n' "$*" >&2
}

append_if_set() {
  local array_name="$1"
  local name="$2"
  if [[ -v "$name" ]]; then
    local -n target="$array_name"
    target+=("${name}=${!name}")
  fi
}

run_as() {
  local user="$1"
  shift
  setpriv --reuid="$user" --regid="$user" --init-groups -- "$@"
}

run_as_session() {
  local user="$1"
  shift
  exec setsid setpriv --reuid="$user" --regid="$user" --init-groups -- "$@"
}

worker_pid=""
bridge_pid=""

terminate_children() {
  local pid
  for pid in "$bridge_pid" "$worker_pid"; do
    [[ -n "$pid" ]] && kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for _ in {1..50}; do
    if { [[ -z "$bridge_pid" ]] || ! kill -0 "$bridge_pid" 2>/dev/null; } &&
      { [[ -z "$worker_pid" ]] || ! kill -0 "$worker_pid" 2>/dev/null; }; then
      return
    fi
    sleep 0.1
  done
  for pid in "$bridge_pid" "$worker_pid"; do
    [[ -n "$pid" ]] && kill -KILL -- "-$pid" 2>/dev/null || true
  done
}

trap 'terminate_children; exit 143' SIGTERM
trap 'terminate_children; exit 130' SIGINT

prepare_runtime_dirs() {
  mkdir -p /home/agent /home/patchdoll /run/patchdoll/bridge /run/patchdoll/providers /workspace

  # Migrate persistent volumes on every start. Agent state and workspace files
  # are owned by the UID that actually runs the provider, never by the bridge.
  chown -R agent:agent /home/agent
  chmod -R u+rwX,go-rwx /home/agent
  chown patchdoll:patchdoll /home/patchdoll
  chmod 0750 /home/patchdoll

  chown -R agent:patchdoll-ipc /workspace
  chmod -R g+rwX /workspace
  find /workspace -type d -exec chmod g+s {} +

  rm -rf /run/patchdoll/bridge /run/patchdoll/providers
  mkdir -p /run/patchdoll/bridge /run/patchdoll/providers
  chown root:root /run/patchdoll
  chown patchdoll:patchdoll-ipc /run/patchdoll/bridge
  chown agent:patchdoll-ipc /run/patchdoll/providers
  chmod 0755 /run/patchdoll
  chmod 0750 /run/patchdoll/bridge
  chmod 2750 /run/patchdoll/providers
}

provider="${PROVIDER:-}"
case "$provider" in
  codex | claude) ;;
  *)
    log "PROVIDER must be 'codex' or 'claude'; got: '${provider}'"
    exit 1
    ;;
esac

common_env=(
  env -i
  "PATH=/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
  "TERM=${TERM:-xterm-256color}"
  "PROVIDER=$provider"
  "PORT=${PORT:-3000}"
  "LOG_LEVEL=${LOG_LEVEL:-info}"
  "NODE_ENV=production"
  "DISABLE_AUTOUPDATER=1"
)

bridge_env=(
  "${common_env[@]}"
  "HOME=/home/patchdoll"
  "USER=patchdoll"
  "LOGNAME=patchdoll"
  "HOST=${HOST:-127.0.0.1}"
)

agent_env=(
  "${common_env[@]}"
  "HOME=/home/agent"
  "USER=agent"
  "LOGNAME=agent"
  "CODEX_HOME=/home/agent"
  "CLAUDE_CONFIG_DIR=/home/agent"
  "PATCHDOLL_BRIDGE_UID=$(id -u patchdoll)"
  "PATCHDOLL_BRIDGE_GID=$(id -g patchdoll)"
)

for name in \
  CODEX_MODEL CODEX_REASONING_EFFORT CODEX_MEMORY_ENABLED CODEX_TIMEOUT_MS \
  CLAUDE_MODEL CLAUDE_EFFORT CLAUDE_MEMORY_ENABLED CLAUDE_TIMEOUT_MS \
  HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy \
  NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR GIT_SSL_CAINFO; do
  append_if_set bridge_env "$name"
  append_if_set agent_env "$name"
done

for name in SLACK_BOT_TOKEN SLACK_APP_TOKEN GITHUB_APP_ID \
  GITHUB_APP_INSTALLATION_ID GITHUB_APP_PRIVATE_KEY_BASE64; do
  append_if_set bridge_env "$name"
done

case "$provider" in
  codex) append_if_set agent_env OPENAI_API_KEY ;;
  claude)
    append_if_set agent_env CLAUDE_CODE_OAUTH_TOKEN
    append_if_set agent_env ANTHROPIC_API_KEY
    ;;
esac

prepare_runtime_dirs

if [[ "$provider" == "codex" ]]; then
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    log "Authenticating Codex with OPENAI_API_KEY"
    printf '%s\n' "$OPENAI_API_KEY" | run_as agent "${agent_env[@]}" codex login --with-api-key
  elif run_as agent "${agent_env[@]}" codex login status >/dev/null 2>&1; then
    log "Codex is already authenticated"
  else
    log "No Codex env credential found; starting device-code auth"
    run_as agent "${agent_env[@]}" codex login --device-auth
  fi
elif [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  log "Claude Code OAuth token found in the environment"
elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  log "Anthropic API key found in the environment"
elif run_as agent "${agent_env[@]}" claude auth status >/dev/null 2>&1; then
  log "Claude Code is already authenticated"
else
  log "No Claude Code credential found; set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"
fi

run_as_session agent "${agent_env[@]}" node /app/dist/providerWorker.js &
worker_pid=$!

socket_path="/run/patchdoll/providers/${provider}.sock"
for _ in {1..100}; do
  if [[ -S "$socket_path" ]] && [[ "$(stat -c '%a' "$socket_path" 2>/dev/null)" == "660" ]]; then
    break
  fi
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    wait "$worker_pid"
    exit $?
  fi
  sleep 0.1
done
if [[ ! -S "$socket_path" ]] || [[ "$(stat -c '%a' "$socket_path" 2>/dev/null)" != "660" ]]; then
  log "provider worker did not create ${socket_path}"
  kill -TERM "$worker_pid" 2>/dev/null || true
  wait "$worker_pid" || true
  exit 1
fi

run_as_session patchdoll "${bridge_env[@]}" "$@" &
bridge_pid=$!

# The children now own their deliberately separate copies of the environment.
# Drop secret-bearing shell variables from the long-lived root supervisor.
agent_env=()
bridge_env=()
common_env=()
unset OPENAI_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY \
  SLACK_BOT_TOKEN SLACK_APP_TOKEN GITHUB_APP_PRIVATE_KEY_BASE64 || true

set +e
wait -n -p exited_pid "$bridge_pid" "$worker_pid"
status=$?
set -e

log "child ${exited_pid:-unknown} exited with status ${status}; stopping container"
terminate_children
wait "$bridge_pid" 2>/dev/null || true
wait "$worker_pid" 2>/dev/null || true
exit "$status"
