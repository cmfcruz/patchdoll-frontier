# Patchdoll runtime boundary

Patchdoll's HTTP bridge is a local control plane for the agent, not a public API.

The server exists so Slack can invoke the agent (Codex or Claude Code, depending
on the image variant) and so the agent can consume Patchdoll-only features through
loopback endpoints, namely temporary GitHub credentials. It is intended to be
Patchdoll's exclusive window to external systems from inside the runtime.

## Unix user model

The container runs as the non-root `patchdoll` user. The image also
creates an `agent` user with home directory `/home/agent` for provider auth and
state. There are no sudo rules and no runtime privilege-escalation path in the
image.

The provider spawn boundary passes an explicit environment whitelist. Slack and
GitHub App secrets stay in the bridge environment and are not inherited by Codex,
Claude Code, or tools those agents launch. Codex uses auth state under
`/home/agent`; Claude receives only its own provider credential env vars when
those vars are configured.

Because this no-sudo model keeps the bridge unprivileged, provider child
processes are still spawned by the bridge process rather than switched to the
`agent` Unix UID at request time. The active isolation boundary in this PR is the
scrubbed child environment plus bridge-only secret handling. A hard per-request
UID boundary would require a separate agent worker/supervisor or another narrow
privilege-transition mechanism.

This build is configured by environment variables only. `GET /settings` reports
the resolved configuration read-only; there is no endpoint or tool to mutate it
at runtime, so the configuration surface is fixed at process start.

## Binding model

By default the bridge binds to `127.0.0.1`, and the agent reaches it through
loopback URLs such as:

```text
http://127.0.0.1:3000/mcp
http://127.0.0.1:3000/github/credential
```

Do not bind the bridge to a public or untrusted interface. If a deployment ever
needs to listen beyond loopback, add an explicit authentication and authorization
layer before exposing `/settings`, `/mcp`, or `/github/credential`.

## Threat model

Normal agent commands do not inherit bridge secrets or sudo privileges. The
loopback endpoints are still privileged local integration points: they should
stay bound to loopback unless an explicit authentication and authorization layer
is added first.
