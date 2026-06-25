// Everything related to running Claude Code: building the `claude` invocation
// from the env-resolved settings and turning its `stream-json` output into
// progress notes plus a final message. Mirrors codex.ts — the two are
// interchangeable image variants selected by PROVIDER.
//
// The CLI flags match cmfcruz/patchdoll's Claude provider: a headless `-p`
// stream-json run with `--permission-mode bypassPermissions` (the only mode
// that never pauses for interactive approval). We additionally point Claude at
// the Ember MCP server (the GitHub access tool) via `--mcp-config`.
//
// Configuration is env-only (see config.ts): no mutable settings, no settings
// tools — `claudeSettings` is resolved once at startup.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  claudeBin,
  claudePermissionMode,
  claudeSettings,
  claudeTimeoutMs,
  mcpUrl,
  type ClaudeSettings
} from "./config.js";
import { log } from "./log.js";
import { createLineParser, parseJsonObject } from "./stream.js";
import type { AgentProvider, AgentRunRequest, AgentRunResult, ProgressNote } from "./agent.js";

function buildClaudeArgs(settings: ClaudeSettings, model: string | undefined, prompt: string): string[] {
  const modelArg = model ?? settings.model;

  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    // stream-json with `-p` requires --verbose; --include-partial-messages adds
    // the token-level events. We only consume the milestone `assistant`/`result`
    // lines below, matching Codex's per-event progress granularity.
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    claudePermissionMode,
    // Headless runs can never answer an interactive picker.
    "--disallowedTools",
    "AskUserQuestion",
    // Expose the Ember MCP server (the GitHub access tool) over streamable HTTP.
    "--mcp-config",
    JSON.stringify({ mcpServers: { ember: { type: "http", url: mcpUrl } } })
  ];

  if (modelArg) {
    args.push("--model", modelArg);
  }
  if (settings.effort) {
    args.push("--effort", settings.effort);
  }

  return args;
}

export async function runClaude({ prompt, cwd, model, onProgress }: AgentRunRequest): Promise<AgentRunResult> {
  const runId = randomUUID();
  const args = buildClaudeArgs(claudeSettings, model, prompt);

  log.debug("claude invocation", {
    runId,
    cwd,
    model: model ?? claudeSettings.model,
    effort: claudeSettings.effort,
    promptChars: prompt.length,
    prompt: prompt.length > 2000 ? `${prompt.slice(0, 2000)}…[+${prompt.length - 2000} chars]` : prompt
  });

  const child = spawn(claudeBin, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let resultLine = "";
  const parser = createLineParser((line) => {
    const obj = parseJsonObject(line);
    if (!obj) return;
    if (obj.type === "result") {
      resultLine = line.trim();
    } else if (obj.type === "assistant") {
      emitAssistantProgress(obj, onProgress);
    }
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), claudeTimeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    parser.push(chunk);
  });

  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveChild, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => resolveChild({ code: exitCode, signal: exitSignal }));
    }
  );
  clearTimeout(timer);

  // Flush any partial line still buffered, then take the final answer from the
  // last `type: "result"` line of the stream.
  parser.flush();
  const message = messageFromResult(resultLine);

  log.debug("claude finished", { runId, code, signal, messageChars: message.length, stderrChars: stderr.length });

  return { runId, code, signal, settings: claudeSettings, message, stdout, stderr };
}

// Forward an `assistant` event's content blocks as progress notes: tool activity
// and visible text, matching Codex's `item.completed` granularity. Hidden
// reasoning and token-level deltas are ignored.
function emitAssistantProgress(obj: Record<string, unknown>, onProgress?: ProgressNote): void {
  if (!onProgress) return;
  const message = obj.message;
  if (typeof message !== "object" || message === null) return;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use" && typeof b.name === "string") {
      onProgress(toolNote(b.name, b.input));
    } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      onProgress(b.text);
    }
  }
}

/** Turn a Claude `tool_use` block into a short, Codex-style progress note. */
export function toolNote(name: string, input: unknown): string {
  if (name === "Bash" && input && typeof input === "object") {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === "string") return `$ ${command}`;
  }
  if (name.startsWith("mcp__")) return `Calling ${name}…`;
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    return "Editing files…";
  }
  return `Calling ${name}…`;
}

export function messageFromResult(resultLine: string): string {
  if (!resultLine) return "";
  try {
    const parsed = JSON.parse(resultLine) as { result?: unknown };
    return typeof parsed.result === "string" ? parsed.result : "";
  } catch {
    return "";
  }
}

export const claudeProvider: AgentProvider = {
  name: "claude",
  displayName: "Claude Code",
  settings: claudeSettings,
  run: runClaude
};
