import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_WAIT_STATE_CHANNEL, BACKGROUND_WAKE_FAILURE_CHANNEL,
  type BackgroundWaitState, type BackgroundWakeFailure } from "../background-wait.ts";

type ChildRunSession = Pick<AgentSession, "prompt" | "subscribe" | "isStreaming" | "abort">;
interface ChildRunBus {
  on(channel: string, listener: (data: unknown) => void): () => void;
}
interface PendingPrompt {
  initialDone: boolean;
  suspendedAt?: number;
  failure?: Error;
  signal?: AbortSignal;
  onAbort(): void;
  resolve(): void;
  reject(error: Error): void;
}

function abortError(): Error {
  return new DOMException("子 Agent 运行已停止。", "AbortError");
}

/** A suspended model loop still belongs to the same child run until its event-driven continuation settles. */
export function createChildRunDriver(session: ChildRunSession, events: ChildRunBus) {
  let waiting = false;
  let generation = 0;
  let settledGeneration = 0;
  let running = false;
  let disposed = false;
  let current: PendingPrompt | undefined;
  const shutdownErrors: Error[] = [];

  const finish = (error?: Error): void => {
    const pending = current;
    if (!pending) return;
    current = undefined;
    pending.signal?.removeEventListener("abort", pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve();
  };
  const check = (): void => {
    const pending = current;
    if (!pending?.initialDone || waiting || running || session.isStreaming) return;
    if (pending.suspendedAt !== undefined && settledGeneration <= pending.suspendedAt) return;
    finish(pending.failure);
  };
  const onEvent = (event: AgentSessionEvent): void => {
    if (event.type === "agent_start") {
      generation += 1;
      running = true;
      if (current) current.failure = undefined;
    } else if (event.type === "tool_execution_end") {
      const details = event.result.details as { waiting?: boolean } | undefined;
      if (current && event.result.terminate === true && details?.waiting === true) current.suspendedAt = generation;
    } else if (event.type === "message_start" && event.message.role === "assistant") {
      // A mixed tool batch or a steered notification can continue the same loop instead of suspending it.
      if (current?.suspendedAt === generation) current.suspendedAt = undefined;
    } else if (event.type === "message_end" && event.message.role === "assistant" && current) {
      current.failure = event.message.stopReason === "error"
        ? new Error(event.message.errorMessage || "子 Agent 模型请求失败。") : undefined;
    } else if (event.type === "agent_settled") {
      running = false;
      settledGeneration = generation;
      if (event.aborted) finish(current?.failure ?? abortError());
      else if (current?.failure) finish(current.failure);
      else {
        if (waiting && current) current.suspendedAt = generation;
        check();
      }
    }
  };
  const unsubscribe = session.subscribe(onEvent);
  const stopWaiting = events.on(BACKGROUND_WAIT_STATE_CHANNEL, (data) => {
    const next = (data as BackgroundWaitState).waiting;
    if (waiting && !next && current) current.suspendedAt = generation;
    waiting = next;
    // Releasing a wait precedes delivery and agent_start. It is never a completed continuation.
    check();
  });
  const stopFailure = events.on(BACKGROUND_WAKE_FAILURE_CHANNEL, (data) => {
    finish(new Error((data as BackgroundWakeFailure).error));
  });

  return {
    prompt(task: string, signal?: AbortSignal): Promise<void> {
      if (disposed) return Promise.reject(new Error("子 Agent 会话已关闭。"));
      if (current) return Promise.reject(new Error("子 Agent 已有正在进行的运行。"));
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise<void>((resolve, reject) => {
        const pending: PendingPrompt = {
          initialDone: false, signal, resolve, reject,
          onAbort: () => {
            finish(current?.failure ?? abortError());
          },
        };
        current = pending;
        signal?.addEventListener("abort", pending.onAbort, { once: true });
        void session.prompt(task, { source: "extension" }).then(() => {
          if (current !== pending) return;
          pending.initialDone = true;
          check();
        }, (error: unknown) => {
          if (current === pending) finish(error instanceof Error ? error : new Error(String(error)));
        });
      });
    },
    onExtensionError(error: { event: string; error: string }): void {
      if (error.event === "send_message") finish(new Error(error.error));
      if (error.event === "session_shutdown") shutdownErrors.push(new Error(error.error));
    },
    get shutdownErrors(): readonly Error[] { return [...shutdownErrors]; },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      finish(current?.failure ?? abortError());
      unsubscribe();
      stopWaiting();
      stopFailure();
    },
  };
}

export type ChildRunDriver = ReturnType<typeof createChildRunDriver>;
