import assert from "node:assert/strict";
import { test } from "node:test";

import { actorMayInvoke, invocationDeniedReply, parseUserList } from "./gate.js";

const CLOSED = { admins: [], trustedUsers: [] };

test("denies everyone when no lists are set (fail closed, no escape hatch)", () => {
  assert.equal(actorMayInvoke("U_RANDOM", CLOSED), false);
  assert.equal(actorMayInvoke(undefined, CLOSED), false);
});

test("admits trusted users by exact actor id", () => {
  const policy = { ...CLOSED, trustedUsers: ["U_TRUSTED"] };
  assert.equal(actorMayInvoke("U_TRUSTED", policy), true);
  assert.equal(actorMayInvoke("U_OTHER", policy), false);
});

test("admins are implicitly trusted (bootstrap)", () => {
  const policy = { ...CLOSED, admins: ["U_ADMIN"] };
  assert.equal(actorMayInvoke("U_ADMIN", policy), true);
});

test("denial reply names the env var to ask an admin about", () => {
  assert.match(invocationDeniedReply(), /EUCLEIA_TRUSTED_USERS/);
});

test("parseUserList splits on commas and drops blanks and whitespace", () => {
  assert.deepEqual(parseUserList("U_A, U_B ,,U_C"), ["U_A", "U_B", "U_C"]);
  assert.deepEqual(parseUserList("  "), []);
  assert.deepEqual(parseUserList(undefined), []);
});
