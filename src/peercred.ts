import { spawn } from "node:child_process";
import type { Socket } from "node:net";

export type PeerCredentials = { pid: number; uid: number; gid: number };

/** Read kernel-authenticated credentials for the process at the other end. */
export function readPeerCredentials(
  socket: Socket,
  helperPath = "/usr/local/bin/patchdoll-peercred"
): Promise<PeerCredentials> {
  const fd = socketFd(socket);
  if (fd === undefined) throw new Error("Unable to inspect Unix socket file descriptor");

  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { stdio: ["ignore", "pipe", "pipe", fd] });
    if (!child.stdout || !child.stderr) {
      reject(new Error("Peer credential helper did not expose output pipes"));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => reject(new Error(`Unable to run peer credential helper: ${error.message}`)));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Peer credential helper exited with ${code ?? "unknown"}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(parsePeerCredentials(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function parsePeerCredentials(value: string): PeerCredentials {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Peer credential helper returned invalid output");
  }
  const credentials = parsed as Record<string, unknown>;
  if (
    !Number.isInteger(credentials.pid) ||
    !Number.isInteger(credentials.uid) ||
    !Number.isInteger(credentials.gid)
  ) {
    throw new Error("Peer credential helper returned invalid output");
  }
  return credentials as PeerCredentials;
}

function socketFd(socket: Socket): number | undefined {
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
  return typeof handle?.fd === "number" ? handle.fd : undefined;
}
