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
    try { options.onFatal?.(error); }
    catch (callbackError) { log.error("process", "fatal_callback_failed", callbackError); }
    if (options.exitOnUncaught) void log.flush().finally(() => process.exit(1));
  };
  const onRejection = (reason: unknown): void => {
    log.error("process", "unhandled_rejection", reason, { pid: process.pid });
  };
  const onWarning = (warning: Error): void => {
    // Node reports a leaking listener here long before it becomes a symptom the
    // user can describe, and it is the shape a stuck session tends to take.
    log.log("warn", "process", warning.name === "MaxListenersExceededWarning" ? "listener_leak_warning" : "process_warning",
      { name: warning.name }, { error: warning });
  };
  const onBeforeExit = (): void => { void log.flush(); };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  process.on("warning", onWarning);
  process.on("beforeExit", onBeforeExit);
  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
    process.off("warning", onWarning);
    process.off("beforeExit", onBeforeExit);
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
