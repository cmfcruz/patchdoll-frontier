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
  const raw = process.env.PROVIDER ?? "";
  const value = raw.trim().toLowerCase();
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new Error(
    `PROVIDER must be 'codex' or 'claude' (set by the image variant); got: '${raw}'`
  );
}

// --- HTTP bridge ---
export const host = process.env.HOST ?? "127.0.0.1";
export const port = parseIntegerEnv("PORT", process.env.PORT, 3000, 1, 65535, "a valid port number");

// --- Logging ---
export type LogLevel = "error" | "warn" | "info" | "debug";

const validLogLevels = new Set<LogLevel>(["error", "warn", "info", "debug"]);

export const logLevel: LogLevel = parseEnum("LOG_LEVEL", process.env.LOG_LEVEL, validLogLevels, "info") ?? "info";

// --- Workspace + shared agent plumbing ---
export const workspace = resolve("/workspace");
export const agentHome = "/home/agent";
export const agentPath = "/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin";
const agentTerm = process.env.TERM?.trim() || "xterm-256color";

// URL the agent uses to reach the Patchdoll MCP server we expose from this same
// process (the GitHub access tool). Always loopback — the MCP endpoint is a
// local control-plane path, never a public interface, regardless of HOST.
export const mcpUrl = `http://127.0.0.1:${port}/mcp`;

// --- Codex ---
export const codexBin = "codex";
export const codexTimeoutMs = parseIntegerEnv(
  "CODEX_TIMEOUT_MS",
  process.env.CODEX_TIMEOUT_MS,
  1800000,
  1,
  undefined,
  "a positive integer number of milliseconds"
);

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type CodexSettings = {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  memoryEnabled?: boolean;
};

const validReasoningEfforts = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
const defaultCodexModel = "gpt-5.6-sol";

// Resolved once from the environment. CODEX_MODEL/CODEX_REASONING_EFFORT are
// optional; when unset, Patchdoll supplies the baked-in Codex default model.
export const codexSettings: CodexSettings = tidy({
  model: process.env.CODEX_MODEL?.trim() || defaultCodexModel,
  reasoningEffort: parseEnum(
    "CODEX_REASONING_EFFORT",
    process.env.CODEX_REASONING_EFFORT,
    validReasoningEfforts,
    undefined
  ),
  memoryEnabled: parseBooleanEnv("CODEX_MEMORY_ENABLED", process.env.CODEX_MEMORY_ENABLED)
});
const openaiApiKey = process.env.OPENAI_API_KEY?.trim() || undefined;

// --- Claude Code ---
// The CLI flags match stabledaemons/patchdoll's Claude provider: headless `-p`
// stream-json with bypassPermissions (the only mode that never pauses for
// interactive approval in a non-interactive run).
export const claudeBin = "claude";
export const claudeTimeoutMs = parseIntegerEnv(
  "CLAUDE_TIMEOUT_MS",
  process.env.CLAUDE_TIMEOUT_MS,
  1800000,
  1,
  undefined,
  "a positive integer number of milliseconds"
);
export const claudePermissionMode = "bypassPermissions";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeSettings = {
  model?: string;
  effort?: ClaudeEffort;
  memoryEnabled?: boolean;
};

const validClaudeEfforts = new Set<ClaudeEffort>(["low", "medium", "high", "xhigh", "max"]);
const defaultClaudeModel = "claude-opus-4-8";

// Resolved once from the environment, with Patchdoll defaults for the model and
// effort. Env vars remain the only supported way to override them.
export const claudeSettings: ClaudeSettings = tidy({
  model: process.env.CLAUDE_MODEL?.trim() || defaultClaudeModel,
  effort: parseEnum("CLAUDE_EFFORT", process.env.CLAUDE_EFFORT, validClaudeEfforts, "high"),
  memoryEnabled: parseBooleanEnv("CLAUDE_MEMORY_ENABLED", process.env.CLAUDE_MEMORY_ENABLED)
});
const claudeCodeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;

// --- GitHub App (on-demand token for `git push`) ---
// When all three are set, the agent can call the `patchdoll_enable_github` MCP tool
// to wire up a git credential helper that fetches a short-lived installation
// token from this bridge on demand. The token is never handed to the model.
export const githubAppId = process.env.GITHUB_APP_ID;
export const githubInstallationId = process.env.GITHUB_APP_INSTALLATION_ID;
export const githubPrivateKeyBase64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;

// Home directory the bridge runs under; bridge-owned helpers live here.
export const bridgeHome = process.env.HOME ?? homedir();

// --- Slack ---
export const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim() || undefined;
export const slackAppToken = process.env.SLACK_APP_TOKEN?.trim() || undefined;

// Slack rejects messages longer than 4000 characters; stay comfortably under it.
export const maxSlackTextLength = 3900;

export function slackEnabled(): boolean {
  return Boolean(slackBotToken && slackAppToken);
}

export function missingSlackEnvVars(): string[] {
  const missing: string[] = [];
  if (!slackBotToken) missing.push("SLACK_BOT_TOKEN");
  if (!slackAppToken) missing.push("SLACK_APP_TOKEN");
  return missing;
}

export function githubConfigured(): boolean {
  return Boolean(githubAppId && githubInstallationId && githubPrivateKeyBase64);
}

export function missingGithubEnvVars(): string[] {
  const missing: string[] = [];
  if (!githubAppId) missing.push("GITHUB_APP_ID");
  if (!githubInstallationId) missing.push("GITHUB_APP_INSTALLATION_ID");
  if (!githubPrivateKeyBase64) missing.push("GITHUB_APP_PRIVATE_KEY_BASE64");
  return missing;
}

export function codexAgentEnv(): NodeJS.ProcessEnv {
  return baseAgentEnv({
    CODEX_HOME: agentHome,
    OPENAI_API_KEY: openaiApiKey
  });
}

export function claudeAgentEnv(): NodeJS.ProcessEnv {
  return baseAgentEnv({
    CLAUDE_CODE_OAUTH_TOKEN: claudeCodeOauthToken,
    ANTHROPIC_API_KEY: anthropicApiKey,
    // Claude's native switch is disable-shaped. Only synthesize it when the
    // Patchdoll override is explicit so an unset env keeps Claude's own default.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY:
      claudeSettings.memoryEnabled === undefined ? undefined : claudeSettings.memoryEnabled ? "0" : "1"
  });
}

export function gitAgentEnv(): NodeJS.ProcessEnv {
  return baseAgentEnv({});
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- env helpers ---

function parseIntegerEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number | undefined,
  description: string
): number {
  const value = raw?.trim();
  if (!value) return fallback;

  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    const range = max === undefined ? `>=${min}` : `${min}-${max}`;
    throw new Error(`${name} must be ${description} (${range}); got: '${value}'`);
  }

  return parsed;
}

function parseBooleanEnv(name: string, raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0; got: '${raw?.trim()}'`);
}

function baseAgentEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return tidy({
    HOME: agentHome,
    USER: "agent",
    LOGNAME: "agent",
    PATH: agentPath,
    TERM: agentTerm,
    DISABLE_AUTOUPDATER: "1",
    ...extra
  });
}

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
