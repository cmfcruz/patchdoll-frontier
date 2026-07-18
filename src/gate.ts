// The coarse "may this person drive Eucleia at all" gate, evaluated before any
// agent work begins.
//
// Fails closed, with no escape hatch. With no trusted users and no admins,
// nobody is admitted — a forgotten allowlist denies rather than silently
// reverting to open access. Admins are implicitly trusted so a fresh install
// can still be bootstrapped by whoever is in EUCLEIA_ADMINS. config.ts refuses
// to start the Slack adapter when both lists are empty, so a misconfiguration
// surfaces at startup, not as a silently unreachable bot.

export interface InvocationPolicy {
  admins: string[];
  trustedUsers: string[];
}

/**
 * True when `actor` is allowed to invoke Eucleia. Decide on the current
 * message's actor only — never thread participants or quoted transcript
 * content, which are untrusted data, not authority.
 */
export function actorMayInvoke(actor: string | undefined, policy: InvocationPolicy): boolean {
  if (actor === undefined) {
    return false;
  }
  return policy.admins.includes(actor) || policy.trustedUsers.includes(actor);
}

/** The chat reply posted when an untrusted actor is turned away. */
export function invocationDeniedReply(): string {
  return (
    "You're not on Eucleia's trusted-users list, so this request will not run. " +
    "Ask an admin to add your Slack user ID to `EUCLEIA_TRUSTED_USERS`."
  );
}

/**
 * Parse a comma-separated user-ID list env var into a clean array. Blank
 * entries and surrounding whitespace are dropped; an unset/empty variable is an
 * empty list (which denies — see above).
 */
export function parseUserList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
