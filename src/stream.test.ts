import { test } from "node:test";
import assert from "node:assert/strict";

import { createLineParser, parseJsonObject } from "./stream.js";

test("createLineParser emits complete lines and buffers partials across chunks", () => {
  const lines: string[] = [];
  const parser = createLineParser((line) => lines.push(line));

  parser.push("hel");
  parser.push("lo\nwor");
  assert.deepEqual(lines, ["hello"]);

  parser.push("ld\nnext\n");
  assert.deepEqual(lines, ["hello", "world", "next"]);
});

test("createLineParser splits on CRLF as well as LF", () => {
  const lines: string[] = [];
  const parser = createLineParser((line) => lines.push(line));

  parser.push("a\r\nb\r\n");
  assert.deepEqual(lines, ["a", "b"]);
});

test("flush emits a trailing unterminated line", () => {
  const lines: string[] = [];
  const parser = createLineParser((line) => lines.push(line));

  parser.push("a\nb");
  assert.deepEqual(lines, ["a"], "b is still buffered until flush");

  parser.flush();
  assert.deepEqual(lines, ["a", "b"]);
});

test("parseJsonObject accepts objects and rejects arrays, scalars and garbage", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('  {"a":1}  '), { a: 1 });
  assert.equal(parseJsonObject("[1,2,3]"), undefined);
  assert.equal(parseJsonObject('"a string"'), undefined);
  assert.equal(parseJsonObject("42"), undefined);
  assert.equal(parseJsonObject("not json"), undefined);
  assert.equal(parseJsonObject(""), undefined);
});
