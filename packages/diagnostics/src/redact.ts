/** Credentials and model/tool content never belong in diagnostic archives. */
const SECRET_KEY_PATTERN = /(api[-_]?key|secret|token|password|passwd|credential|authorization|cookie|bearer|refresh[-_]?token|access[-_]?token|private[-_]?key)/i;
const CONTENT_KEYS = new Set(["body", "request", "response", "requestbody", "responsebody", "payload", "requestpayload", "responsepayload",
  "messages", "message", "messagecontent", "content", "prompt", "systemprompt", "userprompt", "input", "output", "arguments", "args",
  "parameters", "params", "result", "results", "toolresult", "toolresults", "stdout", "stderr", "text", "html", "screenshot", "imagedata",
  "image", "dataurl", "command", "script", "expression"]);
const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 6;
const MAX_ITEMS = 50;
const MAX_ERROR_MESSAGE = 8_000;
const MAX_ERROR_STACK = 32_000;
const NUMERIC_TOKEN_METRICS = new Set([
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "tokens", "tokensBefore", "tokensAfter",
  "estimatedTokens", "estimatedTokensAfter", "projectedTokens", "contextWindowTokens", "contextTokens", "budgetTokens",
  "estimatedMetadataTokens", "estimatedTextTokens", "freedTokens", "inputTokensAbove", "keepRecentTokens", "keptTokens",
  "maxTokens", "max_tokens", "max_output_tokens", "messageTokens", "modelMaxTokens", "overheadTokens", "previousTokens",
  "promptTokens", "reserveTokens", "resultTokens", "runtimeToolDefinitionTokens", "summarizationTokens", "systemPromptTokens",
  "targetTokens", "textResultEstimatedTokens", "toolDefinitionTokens", "averageTokensPerSecond", "firstTokenMs", "firstTokenAt",
]);
export const REDACTED = "[已脱敏]";
export const CONTENT_OMITTED = "[内容未记录]";
const SHAPE_TYPES = new Set(["null", "undefined", "string", "number", "boolean", "bigint", "symbol", "function", "object", "array", "circular", "omitted"]);

/** Shapes contain names and measurements, never argument values. */
function redactShape(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) return CONTENT_OMITTED;
  const shape = value as Record<string, unknown>;
  if (typeof shape.type !== "string" || !SHAPE_TYPES.has(shape.type)) return CONTENT_OMITTED;
  const safe: Record<string, unknown> = { type: shape.type };
  for (const key of ["bytes", "length", "keys"]) if (typeof shape[key] === "number") safe[key] = shape[key];
  if (Array.isArray(shape.keys)) safe.keys = shape.keys.slice(0, MAX_ITEMS).filter((key) => typeof key === "string").map((key) => redactText(key, 200));
  if (shape.fields && typeof shape.fields === "object" && !Array.isArray(shape.fields)) {
    safe.fields = Object.fromEntries(Object.entries(shape.fields).slice(0, MAX_ITEMS).map(([key, item]) => [redactText(key, 200), redactShape(item, depth + 1)]));
  }
  if (Array.isArray(shape.items)) safe.items = shape.items.slice(0, MAX_ITEMS).map((item) => redactShape(item, depth + 1));
  return safe;
}

/** Error strings and URLs can include credentials outside structured keys. */
export function redactText(value: string, maximum = MAX_STRING_LENGTH): string {
  const safe = value
    .replace(/\b((?:request|response|tool)[-_ ]?(?:body|payload|result|arguments)\s*[:=])\s*[\s\S]*?(?=\n\s+at\s|$)/gi, `$1 ${CONTENT_OMITTED}`)
    .replace(/(["'](?:messages|prompt|system[-_]?prompt|content|arguments|request[-_]?body|response[-_]?body|tool[-_]?arguments)["']\s*:)\s*[\s\S]*?(?=\n\s+at\s|$)/gi, `$1 ${CONTENT_OMITTED}`)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(Bearer|Basic)\s+[^\s,;'"<>]+/gi, `$1 ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|client[-_]?secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,;"'&}]+/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  return safe.length > maximum ? `${safe.slice(0, maximum)}…（共 ${safe.length} 字符）` : safe;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Error) return errorInfo(value);
  if (depth >= MAX_DEPTH) return "[层级过深]";
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[循环引用]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => redactValue(item, depth + 1, seen));
    return value.length > MAX_ITEMS ? [...items, `…（共 ${value.length} 项）`] : items;
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, MAX_ITEMS)) {
    // Token counts and byte/count metadata remain numeric, including input/output.
    if (["shape", "parameterShape", "paramShape"].includes(key)) {
      result[key] = redactShape(item);
    } else if (["tokenBreakdown", "tokenUsage"].includes(key) && item && typeof item === "object") {
      result[key] = redactValue(item, depth + 1, seen);
    } else if (key === "tokenEstimateMethod" && item === "text_chars_div_4") {
      result[key] = item;
    } else if (SECRET_KEY_PATTERN.test(key)
      && !(typeof item === "number" && NUMERIC_TOKEN_METRICS.has(key))) {
      result[key] = REDACTED;
    } else if (CONTENT_KEYS.has(key.replace(/[-_]/g, "").toLowerCase()) && typeof item !== "number" && typeof item !== "boolean") {
      result[key] = CONTENT_OMITTED;
    } else {
      const redacted = redactValue(item, depth + 1, seen);
      if (redacted !== undefined) result[key] = redacted;
    }
  }
  if (entries.length > MAX_ITEMS) result.omittedFields = entries.length - MAX_ITEMS;
  return result;
}

export function redact(data: unknown): Record<string, unknown> | undefined {
  if (data === null || data === undefined) return undefined;
  const value = redactValue(data, 0, new WeakSet());
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

/** Preserve actionable validation text and stack frames, with bounded free text. */
export function errorInfo(error: unknown, depth = 0): { message: string; stack?: string } {
  if (error instanceof Error || (error && typeof error === "object" && "message" in error)) {
    const record = error as { message: unknown; stack?: unknown; cause?: unknown; errors?: unknown[] };
    let stack = typeof record.stack === "string" ? record.stack : "";
    if (depth < 3) {
      const causes = [...(record.cause === undefined ? [] : [record.cause]), ...(Array.isArray(record.errors) ? record.errors.slice(0, 5) : [])];
      for (const cause of causes) {
        if (cause === error) continue;
        const info = errorInfo(cause, depth + 1);
        stack += `\nCaused by: ${info.stack ?? info.message}`;
      }
    }
    return { message: redactText(String(record.message), MAX_ERROR_MESSAGE),
      ...(stack ? { stack: redactText(stack, MAX_ERROR_STACK) } : {}) };
  }
  if (typeof error === "string") return { message: redactText(error, MAX_ERROR_MESSAGE) };
  try { return { message: redactText(JSON.stringify(redact(error)) ?? String(error), MAX_ERROR_MESSAGE) }; }
  catch { return { message: "无法序列化的错误" }; }
}
