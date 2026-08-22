import type { DiagnosticLevel, DiagnosticLogEntry } from "@coilcoil/runtime-protocol";

/**
 * How long Renderer entries accumulate before they are handed to the main process.
 *
 * Logging must never become the thing that makes the window stutter, so entries
 * ride over in batches on a timer rather than one IPC message each. Errors skip
 * the wait: the entry that explains a crash is worth an immediate send, because
 * a crash is exactly what stops the timer from ever firing.
 */
const FLUSH_INTERVAL_MS = 1_000;

/** Beyond this the buffer is flushed immediately rather than growing. */
const MAX_BUFFERED = 100;

let buffer: DiagnosticLogEntry[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (buffer.length === 0) return;
  const entries = buffer;
  buffer = [];
  try {
    window.coilcoil.writeDiagnostics({ entries });
  } catch {
    // The bridge is gone — during teardown, or in a test harness. Dropping the
    // entries is the only option that cannot itself throw.
  }
}

function push(entry: DiagnosticLogEntry): void {
  buffer.push(entry);
  if (entry.level === "error" || buffer.length >= MAX_BUFFERED) {
    flush();
    return;
  }
  timer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
}

function record(
  level: DiagnosticLevel,
  scope: string,
  event: string,
  data?: Record<string, unknown>,
  error?: unknown,
): void {
  push({
    ts: Date.now(),
    level,
    process: "renderer",
    scope,
    event,
    ...(data ? { data } : {}),
    ...(error === undefined ? {} : {
      error: error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error) },
    }),
  });
}

export const diagnostics = {
  debug: (scope: string, event: string, data?: Record<string, unknown>) => record("debug", scope, event, data),
  info: (scope: string, event: string, data?: Record<string, unknown>) => record("info", scope, event, data),
  warn: (scope: string, event: string, data?: Record<string, unknown>) => record("warn", scope, event, data),
  error: (scope: string, event: string, error: unknown, data?: Record<string, unknown>) =>
    record("error", scope, event, data, error),
  flush,
};

/**
 * Catch the Renderer failures that used to leave a white window and nothing else.
 *
 * A render that throws unmounts the tree, so by the time the user notices, the
 * DevTools console they never opened is the only record — and in a packaged app
 * there isn't one. These three handlers cover everything outside React's own
 * boundary, which `AppErrorBoundary` covers.
 */
export function installRendererErrorHandlers(): void {
  window.addEventListener("error", (event) => {
    diagnostics.error("window", "uncaught_error", event.error ?? event.message, {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    diagnostics.error("window", "unhandled_rejection", event.reason);
  });
  // The last chance to get a full buffer out before the window goes away.
  window.addEventListener("pagehide", flush);
}
