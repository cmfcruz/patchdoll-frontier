// Slack bridge.
//
// Listens for @mentions and direct messages, runs the agent to answer them, and
// streams the result back into Slack. The delivery model is borrowed from
// Patchdoll's adapter: post a placeholder, edit it with throttled progress notes
// while the agent works, then replace it with the final answer (splitting long
// replies across follow-up messages).

import { App, LogLevel as BoltLogLevel, type SayFn } from "@slack/bolt";

import { agent, type AgentRunResult } from "./agent.js";
import {
  maxSlackTextLength,
  messageOf,
  slackAppToken,
  slackBotToken,
  slackEnabled,
  workspace
} from "./config.js";
import { log, logLevel } from "./log.js";
import { buildAgentPrompt } from "./prompt.js";

type SlackClient = App["client"];

type SlackEvent = {
  bot_id?: string;
  channel: string;
  channel_type?: string;
  subtype?: string;
  team?: string;
  text?: string;
  thread_ts?: string;
  ts: string;
  user?: string;
};

type SlackThreadMessage = {
  botId?: string;
  text: string;
  ts?: string;
  user?: string;
};

type SlackThreadContext = {
  available: boolean;
  channelId?: string;
  error?: string;
  messageCount?: number;
  messages?: SlackThreadMessage[];
  reason?: string;
  threadTs?: string;
};

const initialProgressText = "hmm?";
const requestFailurePrefix = "That's annoying, but manageable";
const fallbackReply = "Ember handled the request.";

// Control characters Slack rejects. The "keep newlines" variant preserves tab
// and newline so final replies keep their formatting; the strict variant strips
// all control characters for single-line progress and thread text.
const controlCharsKeepNewlines = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const allControlChars = /[\u0000-\u001f\u007f]/g;

/**
 * Start the Slack adapter. Returns the running App, or `undefined` when Slack is
 * not configured or fails to start. A Slack failure never throws — the rest of
 * the bridge keeps serving HTTP.
 */
export async function startSlackApp(): Promise<App | undefined> {
  if (!slackEnabled()) {
    log.info("slack adapter disabled; set EMBER_SLACK_BOT_TOKEN and EMBER_SLACK_APP_TOKEN to enable it");
    return undefined;
  }

  const app = new App({
    token: slackBotToken,
    appToken: slackAppToken,
    socketMode: true,
    logLevel: boltLogLevel()
  });

  app.event("app_mention", async ({ event, say, client }) => {
    const slackEvent = event as SlackEvent;
    log.debug("slack app_mention received", {
      user: slackEvent.user,
      channel: slackEvent.channel,
      ts: slackEvent.ts,
      thread_ts: slackEvent.thread_ts,
      text: slackEvent.text
    });
    await handleSlackRequest({
      type: "slack.app_mention",
      event: slackEvent,
      text: stripLeadingMention(slackEvent.text),
      say,
      client
    });
  });

  app.message(async ({ message, say, client }) => {
    const event = message as Partial<SlackEvent>;
    log.debug("slack message received", {
      channel: event.channel,
      channel_type: event.channel_type,
      subtype: event.subtype,
      bot_id: event.bot_id,
      user: event.user,
      ts: event.ts,
      text: event.text
    });

    if (!isDirectUserMessage(event)) {
      log.debug("slack message ignored (not a direct user message)");
      return;
    }

    await handleSlackRequest({
      type: "slack.direct_message",
      event: event as SlackEvent,
      text: event.text ?? "",
      say,
      client
    });
  });

  try {
    await app.start();
    log.info("slack adapter started");
    return app;
  } catch (error) {
    log.error(`slack adapter failed to start: ${messageOf(error)}`);
    return undefined;
  }
}

async function handleSlackRequest(input: {
  type: string;
  event: SlackEvent;
  text: string;
  say: SayFn;
  client: SlackClient;
}): Promise<void> {
  const { event, client } = input;
  const threadTs = event.thread_ts || event.ts;

  // Post the placeholder we will keep editing. If even this fails there is
  // nothing we can reply into, so log and bail rather than crash the handler.
  let placeholderTs: string | undefined;
  try {
    const placeholder = await input.say({ text: initialProgressText, thread_ts: threadTs });
    placeholderTs = placeholder.ts;
  } catch (error) {
    log.error(`could not post Slack placeholder: ${messageOf(error)}`);
    return;
  }

  const reply = createReplyChannel(client, { channel: event.channel, threadTs, placeholderTs });

  try {
    const threadContext = await fetchThreadContext(client, { channelId: event.channel, threadTs });
    const prompt = buildAgentPrompt({
      type: input.type,
      actor: event.user,
      permalink: slackPermalink(event),
      threadContext,
      text: input.text
    });
    log.info(`running ${agent.name} for ${input.type} (actor=${event.user ?? "unknown"}, channel=${event.channel})`);
    const result = await agent.run({ prompt, cwd: workspace, onProgress: reply.progress });
    log.info(`${agent.name} finished for ${input.type} (code=${result.code}, message chars=${result.message.length})`);
    await reply.final(agentReplyText(result));
  } catch (error) {
    log.error(`request failed: ${messageOf(error)}`);
    await reply.final(`${requestFailurePrefix}: ${messageOf(error)}`);
  }
}

function boltLogLevel(): BoltLogLevel {
  switch (logLevel) {
    case "debug":
      return BoltLogLevel.DEBUG;
    case "warn":
      return BoltLogLevel.WARN;
    case "error":
      return BoltLogLevel.ERROR;
    default:
      return BoltLogLevel.INFO;
  }
}

function slackPermalink(event: SlackEvent): string | undefined {
  return event.team && event.channel && event.ts
    ? `https://slack.com/archives/${event.channel}/p${String(event.ts).replace(".", "")}`
    : undefined;
}

export function agentReplyText(result: AgentRunResult): string {
  if (result.message.trim()) {
    return result.message;
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `${agent.name} exited with code ${result.code}`;
    return `${agent.displayName} finished without a reply.\n\n${detail}`;
  }
  return fallbackReply;
}

// ---------------------------------------------------------------------------
// Reply channel: throttled progress edits + chunked final answer
// ---------------------------------------------------------------------------

export function createReplyChannel(
  client: SlackClient,
  target: { channel: string; threadTs: string; placeholderTs?: string }
) {
  const minIntervalMs = 2500;
  let lastText: string | undefined;
  let lastSentAt = 0;
  let pending: string | undefined;
  let flushTimer: NodeJS.Timeout | undefined;

  // Edit the placeholder when we have one, otherwise post a new threaded message
  // so a reply still lands.
  async function update(text: string): Promise<void> {
    if (target.placeholderTs) {
      await client.chat.update({ channel: target.channel, ts: target.placeholderTs, text });
    } else {
      await client.chat.postMessage({ channel: target.channel, thread_ts: target.threadTs, text });
    }
  }

  async function post(text: string): Promise<void> {
    await client.chat.postMessage({ channel: target.channel, thread_ts: target.threadTs, text });
  }

  // Throttled, best-effort progress edit. `lastText`/`lastSentAt` are only
  // advanced after a *successful* edit, so a failed progress update can never
  // suppress the final answer.
  async function sendProgress(text: string): Promise<void> {
    if (!text || text === lastText) return;

    const now = Date.now();
    if (now - lastSentAt < minIntervalMs) {
      pending = text;
      scheduleFlush(minIntervalMs - (now - lastSentAt));
      return;
    }

    clearFlush();
    pending = undefined;
    await update(text);
    lastText = text;
    lastSentAt = now;
  }

  function scheduleFlush(delayMs: number): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      if (pending) {
        void sendProgress(pending).catch((error) => log.warn(`progress update failed: ${messageOf(error)}`));
      }
    }, Math.max(0, delayMs));
  }

  function clearFlush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }

  return {
    progress(note: string): void {
      void sendProgress(sanitizeProgressText(note)).catch((error) =>
        log.warn(`progress update failed: ${messageOf(error)}`)
      );
    },
    // Always deliver the final answer, regardless of progress state. If editing
    // the placeholder fails, fall back to a fresh threaded message.
    async final(text: string): Promise<void> {
      clearFlush();
      const chunks = splitSlackText(sanitizeReplyText(text) || fallbackReply);
      const first = chunks.shift();
      if (!first) return;

      try {
        await update(first);
      } catch (error) {
        log.warn(`final update failed, posting a new message instead: ${messageOf(error)}`);
        await post(first);
      }

      for (const chunk of chunks) {
        await post(chunk);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Thread context
// ---------------------------------------------------------------------------

async function fetchThreadContext(
  client: SlackClient,
  input: { channelId?: string; threadTs?: string }
): Promise<SlackThreadContext> {
  const { channelId, threadTs } = input;
  if (!channelId || !threadTs) {
    return { available: false, reason: "missing_channel_or_thread" };
  }

  try {
    const response = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    const messages = (response.messages ?? []).map((message) => ({
      ts: message.ts,
      user: message.user,
      botId: message.bot_id,
      text: sanitizeThreadText(message.text ?? "")
    }));

    log.debug("fetched Slack thread context", { channelId, threadTs, messageCount: messages.length });
    return { available: true, channelId, threadTs, messageCount: messages.length, messages };
  } catch (error) {
    const code = slackErrorCode(error);
    log.warn(`could not fetch Slack thread context (${code ?? messageOf(error)})`);
    return {
      available: false,
      channelId,
      threadTs,
      reason: classifySlackError(code),
      error: code ?? messageOf(error)
    };
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isDirectUserMessage(event: Partial<SlackEvent>): boolean {
  return Boolean(
    event &&
      event.channel_type === "im" &&
      !event.bot_id &&
      !event.subtype &&
      typeof event.text === "string"
  );
}

export function stripLeadingMention(text: string | undefined): string {
  return String(text ?? "").replace(/^<@[A-Z0-9]+>\s*/i, "").trim();
}

function slackErrorCode(error: unknown): string | undefined {
  const data = (error as { data?: { error?: unknown } })?.data;
  if (typeof data?.error === "string" && data.error.trim()) return data.error.trim();
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

export function classifySlackError(code: string | undefined): string {
  switch (code) {
    case "missing_scope":
      return "slack_missing_scope";
    case "not_in_channel":
    case "channel_not_found":
    case "no_permission":
      return "slack_channel_not_accessible";
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
      return "slack_auth_error";
    default:
      return code ? `slack_api_error:${code}` : "fetch_failed";
  }
}

function sanitizeReplyText(text: string): string {
  return String(text ?? "")
    .replace(controlCharsKeepNewlines, " ")
    .trim();
}

function sanitizeProgressText(text: string): string {
  return String(text ?? "")
    .replace(allControlChars, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function sanitizeThreadText(text: string): string {
  return String(text ?? "")
    .replace(controlCharsKeepNewlines, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

/** Split text into Slack-sized chunks, preferring paragraph/line/word breaks. */
export function splitSlackText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxSlackTextLength) {
    const splitAt = preferredSplitIndex(remaining, maxSlackTextLength);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function preferredSplitIndex(text: string, limit: number): number {
  const candidates = [
    text.lastIndexOf("\n\n", limit),
    text.lastIndexOf("\n", limit),
    text.lastIndexOf(" ", limit)
  ].filter((index) => index > Math.floor(limit * 0.6));

  return candidates.length ? Math.max(...candidates) : limit;
}
