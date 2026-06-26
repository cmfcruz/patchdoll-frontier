// On-demand GitHub access for the agent.
//
// Instead of injecting a GitHub token into every agent environment, we mint a
// short-lived GitHub App *installation token* only when git actually needs it.
// The flow:
//
//   1. The agent calls the `patchdoll_enable_github` MCP tool (see mcp.ts), which
//      calls `enableGithubAccess()` here to install a git credential helper.
//   2. When the agent later runs `git push`, git invokes that helper, which makes
//      a loopback request to the bridge's `GET /github/credential` endpoint.
//   3. `gitCredentialResponse()` mints (or reuses a cached) installation token
//      and returns it to git in the credential-helper format.
//
// The token is handed straight to git and never returned to the model, so it
// can't leak into the transcript, a Slack reply, or `.git/config`.

import { spawn } from "node:child_process";
import { createSign } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  bridgeHome,
  gitAgentEnv,
  githubAppId,
  githubConfigured,
  githubInstallationId,
  githubPrivateKeyBase64,
  port
} from "./config.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

// Reuse a minted token for 30 minutes. GitHub installation tokens live ~1 hour,
// so this leaves comfortable margin while avoiding a mint on every git auth.
const TOKEN_FRESHNESS_MS = 30 * 60 * 1000;

const helperPath = join(bridgeHome, ".patchdoll", "git-credential-patchdoll.cjs");

type GitIdentity = { name: string; email: string };

let cached: { token: string; fetchedAt: number } | undefined;
let cachedIdentity: GitIdentity | undefined;

/**
 * Install a git credential helper and the bot's commit identity so that git
 * commits/pushes to github.com authenticate via this bridge. Idempotent.
 */
export async function enableGithubAccess(): Promise<string> {
  if (!githubConfigured()) {
    throw new Error(
      "GitHub App is not configured; set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_BASE64"
    );
  }

  // Acquire the token (this also validates the credentials, failing fast with a
  // clear error) and derive the commit identity from the same GitHub session.
  const token = await getInstallationToken();
  const identity = await resolveGitIdentity(token);

  await writeCredentialHelper();
  await gitConfig("credential.helper", `!node ${helperPath}`);
  await gitConfig("credential.https://github.com.helper", `!node ${helperPath}`);
  await gitConfig("user.name", identity.name);
  await gitConfig("user.email", identity.email);

  return `GitHub access enabled as ${identity.name} <${identity.email}>. git commits and pushes to github.com now authenticate via a short-lived installation token.`;
}

/**
 * Resolve the git identity from the GitHub App bot account (e.g.
 * `my-app[bot]` / `<id>+my-app[bot]@users.noreply.github.com`) so commits
 * attribute correctly.
 */
async function resolveGitIdentity(token: string): Promise<GitIdentity> {
  if (!cachedIdentity) {
    const slug = await fetchAppSlug();
    const login = `${slug}[bot]`;
    const userId = await fetchUserId(login, token);
    cachedIdentity = { name: login, email: `${userId}+${login}@users.noreply.github.com` };
  }

  return cachedIdentity;
}

async function fetchAppSlug(): Promise<string> {
  const body = (await githubGet("/app", `Bearer ${githubAppJwt()}`)) as { slug?: unknown };
  if (typeof body.slug !== "string" || !body.slug) {
    throw new Error("GitHub /app response did not include an app slug");
  }
  return body.slug;
}

async function fetchUserId(login: string, token: string): Promise<number> {
  const body = (await githubGet(`/users/${encodeURIComponent(login)}`, `Bearer ${token}`)) as {
    id?: unknown;
  };
  if (typeof body.id !== "number") {
    throw new Error(`GitHub /users/${login} response did not include a numeric id`);
  }
  return body.id;
}

/** Body for the bridge's `GET /github/credential` endpoint (git helper format). */
export async function gitCredentialResponse(): Promise<string> {
  if (!githubConfigured()) {
    return "";
  }

  const token = await getInstallationToken();
  return [
    "protocol=https",
    "host=github.com",
    "username=x-access-token",
    `password=${token}`,
    ""
  ].join("\n");
}

async function getInstallationToken(): Promise<string> {
  if (cached && Date.now() - cached.fetchedAt < TOKEN_FRESHNESS_MS) {
    return cached.token;
  }

  const token = await requestInstallationToken();
  cached = { token, fetchedAt: Date.now() };
  return token;
}

async function requestInstallationToken(): Promise<string> {
  const path = `/app/installations/${encodeURIComponent(githubInstallationId as string)}/access_tokens`;
  const body = (await githubRequest("POST", path, `Bearer ${githubAppJwt()}`)) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    throw new Error("GitHub installation token response did not include a token");
  }
  return body.token;
}

function githubGet(path: string, authorization: string): Promise<unknown> {
  return githubRequest("GET", path, authorization);
}

async function githubRequest(method: string, path: string, authorization: string): Promise<unknown> {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization,
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": "patchdoll-bridge"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} failed with HTTP ${response.status}`);
  }

  return response.json();
}

function githubAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: now - 60, exp: now + 9 * 60, iss: githubAppId });
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).end().sign(decodePrivateKey());

  return `${unsigned}.${base64Url(signature)}`;
}

function decodePrivateKey(): string {
  const decoded = Buffer.from(githubPrivateKeyBase64 as string, "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY_BASE64 must be the base64 of a PEM private key");
  }
  return decoded;
}

async function writeCredentialHelper(): Promise<void> {
  // A tiny Node helper (no curl dependency) that answers git's "get" request by
  // forwarding the bridge's credential response. store/erase are no-ops.
  const script = `#!/usr/bin/env node
"use strict";
// Generated by the Patchdoll bridge. Fetches a GitHub credential on demand.
if (process.argv[2] !== "get") process.exit(0);
require("node:http")
  .request({ host: "127.0.0.1", port: ${port}, path: "/github/credential", method: "GET" }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => process.stdout.write(body));
  })
  .on("error", () => process.exit(0))
  .end();
`;

  await mkdir(dirname(helperPath), { recursive: true, mode: 0o755 });
  await chmod(dirname(helperPath), 0o755);
  await writeFile(helperPath, script, { mode: 0o755 });
  await chmod(helperPath, 0o755);
}

function gitConfig(key: string, value: string): Promise<void> {
  return new Promise((resolveConfig, reject) => {
    const child = spawn("git", ["config", "--global", key, value], {
      env: gitAgentEnv(),
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolveConfig() : reject(new Error(`git config ${key} exited with code ${code}`))
    );
  });
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
