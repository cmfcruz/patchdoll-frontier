// The agent preamble.
//
// This is the single most trust-relevant string in the bridge: it is the policy
// and context we hand the model for every Slack request. It lives in its own
// file (rather than buried in the Slack adapter) so a reviewer can audit exactly
// what the agent is told without reading transport plumbing.

import { agent } from "./agent.js";
import { githubConfigured } from "./config.js";

export type PromptInput = {
  /** Slack event type, e.g. "slack.app_mention". */
  type: string;
  /** The actor's Slack user id, if known. */
  actor?: string;
  /** A permalink back to the triggering message, if derivable. */
  permalink?: string;
  /** The thread context object (serialized into the prompt as JSON). */
  threadContext: unknown;
  /** The user's request text, with any leading bot mention already stripped. */
  text: string;
};

export function buildAgentPrompt(input: PromptInput): string {
  return [
    `You are ${agent.displayName} running as Eucleia for a Slack request.`,
    "Reply with a concise, Slack-ready answer.",
    "If you change files, include the changed paths and any checks you ran.",
    "Eucleia is configured by environment variables only; it has no runtime settings to change.",
    githubConfigured()
      ? "Before committing or pushing to github.com, call the Eucleia MCP tool `eucleia_enable_github` once; it sets the bot's git identity and credentials so normal git commands work."
      : undefined,
    "",
    `Slack event type: ${input.type}`,
    `Actor: ${input.actor ?? "unknown"}`,
    input.permalink ? `Permalink: ${input.permalink}` : undefined,
    "",
    "Thread context (JSON):",
    JSON.stringify(input.threadContext, null, 2),
    "",
    "User request:",
    input.text
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
