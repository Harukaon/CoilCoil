import { ABORT_STALL_NOTICE_MS } from "./runtime-constants.js";
import { cancelBackgroundWait } from "./runtime-background-wait.js";
import type { ActiveSession } from "./runtime-state.js";

interface AbortPublication {
  publish: () => void;
  isCurrent: () => boolean;
  reportError: (error: unknown) => void;
}

interface AbortSessionOptions extends AbortPublication {
  promptStarting: () => boolean;
  stopGoal: () => Promise<boolean>;
  dropPrompts: () => number;
  cancelSummary: () => boolean;
  reportSlow: () => void;
  log: (event: string, data: Record<string, unknown>) => void;
}

function trackAbort(active: ActiveSession, operations: Promise<void>[], options: AbortPublication,
  settled?: () => void): Promise<void> {
  active.aborting = true;
  options.publish();
  const pending = Promise.allSettled(operations).then((results) => {
    for (const result of results) if (result.status === "rejected") options.reportError(result.reason);
  }).finally(() => {
    settled?.();
    if (active.abortInFlight !== pending) return;
    active.abortInFlight = undefined;
    active.aborting = active.abortOnStart === true;
    if (options.isCurrent()) options.publish();
  });
  active.abortInFlight = pending;
  return pending;
}

export function cancelGoalBackgroundWait(active: ActiveSession, options: AbortPublication): void {
  const cancelled = cancelBackgroundWait(active, options.reportError);
  if (!cancelled.cancelled || !cancelled.completion) return;
  const operations = active.abortInFlight ? [active.abortInFlight, cancelled.completion] : [cancelled.completion];
  void trackAbort(active, operations, options);
}

export async function abortSession(active: ActiveSession, options: AbortSessionOptions): Promise<{
  aborted: boolean; aborting: boolean; cancelledQueue: number;
}> {
  const requestedAt = Date.now();
  options.log("abort_requested", { streaming: active.session.isStreaming, aborting: active.aborting === true,
    queued: active.promptQueue.length, runningTools: [...active.tools.values()].filter((tool) => tool.status === "running").map((tool) => tool.name) });
  const background = cancelBackgroundWait(active, options.reportError);
  const stoppedGoal = await options.stopGoal();
  const cancelledQueue = options.dropPrompts();
  const cancelledSummary = options.cancelSummary();
  const existing = active.abortInFlight;
  const cleanup = background.cancelled ? background.completion : undefined;
  const runNeedsAbort = active.session.isStreaming && !active.agentAbortInFlight;
  if (existing && !cleanup && !runNeedsAbort) return { aborted: true, aborting: true, cancelledQueue };
  const pendingStart = options.promptStarting();
  if (pendingStart && !active.session.isStreaming) active.abortOnStart = true;
  if (!active.session.isStreaming && !cleanup && !existing) {
    active.aborting = pendingStart;
    options.log("abort_without_live_run", { cancelledQueue, stoppedGoal, cancelledSummary, pending: pendingStart,
      cancelledBackgroundWait: background.cancelled === true });
    options.publish();
    return { aborted: stoppedGoal || cancelledQueue > 0 || cancelledSummary || pendingStart || background.cancelled === true,
      aborting: pendingStart, cancelledQueue };
  }
  const operations: Promise<void>[] = existing ? [existing] : [];
  if (runNeedsAbort) {
    const runAbort = active.session.abort();
    active.agentAbortInFlight = runAbort;
    const clear = (): void => { if (active.agentAbortInFlight === runAbort) active.agentAbortInFlight = undefined; };
    void runAbort.then(clear, clear);
    operations.push(runAbort);
  }
  if (cleanup) operations.push(cleanup);
  const timer = setTimeout(options.reportSlow, ABORT_STALL_NOTICE_MS);
  timer.unref?.();
  void trackAbort(active, operations, options, () => {
    clearTimeout(timer);
    options.log("abort_settled", { elapsedMs: Date.now() - requestedAt });
  });
  return { aborted: true, aborting: true, cancelledQueue };
}
