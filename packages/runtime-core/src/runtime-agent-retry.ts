import { type RuntimeEvent } from "@coilcoil/runtime-protocol";
import { type DiagnosticLog } from "@coilcoil/diagnostics";

interface AutoRetryStart {
  type: "auto_retry_start";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

interface AutoRetryEnd {
  type: "auto_retry_end";
  success: boolean;
  attempt: number;
  finalError?: string;
}

export type AutoRetryEvent = AutoRetryStart | AutoRetryEnd;

/**
 * Turn Pi's silent turn retries into something the user can see.
 *
 * When an upstream drops a stream mid-turn, Pi retries with backoff and says
 * nothing. From the outside that looked like the Agent stopping for no reason,
 * with no record anywhere of what happened. Every attempt now lands in the
 * diagnostic log with the provider's own wording, and the UI gets an event so
 * the composer can say it is retrying rather than appear stuck.
 */
export function agentRetryRuntimeEvent(
  event: AutoRetryEvent,
  log: DiagnosticLog,
): RuntimeEvent {
  if (event.type === "auto_retry_start") {
    log.warn("agent-retry", "auto_retry_start", {
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      error: event.errorMessage,
    });
    return {
      type: "agent_retry",
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      message: event.errorMessage,
    };
  }
  log.log(event.success ? "info" : "warn", "agent-retry", "auto_retry_end", {
    success: event.success,
    attempt: event.attempt,
    error: event.finalError,
  });
  return {
    type: "agent_retry_finished",
    success: event.success,
    attempt: event.attempt,
    error: event.finalError,
  };
}
