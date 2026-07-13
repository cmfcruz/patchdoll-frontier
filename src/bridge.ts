// Bridge entry point.
//
// Runs a small local HTTP bridge (health, read-only settings, the agent MCP
// endpoint, and GitHub credentials) and, when configured, the Slack adapter.
// This is a loopback-only control plane, not a public API; see
// docs/runtime-boundary.md for the intended trust boundary. The actual behaviour
// lives in focused modules:
//
//   config.ts  – environment configuration and shared helpers (env-only)
//   agent.ts   – the AgentProvider interface + the active provider
//   codex.ts   – Codex invocation + `codex exec` event stream
//   claude.ts  – Claude Code invocation + stream-json output
//   stream.ts  – shared NDJSON line buffering for both providers
//   mcp.ts     – the MCP server the agent talks to (GitHub access tool)
//   prompt.ts  – the agent preamble handed to the model
//   slack.ts   – the Slack bridge and reply model
//
// This build is configured by environment variables only: GET /settings reports
// the resolved configuration but there is no way to mutate it at runtime.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { githubConfigured, host, messageOf, missingGithubEnvVars, port, slackEnabled } from "./config.js";
import { agent } from "./agent.js";
import { gitCredentialResponse } from "./github.js";
import { log, logLevel } from "./log.js";
import { handleMcpMessage, type JsonRpcRequest } from "./mcp.js";
import { startSlackApp } from "./slack.js";

const server = createServer(async (req, res) => {
  try {
    log.debug("http request", { method: req.method, url: req.url });

    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true, provider: agent.name, slackEnabled: slackEnabled() });
    }

    // Read-only: the resolved, env-derived settings. There is no PATCH; restart
    // with different env vars to change configuration.
    if (req.method === "GET" && req.url === "/settings") {
      return sendJson(res, 200, agent.settings);
    }

    if (req.url === "/mcp") {
      return await handleMcpRoute(req, res);
    }

    // Loopback-only: the git credential helper the agent installs fetches a
    // short-lived GitHub token here. The token is handed straight to git.
    if (req.method === "GET" && req.url === "/github/credential") {
      const body = await gitCredentialResponse();
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
      return;
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    return sendJson(res, 500, { error: messageOf(error) });
  }
});

async function handleMcpRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Codex may open a GET stream for server-initiated messages; we don't push
  // any, so signal that cleanly instead of 404-ing.
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }

  const message = (await readJson(req)) as JsonRpcRequest;
  const response = await handleMcpMessage(message);

  if (response.body === undefined) {
    res.writeHead(response.status);
    res.end();
    return;
  }

  return sendJson(res, response.status, response.body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json)
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Startup & shutdown
// ---------------------------------------------------------------------------

const slackApp = await startSlackApp();
logGithubConfiguration();

server.listen(port, host, () => {
  log.info(`patchdoll bridge listening on ${host}:${port} (provider: ${agent.name}, log level: ${logLevel})`);
});

function logGithubConfiguration(): void {
  if (githubConfigured()) {
    log.info("github app integration enabled");
    return;
  }

  log.info(`github app integration disabled; missing ${missingGithubEnvVars().join(", ")}`);
}

let shuttingDown = false;
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`patchdoll bridge stopping after ${signal}`);

  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();

  try {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (slackApp) await slackApp.stop();
    clearTimeout(forceExit);
    process.exit(0);
  } catch {
    clearTimeout(forceExit);
    process.exit(1);
  }
}
