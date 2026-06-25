// Central place for environment-derived configuration and a couple of tiny
// helpers that every module needs. Keeping this free of side effects (beyond
// reading process.env) makes the rest of the bridge easy to read and test.
//
// This build is configured by environment variables ONLY. There is no settings
// file and no runtime mutation: the model and reasoning effort are resolved once
// here, at startup, from the environment. To change them, restart with different
// env vars. That keeps the whole configuration surface auditable in one place.

import { homedir } from "node:os";
import { resolve } from "node:path";

// --- Provider selection ---
// Each image variant ships exactly one agent and bakes PROVIDER. There is
// no default: a missing or unknown value is a build/run misconfiguration, so we
// fail loudly at startup rather than silently picking one.
export type Provider = "codex" | "claude";

export const provider: Provider = resolveProvider();

function resolveProvider(): Provider {
  const value = (process.env.PROVIDER ?? "").trim().toLowerCase();
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new Error(
    `PROVIDER must be 'codex' or 'claude' (set by the image variant); got: '${process.env.PROVIDER ?? ""}'`
  );
}

// --- HTTP bridge ---
export const host = process.env.HOST ?? "127.0.0.1";
export const port = resolvePort();

function resolvePort(): number {
  const value = Number.parseInt(process.env.PORT ?? "3000", 10);
  if (!Number.isFinite(value) || value < 1 || value > 65535) {
    throw new Error(`PORT must be a valid port number (1–65535); got: '${process.env.PORT ?? ""}'`);
  }
  return value;
}

// --- Workspace + shared agent plumbing ---
export const workspace = resolve("/workspace");

// URL the agent uses to reach the Patchdoll MCP server we expose from this same
// process (the GitHub access tool). Always loopback — the MCP endpoint is a
// local control-plane path, never a public interface, regardless of HOST.
export const mcpUrl = `http://127.0.0.1:${port}/mcp`;

// --- Codex ---
export const codexBin = "codex";
export const codexTimeoutMs = Number.parseInt(process.env.CODEX_TIMEOUT_MS ?? "1800000", 10);

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type CodexSettings = {
  model?: string;
  reasoningEffort?: ReasoningEffort;
};

const validReasoningEfforts = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);

// Resolved once from the environment. CODEX_MODEL/CODEX_REASONING_EFFORT are
// optional; when unset, Codex falls back to its own defaults.
export const codexSettings: CodexSettings = tidy({
  model: process.env.CODEX_MODEL?.trim() || undefined,
  reasoningEffort: parseEnum(
    "CODEX_REASONING_EFFORT",
    process.env.CODEX_REASONING_EFFORT,
    validReasoningEfforts,
    undefined
  )
});

// --- Claude Code ---
// The CLI flags match cmfcruz/patchdoll's Claude provider: headless `-p`
// stream-json with bypassPermissions (the only mode that never pauses for
// interactive approval in a non-interactive run).
export const claudeBin = "claude";
export const claudeTimeoutMs = Number.parseInt(process.env.CLAUDE_TIMEOUT_MS ?? "1800000", 10);
export const claudePermissionMode = "bypassPermissions";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeSettings = {
  model?: string;
  effort?: ClaudeEffort;
};

const validClaudeEfforts = new Set<ClaudeEffort>(["low", "medium", "high", "xhigh", "max"]);

// Resolved once from the environment, with the same defaults Patchdoll shipped:
// model `sonnet`, effort `high`.
export const claudeSettings: ClaudeSettings = tidy({
  model: process.env.CLAUDE_MODEL?.trim() || "sonnet",
  effort: parseEnum("CLAUDE_EFFORT", process.env.CLAUDE_EFFORT, validClaudeEfforts, "high")
});

// --- GitHub App (on-demand token for `git push`) ---
// When all three are set, the agent can call the `patchdoll_enable_github` MCP tool
// to wire up a git credential helper that fetches a short-lived installation
// token from this bridge on demand. The token is never handed to the model.
export const githubAppId = process.env.GITHUB_APP_ID;
export const githubInstallationId = process.env.GITHUB_APP_INSTALLATION_ID;
export const githubPrivateKeyBase64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;

// Identity used for commits the agent makes. When unset, it is derived from the
// GitHub App's bot account so commits attribute correctly; these only override.
export const gitUserNameOverride = process.env.GIT_USER_NAME;
export const gitUserEmailOverride = process.env.GIT_USER_EMAIL;

// Home directory the agent runs under; the credential helper + git config live here.
export const patchdollHome = process.env.HOME ?? homedir();

// --- Slack ---
export const slackBotToken = process.env.SLACK_BOT_TOKEN;
export const slackAppToken = process.env.SLACK_APP_TOKEN;

// Slack rejects messages longer than 4000 characters; stay comfortably under it.
export const maxSlackTextLength = 3900;

export function slackEnabled(): boolean {
  return Boolean(slackBotToken && slackAppToken);
}

export function githubConfigured(): boolean {
  return Boolean(githubAppId && githubInstallationId && githubPrivateKeyBase64);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- env helpers ---

// Validate an optional enum-valued env var. An unset/blank value uses the
// fallback; a set-but-invalid value is a misconfiguration we fail loudly on
// (consistent with PROVIDER) so typos surface at startup, not at runtime.
function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  valid: Set<T>,
  fallback: T | undefined
): T | undefined {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!valid.has(value as T)) {
    throw new Error(`${name} must be one of: ${[...valid].join(", ")}; got: '${value}'`);
  }
  return value as T;
}

// Drop undefined keys so the resolved settings (echoed by GET /settings and the
// run diagnostics) stay tidy.
function tidy<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
