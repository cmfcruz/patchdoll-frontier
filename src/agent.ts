// The bridge-side agent abstraction.
//
// Providers no longer run as children of the bridge. The bridge talks over an
// authenticated Unix socket to a provider worker running as the `agent` Unix
// user. This keeps the public interface small while making the UID boundary
// real rather than an environment-variable convention.
//
// Configuration is env-only (config.ts), so there are no settings tools here:
// the provider's resolved settings are read-only diagnostics, exposed for the
// GET /settings endpoint and the run result.

import {
  claudeSettings,
  codexSettings,
  provider,
  providerTimeoutMs,
  type Provider
} from "./config.js";
import { configureWorkerGithub, runProviderWorker } from "./providerSocket.js";

/** A short, human-readable progress note streamed while the agent works. */
export type ProgressNote = (note: string) => void;

export type AgentRunRequest = {
  prompt: string;
  cwd: string;
  model?: string;
  onProgress?: ProgressNote;
};

export type AgentRunResult = {
  runId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The provider's resolved (env-derived) settings for this run, for diagnostics. */
  settings: object;
  /** The assistant's final message. */
  message: string;
  /** Raw stdout/stderr, kept for diagnostics. */
  stdout: string;
  stderr: string;
};

export interface AgentProvider {
  /** Stable identifier used in logs and error text. */
  readonly name: Provider;
  /** Display name used in the prompt preamble (e.g. "Codex CLI"). */
  readonly displayName: string;
  /** Resolved env-derived settings, surfaced read-only by GET /settings. */
  readonly settings: object;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

const displayName = provider === "claude" ? "Claude Code" : "Codex CLI";

/** Bridge-side proxy for the single provider baked into this image. */
export const agent: AgentProvider = {
  name: provider,
  displayName,
  settings: provider === "claude" ? claudeSettings : codexSettings,
  run(request) {
    return runProviderWorker(request, providerTimeoutMs + 5000);
  }
};

export type GitIdentity = { name: string; email: string };

/** Ask the agent-owned worker to update the agent-owned global git config. */
export function configureAgentGithub(helperPath: string, identity: GitIdentity): Promise<void> {
  return configureWorkerGithub(helperPath, identity);
}
