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
  "CODEX_MEMORY_ENABLED",
  "CLAUDE_MEMORY_ENABLED",
  "OPENAI_API_KEY",
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

test("config uses frontier model defaults with env overrides", async () => {
  const defaults = await importConfig({ PROVIDER: "codex" });

  assert.deepEqual(defaults.codexSettings, { model: "gpt-5.6-sol" });
  assert.deepEqual(defaults.claudeSettings, { model: "claude-opus-4-8", effort: "high" });

  const explicit = await importConfig({
    PROVIDER: "claude",
    CODEX_MODEL: "codex-custom",
    CLAUDE_MODEL: "claude-custom"
  });

  assert.equal(explicit.codexSettings.model, "codex-custom");
  assert.equal(explicit.claudeSettings.model, "claude-custom");
});

test("config parses optional provider memory overrides", async () => {
  const defaults = await importConfig({ PROVIDER: "codex" });
  assert.equal(defaults.codexSettings.memoryEnabled, undefined);
  assert.equal(defaults.claudeSettings.memoryEnabled, undefined);

  const enabled = await importConfig({
    PROVIDER: "codex",
    CODEX_MEMORY_ENABLED: "true",
    CLAUDE_MEMORY_ENABLED: "1"
  });
  assert.equal(enabled.codexSettings.memoryEnabled, true);
  assert.equal(enabled.claudeSettings.memoryEnabled, true);

  const disabled = await importConfig({
    PROVIDER: "claude",
    CODEX_MEMORY_ENABLED: "false",
    CLAUDE_MEMORY_ENABLED: "0"
  });
  assert.equal(disabled.codexSettings.memoryEnabled, false);
  assert.equal(disabled.claudeSettings.memoryEnabled, false);
});

test("config rejects malformed provider memory overrides", async () => {
  await assert.rejects(
    () => importConfig({ PROVIDER: "codex", CODEX_MEMORY_ENABLED: "yes" }),
    /CODEX_MEMORY_ENABLED must be/
  );
  await assert.rejects(
    () => importConfig({ PROVIDER: "claude", CLAUDE_MEMORY_ENABLED: "enabled" }),
    /CLAUDE_MEMORY_ENABLED must be/
  );
});

test("agent env only includes provider-safe values", async () => {
  const config = await importConfig({
    PROVIDER: "codex",
    SLACK_BOT_TOKEN: "xoxb-secret",
    SLACK_APP_TOKEN: "xapp-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
    GITHUB_APP_PRIVATE_KEY_BASE64: "private-key",
    OPENAI_API_KEY: "openai-key",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    ANTHROPIC_API_KEY: "anthropic-key",
    TERM: "vt100"
  });

  assert.deepEqual(config.codexAgentEnv(), {
    HOME: "/home/agent",
    USER: "agent",
    LOGNAME: "agent",
    PATH: "/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    TERM: "vt100",
    DISABLE_AUTOUPDATER: "1",
    CODEX_HOME: "/home/agent",
    OPENAI_API_KEY: "openai-key"
  });

  assert.deepEqual(config.claudeAgentEnv(), {
    HOME: "/home/agent",
    USER: "agent",
    LOGNAME: "agent",
    PATH: "/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    TERM: "vt100",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    ANTHROPIC_API_KEY: "anthropic-key"
  });
});

test("Claude agent env maps memory overrides to its native disable switch", async () => {
  const enabled = await importConfig({ PROVIDER: "claude", CLAUDE_MEMORY_ENABLED: "true" });
  assert.equal(enabled.claudeAgentEnv().CLAUDE_CODE_DISABLE_AUTO_MEMORY, "0");

  const disabled = await importConfig({ PROVIDER: "claude", CLAUDE_MEMORY_ENABLED: "false" });
  assert.equal(disabled.claudeAgentEnv().CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");

  const nativeDefault = await importConfig({ PROVIDER: "claude" });
  assert.equal(nativeDefault.claudeAgentEnv().CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
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
