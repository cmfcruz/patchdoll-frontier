// The agent abstraction shared by the two image variants.
//
// This build ships one provider per image (see config.ts / EMBER_PROVIDER).
// Both codex.ts and claude.ts implement the small AgentProvider interface below,
// and `agent` resolves to whichever one this image was built for. The bridge,
// the Slack adapter, and the MCP server only ever talk to `agent`, so nothing
// else has to branch on the provider.
//
// Configuration is env-only (config.ts), so there are no settings tools here:
// the provider's resolved settings are read-only diagnostics, exposed for the
// GET /settings endpoint and the run result.

import { provider, type Provider } from "./config.js";
import { codexProvider } from "./codex.js";
import { claudeProvider } from "./claude.js";

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

/** The single provider this image variant runs. */
export const agent: AgentProvider = provider === "claude" ? claudeProvider : codexProvider;
