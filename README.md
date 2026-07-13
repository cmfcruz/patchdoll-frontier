# patchdoll

A tiny communications bridge that runs **Codex** or **Claude Code** on request.
It listens for Slack @mentions and DMs (and a loopback HTTP `/agent` endpoint),
runs the configured agent against the `/workspace` tree, and streams the result
back into Slack.

This is the env-only frontier rebuild of the Patchdoll bridge: **all configuration
comes from environment variables**. There is no settings file and no runtime
mutation — to change the model or effort, restart with different env vars.

## Architecture

One provider is baked into each image variant (`PROVIDER`); nothing
branches on the provider at runtime beyond a single seam.

| File         | Responsibility |
|--------------|----------------|
| `bridge.ts`  | HTTP entry point: `/health`, read-only `/settings`, `/mcp`, `/github/credential`, `/agent`, plus startup/shutdown. |
| `agent.ts`   | The small `AgentProvider` interface and the active provider. The bridge, Slack, and MCP only talk to `agent`. |
| `config.ts`  | All environment-derived configuration, resolved once. The only module that reads `process.env`. |
| `codex.ts`   | Builds and runs `codex exec` with a scrubbed agent environment; maps its `--json` events to progress notes. |
| `claude.ts`  | Builds and runs `claude` (`stream-json`) with a scrubbed agent environment; maps its events to progress notes. |
| `stream.ts`  | Shared NDJSON line buffering used by both providers. |
| `mcp.ts`     | Minimal MCP server exposing the single `patchdoll_enable_github` tool. |
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

Timeouts (optional): `CODEX_TIMEOUT_MS`, `CLAUDE_TIMEOUT_MS` (default 30 min).

Logging: `LOG_LEVEL` (`error|warn|info|debug`, default `info`).

Slack (enables the adapter when both are set): `SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN`. See [docs/slack-bot-setup.md](docs/slack-bot-setup.md).

GitHub access (enables `patchdoll_enable_github` when all three are set):
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`,
`GITHUB_APP_PRIVATE_KEY_BASE64`. See [docs/github-access.md](docs/github-access.md).

Agent credentials:

- Codex: `OPENAI_API_KEY` is consumed by `scripts/entrypoint.sh` to log in the
  provider home, then normal runs use `/home/agent` state instead of inheriting
  the key.
- Claude: `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` are passed only to the
  Claude process because Claude Code needs them at run time unless stored auth is
  already configured.

## Scripts

- `npm run check` — typecheck only (`tsc --noEmit`).
- `npm run build` — compile to `dist/` (excludes tests).
- `npm test` — compile and run the unit tests with Node's built-in test runner.
- `npm start` — run the built bridge.

## Runtime boundary

The HTTP bridge is a **loopback-only control plane**, not a public API. See
[docs/runtime-boundary.md](docs/runtime-boundary.md).
