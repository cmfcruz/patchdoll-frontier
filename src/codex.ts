// Everything related to running Codex: building the `codex exec` invocation from
// the env-resolved settings and turning its `--json` event stream into progress
// notes plus a final message.
//
// Configuration is env-only (see config.ts): there are no mutable settings and
// no settings tools — `codexSettings` is resolved once at startup.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { agentCommand } from "./agentProcess.js";
import { codexAgentEnv, codexBin, codexSettings, codexTimeoutMs, mcpUrl, type CodexSettings } from "./config.js";
import { log } from "./log.js";
import { createLineParser, parseJsonObject } from "./stream.js";
import type { AgentProvider, AgentRunRequest, AgentRunResult } from "./agent.js";

function buildCodexArgs(settings: CodexSettings, model: string | undefined, lastMessagePath: string): string[] {
  const args = ["exec", "--json"];

  const modelArg = model ?? settings.model;
  if (modelArg) {
    args.push("--model", modelArg);
  }
  if (settings.reasoningEffort) {
    args.push("--config", `model_reasoning_effort="${settings.reasoningEffort}"`);
  }

  // Expose the Patchdoll MCP server (the GitHub access tool) to Codex. A bare `url`
  // makes Codex use its streamable-HTTP MCP client automatically.
  args.push("--config", `mcp_servers.patchdoll.url="${mcpUrl}"`);

  args.push(
    "--config",
    "check_for_update_on_startup=false",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--color",
    "never",
    "--output-last-message",
    lastMessagePath,
    "-"
  );

  return args;
}

export async function runCodex({ prompt, cwd, model, onProgress }: AgentRunRequest): Promise<AgentRunResult> {
  const runId = randomUUID();
  const tempDir = await mkdtemp(`${tmpdir()}/patchdoll-${runId}-`);
  const lastMessagePath = `${tempDir}/last-message.txt`;
  const args = buildCodexArgs(codexSettings, model, lastMessagePath);

  log.debug("codex invocation", {
    runId,
    cwd,
    model: model ?? codexSettings.model,
    reasoningEffort: codexSettings.reasoningEffort,
    args,
    promptChars: prompt.length,
    prompt: prompt.length > 2000 ? `${prompt.slice(0, 2000)}…[+${prompt.length - 2000} chars]` : prompt
  });

  try {
    const command = agentCommand(codexBin, args);
    const child = spawn(command.command, command.args, {
      cwd,
      env: codexAgentEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const parser = createLineParser((line) => {
      const note = progressNoteFromEvent(line);
      if (note) onProgress?.(note);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), codexTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (onProgress) parser.push(chunk);
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.end(prompt);

    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveChild, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, exitSignal) => resolveChild({ code: exitCode, signal: exitSignal }));
      }
    );
    clearTimeout(timer);
    if (onProgress) parser.flush();

    // The canonical final answer comes from the --output-last-message file.
    const message = await readFile(lastMessagePath, "utf8").catch(() => "");

    log.debug("codex finished", { runId, code, signal, messageChars: message.length, stderrChars: stderr.length });

    return { runId, code, signal, settings: codexSettings, message, stdout, stderr };
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

/** Turn a single `codex exec --json` event line into a progress note, if any. */
export function progressNoteFromEvent(line: string): string | undefined {
  const event = parseJsonObject(line);
  if (!event || event.type !== "item.completed") return undefined;

  const item = event.item;
  if (typeof item !== "object" || item === null) return undefined;
  const obj = item as Record<string, unknown>;

  switch (obj.type) {
    case "command_execution":
      return typeof obj.command === "string" ? `$ ${obj.command}` : undefined;
    case "mcp_tool_call": {
      const tool = obj.tool ?? obj.name;
      return typeof tool === "string" ? `Calling ${tool}…` : undefined;
    }
    case "file_change":
      return "Editing files…";
    case "agent_message":
      return typeof obj.text === "string" && obj.text.trim() ? obj.text : undefined;
    default:
      return undefined;
  }
}

export const codexProvider: AgentProvider = {
  name: "codex",
  displayName: "Codex CLI",
  settings: codexSettings,
  run: runCodex
};
