import { test } from "node:test";
import assert from "node:assert/strict";

import { progressNoteFromEvent } from "./codex.js";
import { messageFromResult, toolNote } from "./claude.js";

test("progressNoteFromEvent maps Codex item.completed events to notes", () => {
  const note = (item: object) =>
    progressNoteFromEvent(JSON.stringify({ type: "item.completed", item }));

  assert.equal(note({ type: "command_execution", command: "ls -la" }), "$ ls -la");
  assert.equal(note({ type: "mcp_tool_call", tool: "ember_enable_github" }), "Calling ember_enable_github…");
  assert.equal(note({ type: "mcp_tool_call", name: "fallback_name" }), "Calling fallback_name…");
  assert.equal(note({ type: "file_change" }), "Editing files…");
  assert.equal(note({ type: "agent_message", text: "hello" }), "hello");
});

test("progressNoteFromEvent ignores non-events, wrong types and blank text", () => {
  assert.equal(progressNoteFromEvent("not json"), undefined);
  assert.equal(progressNoteFromEvent(JSON.stringify({ type: "item.started" })), undefined);
  assert.equal(
    progressNoteFromEvent(JSON.stringify({ type: "item.completed", item: { type: "reasoning" } })),
    undefined
  );
  assert.equal(
    progressNoteFromEvent(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "  " } })),
    undefined
  );
});

test("toolNote renders short, Codex-style notes for Claude tool_use blocks", () => {
  assert.equal(toolNote("Bash", { command: "npm test" }), "$ npm test");
  assert.equal(toolNote("Bash", {}), "Calling Bash…");
  assert.equal(toolNote("mcp__ember__enable_github", {}), "Calling mcp__ember__enable_github…");
  assert.equal(toolNote("Edit", {}), "Editing files…");
  assert.equal(toolNote("Write", {}), "Editing files…");
  assert.equal(toolNote("Grep", {}), "Calling Grep…");
});

test("messageFromResult extracts the result string, tolerating bad input", () => {
  assert.equal(messageFromResult(JSON.stringify({ type: "result", result: "the answer" })), "the answer");
  assert.equal(messageFromResult(JSON.stringify({ type: "result" })), "");
  assert.equal(messageFromResult("not json"), "");
  assert.equal(messageFromResult(""), "");
});
