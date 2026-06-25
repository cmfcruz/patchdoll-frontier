// Tiny leveled logger shared across the bridge.
//
// The level is controlled by LOG_LEVEL (error | warn | info | debug),
// defaulting to info. Set LOG_LEVEL=debug to also log incoming Slack
// messages and agent invocations. Each call prints a single line so the output
// stays readable in container/balena logs.

export type LogLevel = "error" | "warn" | "info" | "debug";

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (raw in RANK ? raw : "info") as LogLevel;
}

export const logLevel: LogLevel = resolveLevel();
const threshold = RANK[logLevel];

export function isDebug(): boolean {
  return threshold >= RANK.debug;
}

function format(detail: unknown): string {
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function emit(level: LogLevel, message: string, detail?: unknown): void {
  if (RANK[level] > threshold) return;

  const line = detail === undefined ? `ember [${level}] ${message}` : `ember [${level}] ${message} ${format(detail)}`;
  const stream = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  stream(line);
}

export const log = {
  error: (message: string, detail?: unknown): void => emit("error", message, detail),
  warn: (message: string, detail?: unknown): void => emit("warn", message, detail),
  info: (message: string, detail?: unknown): void => emit("info", message, detail),
  debug: (message: string, detail?: unknown): void => emit("debug", message, detail)
};
