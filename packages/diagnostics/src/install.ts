import type { DiagnosticLog } from "./log-file.js";

export interface ProcessErrorHandlerOptions {
  /**
   * Whether an uncaught exception still ends the process.
   *
   * Keep the platform's own answer. The runtime child already dies on one and
   * the parent reports it, so exiting preserves that and only adds the reason;
   * the main process taking the whole app down instead of carrying on with one
   * broken operation is a trade nobody asked for.
   */
  exitOnUncaught: boolean;
  /** Called before the process ends, to let owners flush or notify. */
  onFatal?: (error: unknown) => void;
}

/**
 * Record the failures that used to leave nothing behind.
 *
 * An uncaught exception or a rejected promise nobody handled is exactly the
 * class of bug that shows up only after fifty turns, and until now both ended
 * the process — or silently didn't — without writing a word anywhere the user
 * could reach.
 *
 * Returns a function that removes the handlers again.
 */
export function installProcessErrorHandlers(
  log: DiagnosticLog,
  options: ProcessErrorHandlerOptions,
): () => void {
  const onUncaught = (error: unknown): void => {
    log.error("process", "uncaught_exception", error, { pid: process.pid });
    options.onFatal?.(error);
    if (options.exitOnUncaught) process.exit(1);
  };
  const onRejection = (reason: unknown): void => {
    log.error("process", "unhandled_rejection", reason, { pid: process.pid });
  };
  const onWarning = (warning: Error): void => {
    // Node reports a leaking listener here long before it becomes a symptom the
    // user can describe, and it is the shape a stuck session tends to take.
    if (warning.name !== "MaxListenersExceededWarning") return;
    log.warn("process", "listener_leak_warning", { message: warning.message });
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  process.on("warning", onWarning);
  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
    process.off("warning", onWarning);
  };
}

/** What was running when something went wrong, for the first entry of a log. */
export function processStartupData(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    pid: process.pid,
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    ...extra,
  };
}
