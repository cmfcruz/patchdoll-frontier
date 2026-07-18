# Eucleia runtime boundary

Eucleia's HTTP bridge is a local control plane for the agent, not a public API.
It receives Slack events and exposes the MCP and temporary GitHub credential
endpoints used by the configured provider.

## Unix user model

The container starts `tini` and a small launcher as root. The launcher performs
only startup ownership migration, provider authentication, privilege dropping,
signal forwarding, and child reaping. It starts two long-lived children:

```text
bridge          uid=eucleia  gid=eucleia  supplementary=eucleia-ipc
provider worker uid=agent      gid=agent      supplementary=eucleia-ipc
```

Both children are launched with `setpriv --reuid/--regid --init-groups`; setting
`USER` and `HOME` is not treated as a Unix identity change. Neither child keeps
root privileges or Linux setuid/setgid capabilities.

The launcher gives each child an explicit environment whitelist. Slack tokens
and the GitHub App private key go only to the bridge. OpenAI or Anthropic
credentials go only to the provider worker. Codex, Claude Code, and all tools
they launch inherit the actual `agent` UID/GID and a provider-safe environment.

At startup, persistent `/home/agent` and `/workspace` mounts are migrated to the
`agent` UID. Agent state is private (`0700`); workspace directories are setgid
and group-writable for deliberate bridge/agent collaboration. This migration is
intentional and may recursively change legacy volume ownership.

## Provider IPC

The bridge sends one NDJSON request per connection to:

```text
/run/eucleia/providers/<provider>.sock
```

The worker streams progress messages followed by a result or error. The socket
is owned by `agent:eucleia-ipc` with mode `0660`. Before parsing a request, the
worker asks the kernel for the peer process's PID, UID, and GID with
`SO_PEERCRED`; only the `eucleia` account is accepted. Protocol identity fields
cannot spoof this check.

`eucleia_enable_github` keeps long-lived GitHub App secrets and token minting
in the bridge. The bridge writes a read-only credential helper under its runtime
directory, then asks the worker over the same authenticated socket to configure
the agent-owned global git config. Git later obtains short-lived credentials
from the loopback bridge endpoint.

## Binding model

By default the bridge binds to `127.0.0.1`, and the agent reaches it through:

```text
http://127.0.0.1:3000/mcp
http://127.0.0.1:3000/github/credential
```

Do not bind the bridge to a public or untrusted interface. If a deployment must
listen beyond loopback, add authentication and authorization before exposing
`/settings`, `/mcp`, or `/github/credential`.

## Invocation gate

Slack requests pass a fail-closed allowlist before any agent work starts:
only user IDs in `EUCLEIA_ADMINS` or `EUCLEIA_TRUSTED_USERS` may invoke
Eucleia, decided on the current message's actor only (never thread
participants or quoted transcript content, which are untrusted data). Startup
fails when Slack is enabled and both lists are empty. The loopback control
plane endpoints are not gated; they are reachable only from inside the
container by design.

## Threat model

The UID split prevents the network-facing bridge from creating agent-owned
state and prevents provider processes from reading the bridge's environment or
private runtime files. It is not a sandbox around model commands: the agent is
deliberately allowed to modify `/workspace`, use the local MCP integration, and
run arbitrary tools as the `agent` user. Shared group-writable workspace access
is collaboration, not mutual filesystem isolation.

Configuration remains environment-only. `GET /settings` is read-only; there is
no runtime endpoint or tool that mutates model settings.
