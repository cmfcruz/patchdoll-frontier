// Shared line buffering for the providers' newline-delimited JSON output.
//
// Both `codex exec --json` and `claude ... --output-format stream-json` emit one
// JSON object per line, but a single stdout chunk can split a line anywhere. This
// is the one fiddly bit worth having in exactly one place: buffer chunks, hand
// back complete lines, and `flush()` any trailing partial line at the end so the
// last event is never silently dropped.

export type LineParser = {
  /** Feed a stdout chunk; invokes the line handler for each complete line. */
  push(chunk: string): void;
  /** Emit any buffered (unterminated) final line. Call once after the stream ends. */
  flush(): void;
};

export function createLineParser(onLine: (line: string) => void): LineParser {
  let buffer = "";

  return {
    push(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      // The last element is an incomplete line (or "" if the chunk ended on a
      // newline); keep it buffered until more data or flush() arrives.
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    flush(): void {
      if (buffer.trim()) onLine(buffer);
      buffer = "";
    }
  };
}

/** Parse a single NDJSON line into a plain object, or undefined if it isn't one. */
export function parseJsonObject(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}
