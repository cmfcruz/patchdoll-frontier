import { test } from "node:test";
import assert from "node:assert/strict";

type ConfigModule = typeof import("./config.js");

const envKeys = [
  "PROVIDER",
  "PORT",
  "CODEX_TIMEOUT_MS",
  "CLAUDE_TIMEOUT_MS",
  "CODEX_REASONING_EFFORT",
  "CLAUDE_EFFORT",
  "CODEX_MODEL",
  "CLAUDE_MODEL"
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

test("config rejects malformed numeric env values instead of coercing them", async () => {
  await assert.rejects(() => importConfig({ PROVIDER: "codex", PORT: "3000abc" }), /PORT must be/);
  await assert.rejects(() => importConfig({ PROVIDER: "codex", PORT: "1.5" }), /PORT must be/);
  await assert.rejects(() => importConfig({ PROVIDER: "codex", CODEX_TIMEOUT_MS: "bad" }), /CODEX_TIMEOUT_MS must be/);
  await assert.rejects(() => importConfig({ PROVIDER: "codex", CLAUDE_TIMEOUT_MS: "0" }), /CLAUDE_TIMEOUT_MS must be/);
});
