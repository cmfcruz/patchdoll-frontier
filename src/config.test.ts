import { test } from "node:test";
import assert from "node:assert/strict";

type ConfigModule = typeof import("./config.js");

const envKeys = [
  "PROVIDER",
  "EMBER_PROVIDER",
  "PORT",
  "CODEX_TIMEOUT_MS",
  "CLAUDE_TIMEOUT_MS",
  "CODEX_REASONING_EFFORT",
  "CLAUDE_EFFORT",
  "CODEX_MODEL",
  "CLAUDE_MODEL",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "EMBER_SLACK_BOT_TOKEN",
  "EMBER_SLACK_APP_TOKEN"
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

test("config accepts legacy Ember env names for migrated deployments", async () => {
  const config = await importConfig({
    EMBER_PROVIDER: "claude",
    EMBER_SLACK_BOT_TOKEN: "xoxb-legacy",
    EMBER_SLACK_APP_TOKEN: "xapp-legacy"
  });

  assert.equal(config.provider, "claude");
  assert.equal(config.slackBotToken, "xoxb-legacy");
  assert.equal(config.slackAppToken, "xapp-legacy");
  assert.equal(config.slackEnabled(), true);
});

test("config prefers unprefixed env names over legacy Ember names", async () => {
  const config = await importConfig({
    PROVIDER: "codex",
    EMBER_PROVIDER: "claude",
    SLACK_BOT_TOKEN: "xoxb-new",
    SLACK_APP_TOKEN: "xapp-new",
    EMBER_SLACK_BOT_TOKEN: "xoxb-legacy",
    EMBER_SLACK_APP_TOKEN: "xapp-legacy"
  });

  assert.equal(config.provider, "codex");
  assert.equal(config.slackBotToken, "xoxb-new");
  assert.equal(config.slackAppToken, "xapp-new");
});

test("config rejects malformed numeric env values instead of coercing them", async () => {
  await assert.rejects(() => importConfig({ PROVIDER: "codex", PORT: "3000abc" }), /PORT must be/);
  await assert.rejects(() => importConfig({ PROVIDER: "codex", PORT: "1.5" }), /PORT must be/);
  await assert.rejects(() => importConfig({ PROVIDER: "codex", CODEX_TIMEOUT_MS: "bad" }), /CODEX_TIMEOUT_MS must be/);
  await assert.rejects(() => importConfig({ PROVIDER: "codex", CLAUDE_TIMEOUT_MS: "0" }), /CLAUDE_TIMEOUT_MS must be/);
});
