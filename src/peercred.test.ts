import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePeerCredentials } from "./peercred.js";

test("peer credentials require integer pid, uid, and gid", () => {
  assert.deepEqual(parsePeerCredentials('{"pid":12,"uid":999,"gid":998}'), {
    pid: 12,
    uid: 999,
    gid: 998
  });
  assert.throws(() => parsePeerCredentials('{"pid":12,"uid":"999","gid":998}'));
  assert.throws(() => parsePeerCredentials('{}'));
  assert.throws(() => parsePeerCredentials('null'));
});
