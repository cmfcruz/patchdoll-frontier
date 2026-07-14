import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";

import type { AgentProvider } from "./agent.js";
import { gitAgentEnv, messageOf, provider, providerSocketPath } from "./config.js";
import { log } from "./log.js";
import { readPeerCredentials } from "./peercred.js";
import { parseWorkerRequest, readWorkerLine, writeWorkerMessage } from "./providerSocket.js";

export async function startProviderWorker(agent: AgentProvider): Promise<void> {
  const bridge = accountFor("patchdoll");
  await rm(providerSocketPath, { force: true });

  const server = createServer((socket) => {
    handleConnection(socket, agent, bridge.uid, bridge.gid).catch((error) => {
      if (!socket.destroyed) {
        writeWorkerMessage(socket, { type: "error", error: messageOf(error) });
        socket.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(providerSocketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(providerSocketPath, 0o660);
  log.info(`${provider} worker listening`, {
    socketPath: providerSocketPath,
    allowedUid: bridge.uid,
    allowedGid: bridge.gid,
    workerUid: process.getuid?.(),
    workerGid: process.getgid?.()
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${provider} worker stopping after ${signal}`);
    server.close(() => {
      void rm(providerSocketPath, { force: true }).finally(() => process.exit(0));
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

async function handleConnection(
  socket: Socket,
  agent: AgentProvider,
  allowedUid: number,
  allowedGid: number
): Promise<void> {
  const credentials = await readPeerCredentials(socket);
  if (credentials.uid !== allowedUid || credentials.gid !== allowedGid) {
    throw new Error(`Rejected ${provider} worker client uid=${credentials.uid} gid=${credentials.gid}`);
  }

  const request = parseWorkerRequest(await readWorkerLine(socket));
  if (request.type === "run") {
    const result = await agent.run({
      ...request.request,
      onProgress(note) {
        if (!socket.destroyed) writeWorkerMessage(socket, { type: "progress", note });
      }
    });
    writeWorkerMessage(socket, { type: "result", result });
  } else {
    await configureGithub(request.helperPath, request.identity);
    writeWorkerMessage(socket, { type: "configured" });
  }
  socket.end();
}

async function configureGithub(helperPath: string, identity: { name: string; email: string }): Promise<void> {
  const helper = `!node ${helperPath}`;
  await gitConfig("credential.helper", helper);
  await gitConfig("credential.https://github.com.helper", helper);
  await gitConfig("user.name", identity.name);
  await gitConfig("user.email", identity.email);
}

function gitConfig(key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["config", "--global", "--replace-all", key, value], {
      env: gitAgentEnv(),
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git config ${key} exited with code ${code}`))
    );
  });
}

function accountFor(name: string): { uid: number; gid: number } {
  for (const line of readFileSync("/etc/passwd", "utf8").split(/\r?\n/)) {
    const fields = line.split(":");
    if (fields[0] !== name) continue;
    const uid = Number.parseInt(fields[2], 10);
    const gid = Number.parseInt(fields[3], 10);
    if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
  }
  throw new Error(`Unable to resolve Unix account ${name}`);
}
