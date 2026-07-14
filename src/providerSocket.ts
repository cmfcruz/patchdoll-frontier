import { createConnection, type Socket } from "node:net";

import { messageOf, provider, providerSocketPath } from "./config.js";
import type { AgentRunRequest, AgentRunResult, GitIdentity } from "./agent.js";

export type WorkerRequest =
  | {
      type: "run";
      request: Omit<AgentRunRequest, "onProgress">;
    }
  | {
      type: "configure-github";
      helperPath: string;
      identity: GitIdentity;
    };

export type WorkerMessage =
  | { type: "progress"; note: string }
  | { type: "result"; result: AgentRunResult }
  | { type: "configured" }
  | { type: "error"; error: string };

export function runProviderWorker(request: AgentRunRequest, timeoutMs: number): Promise<AgentRunResult> {
  return exchangeWorker(
    { type: "run", request: { prompt: request.prompt, cwd: request.cwd, model: request.model } },
    timeoutMs,
    (message) => {
      if (message.type === "progress") request.onProgress?.(message.note);
    }
  ).then((message) => {
    if (message.type !== "result") throw new Error(`${provider} worker returned an unexpected response`);
    return message.result;
  });
}

export function configureWorkerGithub(helperPath: string, identity: GitIdentity): Promise<void> {
  return exchangeWorker({ type: "configure-github", helperPath, identity }, 30000).then((message) => {
    if (message.type !== "configured") throw new Error(`${provider} worker returned an unexpected response`);
  });
}

function exchangeWorker(
  request: WorkerRequest,
  timeoutMs: number,
  onMessage?: (message: WorkerMessage) => void
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(providerSocketPath);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${provider} worker timed out after ${timeoutMs}ms`)));
      socket.destroy();
    }, timeoutMs);

    function finish(callback: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    }

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let message: WorkerMessage;
        try {
          message = parseWorkerMessage(line);
        } catch (error) {
          finish(() => reject(new Error(`${provider} worker sent an invalid message: ${messageOf(error)}`)));
          socket.destroy();
          return;
        }

        if (message.type === "progress") {
          try {
            onMessage?.(message);
          } catch {
            // Progress is best effort; result delivery must not depend on it.
          }
          continue;
        }
        if (message.type === "error") {
          finish(() => reject(new Error(message.error)));
          socket.destroy();
          return;
        }

        finish(() => resolve(message));
        socket.end();
        return;
      }
    });
    socket.once("error", (error) =>
      finish(() => reject(new Error(`${provider} worker socket failed: ${error.message}`)))
    );
    socket.once("close", () =>
      finish(() => reject(new Error(`${provider} worker closed without a response`)))
    );
  });
}

export function parseWorkerRequest(line: string): WorkerRequest {
  const value = parseObject(line, "worker request");
  if (value.type === "run" && isObject(value.request)) {
    const prompt = value.request.prompt;
    const cwd = value.request.cwd;
    const model = value.request.model;
    if (typeof prompt !== "string" || typeof cwd !== "string" || (model !== undefined && typeof model !== "string")) {
      throw new Error("Invalid worker run request");
    }
    return { type: "run", request: { prompt, cwd, model } };
  }
  if (value.type === "configure-github" && typeof value.helperPath === "string" && isObject(value.identity)) {
    const name = value.identity.name;
    const email = value.identity.email;
    if (typeof name === "string" && typeof email === "string") {
      return { type: "configure-github", helperPath: value.helperPath, identity: { name, email } };
    }
  }
  throw new Error("Invalid worker request");
}

export function parseWorkerMessage(line: string): WorkerMessage {
  const value = parseObject(line, "worker message");
  if (value.type === "progress" && typeof value.note === "string") return { type: "progress", note: value.note };
  if (value.type === "error" && typeof value.error === "string") return { type: "error", error: value.error };
  if (value.type === "configured") return { type: "configured" };
  if (value.type === "result" && isObject(value.result)) {
    const result = value.result;
    if (
      typeof result.runId === "string" &&
      (typeof result.code === "number" || result.code === null) &&
      (typeof result.signal === "string" || result.signal === null) &&
      isObject(result.settings) &&
      typeof result.message === "string" &&
      typeof result.stdout === "string" &&
      typeof result.stderr === "string"
    ) {
      return { type: "result", result: result as unknown as AgentRunResult };
    }
  }
  throw new Error("Invalid worker message");
}

export function readWorkerLine(socket: Socket, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxBytes) {
        reject(new Error("Worker request exceeded the size limit"));
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline !== -1) resolve(buffer.slice(0, newline));
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("Worker client closed before sending a request")));
  });
}

export function writeWorkerMessage(socket: Socket, message: WorkerMessage): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function parseObject(line: string, description: string): Record<string, unknown> {
  const value = JSON.parse(line) as unknown;
  if (!isObject(value)) throw new Error(`Invalid ${description}`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
