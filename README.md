# eucleia

A tiny communications bridge that runs **Codex** or **Claude Code** on request.
It listens for Slack @mentions and DMs, runs the configured agent against the
`/workspace` tree, and streams the result back into Slack.

Eucleia is an env-only rebuild of the upstream
[Patchdoll](https://github.com/stabledaemons/patchdoll) bridge: **all configuration
comes from environment variables**. There is no settings file and no runtime
mutation — to change the model or effort, restart with different env vars.

## Architecture

One provider is baked into each image variant (`PROVIDER`). A root startup
supervisor launches the communications bridge as `eucleia` and the provider
worker as `agent`; after startup, neither child has privilege-changing powers.

```text
tini -> root supervisor -> bridge (eucleia UID)
                       `-> provider worker (agent UID) -> Codex or Claude Code
```

The bridge and worker communicate over a filesystem-permissioned Unix socket.
The worker verifies every client using Linux `SO_PEERCRED`, so identity is never
trusted from the request payload.

| File         | Responsibility |
|--------------|----------------|
| `bridge.ts`  | HTTP entry point: `/health`, read-only `/settings`, `/mcp`, `/github/credential`, plus startup/shutdown. |
| `agent.ts`   | The `AgentProvider` interface and bridge-side worker proxy. |
| `providerSocket.ts` | NDJSON request/progress/result protocol over the provider Unix socket. |
| `providerWorker.ts` | Agent-owned socket server/entry point, peer-credential check, and agent-owned git configuration. |
| `peercred.ts` | Wrapper around the tiny `SO_PEERCRED` helper. |
| `config.ts`  | User-facing environment configuration, resolved once. |
| `gate.ts`    | Fail-closed invocation gate: who may drive Eucleia from Slack at all. |
| `codex.ts`   | Builds and runs `codex exec` with a scrubbed agent environment; maps its `--json` events to progress notes. |
| `claude.ts`  | Builds and runs `claude` (`stream-json`) with a scrubbed agent environment; maps its events to progress notes. |
| `process.ts` | Shared provider subprocess lifecycle, output capture, and timeout handling. |
| `stream.ts`  | Shared NDJSON line buffering used by both providers. |
| `mcp.ts`     | Minimal MCP server exposing the single `eucleia_enable_github` tool. |
| `github.ts`  | On-demand GitHub App installation token + git credential helper. |
| `prompt.ts`  | The agent preamble — the policy/context handed to the model. |
| `slack.ts`   | Slack adapter and the throttled-edit / chunked-reply delivery model. |
| `log.ts`     | Tiny leveled logger. |

## Configuration

Set by the image variant (do not override):

- `PROVIDER` — `codex` or `claude`. Baked into the image; required.

HTTP bridge:

- `HOST` (default `127.0.0.1`), `PORT` (default `3000`).

Model / effort (optional):

- Codex: `CODEX_MODEL` (default `gpt-5.6-sol`), `CODEX_REASONING_EFFORT` (`minimal|low|medium|high|xhigh`).
- Claude: `CLAUDE_MODEL` (default `claude-opus-4-8`), `CLAUDE_EFFORT` (`low|medium|high|xhigh|max`, default `high`).
- An invalid effort value fails loudly at startup.

Cross-run memory (optional):

- `CODEX_MEMORY_ENABLED` (`true|false|1|0`) controls Codex's experimental
  `memories` feature.
- `CLAUDE_MEMORY_ENABLED` (`true|false|1|0`) controls Claude Code auto-memory.
- When either variable is unset, that provider keeps its native default. Set it
  to `true` to force memory on or `false` to force memory off.

Provider memory is stored under `/home/agent`. Persist that directory as a
volume if memories must survive container replacement.

Timeouts (optional): `CODEX_TIMEOUT_MS`, `CLAUDE_TIMEOUT_MS` (default 30 min).

Logging: `LOG_LEVEL` (`error|warn|info|debug`, default `info`).

Slack (enables the adapter when both are set): `SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN`. See [docs/slack-bot-setup.md](docs/slack-bot-setup.md).

Invocation policy (required when Slack is enabled): `EUCLEIA_ADMINS` and
`EUCLEIA_TRUSTED_USERS` — comma-separated Slack user IDs (for example
`U0123ABCD,U0456EFGH`). The gate fails closed: only listed users can invoke
Eucleia, admins are implicitly trusted, and startup fails if Slack is enabled
while both lists are empty. Admins currently carry no extra runtime powers;
privileged operations added later must gate on `EUCLEIA_ADMINS`.

GitHub access (enables `eucleia_enable_github` when all three are set):
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`,
`GITHUB_APP_PRIVATE_KEY_BASE64`. See [docs/github-access.md](docs/github-access.md).

Agent credentials:

- Codex: `OPENAI_API_KEY` is used by `scripts/entrypoint.sh` for login and is
  passed only to the agent worker and Codex processes at run time.
- Claude: `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` are passed only to the
  agent worker and Claude process because Claude Code needs them at run time
  unless stored auth is already configured.

Slack and GitHub App secrets are passed only to the `eucleia` bridge. Provider
credentials are passed only to the `agent` worker. The root supervisor clears
its shell copies after both children start.

## Scripts

- `npm run check` — typecheck only (`tsc --noEmit`).
- `npm run build` — compile to `dist/` (excludes tests).
- `npm test` — compile and run the unit tests with Node's built-in test runner.
- `npm start` — run the built bridge.

## Runtime boundary

The HTTP bridge is a **loopback-only control plane**, not a public API. See
[docs/runtime-boundary.md](docs/runtime-boundary.md).
