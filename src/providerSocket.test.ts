import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWorkerMessage, parseWorkerRequest } from "./providerSocket.js";

test("worker protocol parses run and GitHub configuration requests", () => {
  assert.deepEqual(
    parseWorkerRequest(JSON.stringify({ type: "run", request: { prompt: "fix it", cwd: "/workspace" } })),
    { type: "run", request: { prompt: "fix it", cwd: "/workspace", model: undefined } }
  );
  assert.deepEqual(
    parseWorkerRequest(
      JSON.stringify({
        type: "configure-github",
        helperPath: "/run/patchdoll/bridge/helper",
        identity: { name: "bot", email: "bot@example.com" }
      })
    ),
    {
      type: "configure-github",
      helperPath: "/run/patchdoll/bridge/helper",
      identity: { name: "bot", email: "bot@example.com" }
    }
  );
});

test("worker protocol parses progress, completion, and errors", () => {
  assert.deepEqual(parseWorkerMessage('{"type":"progress","note":"Working"}'), {
    type: "progress",
    note: "Working"
  });
  assert.deepEqual(parseWorkerMessage('{"type":"configured"}'), { type: "configured" });
  assert.deepEqual(parseWorkerMessage('{"type":"error","error":"nope"}'), {
    type: "error",
    error: "nope"
  });
});

test("worker protocol rejects malformed messages", () => {
  assert.throws(() => parseWorkerRequest('{"type":"run","request":{"cwd":"/workspace"}}'));
  assert.throws(() => parseWorkerRequest('{"type":"configure-github","identity":{}}'));
  assert.throws(() => parseWorkerMessage('{"type":"progress","note":3}'));
  assert.throws(() => parseWorkerMessage('[]'));
});
