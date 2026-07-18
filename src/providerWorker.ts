import { execFile } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { promisify } from "node:util";

import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import {
  gitAgentEnv,
  githubCredentialHelperPath,
  messageOf,
  provider,
  providerSocketPath
} from "./config.js";
import { log } from "./log.js";
import { readPeerCredentials } from "./peercred.js";
import { parseWorkerRequest, readWorkerLine, writeWorkerMessage } from "./providerSocket.js";

const execFileAsync = promisify(execFile);
const agent = provider === "claude" ? claudeProvider : codexProvider;

async function startProviderWorker(): Promise<void> {
  const bridge = bridgeCredentials();
  await rm(providerSocketPath, { force: true });

  const server = createServer((socket) => {
    handleConnection(socket, bridge.uid, bridge.gid).catch((error) => {
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
    await configureGithub(request.identity);
    writeWorkerMessage(socket, { type: "configured" });
  }
  socket.end();
}

async function configureGithub(identity: { name: string; email: string }): Promise<void> {
  const helper = `!node ${githubCredentialHelperPath}`;
  await gitConfig("credential.helper", helper);
  await gitConfig("credential.https://github.com.helper", helper);
  await gitConfig("user.name", identity.name);
  await gitConfig("user.email", identity.email);
}

async function gitConfig(key: string, value: string): Promise<void> {
  await execFileAsync("git", ["config", "--global", "--replace-all", key, value], { env: gitAgentEnv() });
}

function bridgeCredentials(): { uid: number; gid: number } {
  const uid = Number(process.env.EUCLEIA_BRIDGE_UID);
  const gid = Number(process.env.EUCLEIA_BRIDGE_GID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error("Invalid bridge credentials");
  return { uid, gid };
}

await startProviderWorker();
