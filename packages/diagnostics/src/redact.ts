/**
 * Keys whose values are never safe to write to a file the user will send on.
 *
 * The log exists to be handed to someone else, so a credential reaching it is
 * worse than the bug it was meant to explain. Matching is on the key, not the
 * value: a heuristic over values would both miss bespoke key formats and redact
 * innocent text that happens to look like one.
 */
const SECRET_KEY_PATTERN = /(api[-_]?key|secret|token|password|passwd|credential|authorization|cookie|bearer|refresh[-_]?token|access[-_]?token|private[-_]?key)/i;

/** Long enough that a truncated log line still says what happened. */
const MAX_STRING_LENGTH = 2_000;

const MAX_DEPTH = 6;

const MAX_ARRAY_LENGTH = 50;

export const REDACTED = "[已脱敏]";

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…（共 ${value.length} 字符）`
      : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  if (depth >= MAX_DEPTH) return "[层级过深]";
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[循环引用]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => redactValue(item, depth + 1, seen));
    return value.length > MAX_ARRAY_LENGTH
      ? [...items, `…（共 ${value.length} 项）`]
      : items;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    const redacted = redactValue(item, depth + 1, seen);
    if (redacted !== undefined) result[key] = redacted;
  }
  return result;
}

/**
 * Make a payload safe and bounded before it is written.
 *
 * Besides dropping secrets this caps strings, arrays, and nesting: a tool result
 * or a whole message list reaching the log unbounded would push the entries that
 * explain the bug out of the rotation.
 */
export function redact(data: unknown): Record<string, unknown> | undefined {
  if (data === null || data === undefined) return undefined;
  const value = redactValue(data, 0, new WeakSet());
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

/** Normalize anything thrown into the entry's `error` shape. */
export function errorInfo(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: typeof error === "string" ? error : JSON.stringify(error) ?? String(error) };
}
