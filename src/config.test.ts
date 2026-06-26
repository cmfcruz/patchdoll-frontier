import { test } from "node:test";
import assert from "node:assert/strict";

type ConfigModule = typeof import("./config.js");

const envKeys = [
  "PROVIDER",
  "PORT",
  "LOG_LEVEL",
  "CODEX_TIMEOUT_MS",
  "CLAUDE_TIMEOUT_MS",
  "CODEX_REASONING_EFFORT",
  "CLAUDE_EFFORT",
  "CODEX_MODEL",
  "CLAUDE_MODEL",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY_BASE64",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "TERM"
];

let importId = 0;

async function importConfig(env: Record<string, string | undefined>): Promise<ConfigModule> {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));

  for (const key of envKeys) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return (await import(`./config.js?configTest=${++importId}`)) as ConfigModule;
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("config uses default numeric env values when unset", async () => {
  const config = await importConfig({ PROVIDER: "codex" });

  assert.equal(config.port, 3000);
  assert.equal(config.codexTimeoutMs, 1800000);
  assert.equal(config.claudeTimeoutMs, 1800000);
});

test("agent env only includes provider-safe values", async () => {
  const config = await importConfig({
    PROVIDER: "codex",
    SLACK_BOT_TOKEN: "xoxb-secret",
    SLACK_APP_TOKEN: "xapp-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
    GITHUB_APP_PRIVATE_KEY_BASE64: "private-key",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    ANTHROPIC_API_KEY: "anthropic-key",
    TERM: "vt100"
  });

  assert.deepEqual(config.codexAgentEnv(), {
    HOME: "/home/agent",
    USER: "patchdoll-bridge",
    LOGNAME: "patchdoll-bridge",
    PATH: "/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    TERM: "vt100",
    DISABLE_AUTOUPDATER: "1",
    CODEX_HOME: "/home/agent"
  });

  assert.deepEqual(config.claudeAgentEnv(), {
    HOME: "/home/agent",
    USER: "patchdoll-bridge",
    LOGNAME: "patchdoll-bridge",
    PATH: "/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    TERM: "vt100",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    ANTHROPIC_API_KEY: "anthropic-key"
  });
});

test("config accepts explicit integer port and timeout env values", async () => {
  const config = await importConfig({
    PROVIDER: "claude",
    PORT: "3456",
    CODEX_TIMEOUT_MS: "123",
    CLAUDE_TIMEOUT_MS: "456"
  });

  assert.equal(config.port, 3456);
  assert.equal(config.codexTimeoutMs, 123);
  assert.equal(config.claudeTimeoutMs, 456);
});

test("config validates log level env values", async () => {
  const config = await importConfig({ PROVIDER: "codex", LOG_LEVEL: "debug" });

  assert.equal(config.logLevel, "debug");
  await assert.rejects(() => importConfig({ PROVIDER: "codex", LOG_LEVEL: "verbose" }), /LOG_LEVEL must be/);
});

test("config reports missing Slack env vars by canonical name", async () => {
  const config = await importConfig({ PROVIDER: "codex" });

  assert.equal(config.slackEnabled(), false);
  assert.deepEqual(config.missingSlackEnvVars(), ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]);
});

test("config rejects malformed numeric env values instead of coercing them", async () => {
  await assert.rejects(() => importConfig({ PROVIDER: "codex", PORT: "3000abc" }), /PORT must be/);
  await assert.rejects(() => importConfig({ PROVIDER: "codex", PORT: "1.5" }), /PORT must be/);
  await assert.rejects(() => importConfig({ PROVIDER: "codex", CODEX_TIMEOUT_MS: "bad" }), /CODEX_TIMEOUT_MS must be/);
  await assert.rejects(() => importConfig({ PROVIDER: "codex", CLAUDE_TIMEOUT_MS: "0" }), /CLAUDE_TIMEOUT_MS must be/);
});

test("config reports incomplete GitHub App env without requiring it at startup", async () => {
  const missing = await importConfig({ PROVIDER: "codex", GITHUB_APP_ID: "123" });
  assert.equal(missing.githubConfigured(), false);
  assert.deepEqual(missing.missingGithubEnvVars(), [
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY_BASE64"
  ]);

  const complete = await importConfig({
    PROVIDER: "codex",
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
    GITHUB_APP_PRIVATE_KEY_BASE64: "base64-pem"
  });
  assert.equal(complete.githubConfigured(), true);
  assert.deepEqual(complete.missingGithubEnvVars(), []);
});
