import { test } from "node:test";
import assert from "node:assert/strict";

import { maxSlackTextLength } from "./config.js";
import {
  classifySlackError,
  preferredSplitIndex,
  splitSlackText,
  stripLeadingMention
} from "./slack.js";

test("splitSlackText leaves short text as a single chunk", () => {
  assert.deepEqual(splitSlackText("hello world"), ["hello world"]);
});

test("splitSlackText splits long text into chunks within the Slack limit", () => {
  const long = "word ".repeat(2000).trim(); // ~10k chars, no newlines
  const chunks = splitSlackText(long);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= maxSlackTextLength, `chunk length ${chunk.length} exceeds limit`);
  }
  // Reassembling on spaces recovers the original words.
  assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), long);
});

test("splitSlackText prefers a paragraph break near the limit", () => {
  const head = "a".repeat(maxSlackTextLength - 100);
  const tail = "b".repeat(200);
  const chunks = splitSlackText(`${head}\n\n${tail}`);

  assert.equal(chunks[0], head, "first chunk ends at the blank line, not mid-run");
  assert.equal(chunks[1], tail);
});

test("preferredSplitIndex falls back to the hard limit when no break is close enough", () => {
  const text = "x".repeat(100); // no whitespace at all
  assert.equal(preferredSplitIndex(text, 50), 50);
});

test("classifySlackError maps known Slack error codes to stable reasons", () => {
  assert.equal(classifySlackError("missing_scope"), "slack_missing_scope");
  assert.equal(classifySlackError("not_in_channel"), "slack_channel_not_accessible");
  assert.equal(classifySlackError("channel_not_found"), "slack_channel_not_accessible");
  assert.equal(classifySlackError("token_revoked"), "slack_auth_error");
  assert.equal(classifySlackError("ratelimited"), "slack_api_error:ratelimited");
  assert.equal(classifySlackError(undefined), "fetch_failed");
});

test("stripLeadingMention removes a single leading bot mention", () => {
  assert.equal(stripLeadingMention("<@U0B76SPCMA4> hello there"), "hello there");
  assert.equal(stripLeadingMention("no mention here"), "no mention here");
});
