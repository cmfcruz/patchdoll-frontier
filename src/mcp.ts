// Minimal MCP (Model Context Protocol) server exposed over streamable HTTP.
//
// The active agent (Codex or Claude Code) connects to this endpoint to discover
// and call `ember_enable_github`. This build is configured by environment
// variables only, so there are no settings tools — the GitHub access tool is the
// sole tool we expose. We implement just the slice of the protocol the clients
// exercise: `initialize`, `tools/list`, `tools/call`, and the handshake
// notifications.
//
// IMPORTANT: JSON-RPC *notifications* (messages without an `id`, e.g.
// `notifications/initialized`) must be answered with an empty `202 Accepted`
// and never a response body. Returning a JSON-RPC error for a notification makes
// the client's MCP layer fail to deserialize the reply and tear down the whole
// connection.

import { messageOf } from "./config.js";
import { enableGithubAccess } from "./github.js";

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

/**
 * The HTTP-level result of handling one MCP message. A missing `body` means
 * "send the status code with no payload" (used for notification acks).
 */
export type McpHttpResponse = {
  status: number;
  body?: Record<string, unknown>;
};

const serverInfo = { name: "ember-bridge", version: "0.0.0" };

const githubTool = {
  name: "ember_enable_github",
  description:
    "Enable GitHub access for git. Call this once before committing or pushing to github.com; it configures the bot's git identity and a credential helper so normal git commands work. The token is never returned to you.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
};

const tools = [githubTool];

export async function handleMcpMessage(message: JsonRpcRequest): Promise<McpHttpResponse> {
  const id = message.id ?? null;

  // Notifications carry no `id` and expect no response body, just an ack.
  const isNotification =
    message.id === undefined ||
    (typeof message.method === "string" && message.method.startsWith("notifications/"));
  if (isNotification) {
    return { status: 202 };
  }

  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { status: 200, body: jsonRpcError(id, -32600, "invalid JSON-RPC request") };
  }

  switch (message.method) {
    case "initialize":
      return {
        status: 200,
        body: jsonRpcResult(id, {
          protocolVersion: "2025-06-18",
          serverInfo,
          capabilities: { tools: {} }
        })
      };

    case "tools/list":
      return { status: 200, body: jsonRpcResult(id, { tools }) };

    case "tools/call":
      return { status: 200, body: await callTool(id, message.params) };

    default:
      return { status: 200, body: jsonRpcError(id, -32601, "method not found") };
  }
}

async function callTool(id: JsonRpcId, params: JsonRpcRequest["params"]): Promise<Record<string, unknown>> {
  const name = params?.name;

  try {
    if (name === "ember_enable_github") {
      return jsonRpcResult(id, toolText(await enableGithubAccess()));
    }
    return jsonRpcError(id, -32602, `unknown tool: ${name ?? "(none)"}`);
  } catch (error) {
    // Surface tool failures to the model as an error result rather than crashing.
    return jsonRpcResult(id, {
      content: [{ type: "text", text: `error: ${messageOf(error)}` }],
      isError: true
    });
  }
}

function toolText(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }] };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
