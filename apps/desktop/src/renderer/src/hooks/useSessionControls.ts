import { useCallback } from "react";
import type { SubagentActivity } from "@suocode/runtime-protocol";
import { toastError } from "../ui/toast";

export interface SessionControls {
  /** Withdraw a prompt that is still waiting its turn. */
  cancelQueuedPrompt: (id: string) => Promise<void>;
  /** Interject a queued prompt into the turn that is already running. */
  promoteQueuedPrompt: (id: string) => Promise<void>;
  /** Stop the running turn and drop everything queued behind it. */
  abortRun: () => Promise<void>;
  /** Stop one subagent, leaving the parent turn and its other work running. */
  stopSubagent: (activity: SubagentActivity) => Promise<void>;
  resumeSubagent: (activity: SubagentActivity) => Promise<void>;
}

/**
 * The session commands that only need a runtime id and report their own errors.
 *
 * They are grouped here so the App component keeps to the conversation state it
 * actually owns.
 */
export function useSessionControls(runtimeId: string | undefined): SessionControls {
  const send = useCallback(async (command: Parameters<typeof window.suocode.request>[0]): Promise<void> => {
    if (!runtimeId) return;
    try {
      await window.suocode.request(command, runtimeId);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [runtimeId]);

  return {
    cancelQueuedPrompt: useCallback((id) => send({ type: "cancel_queued_prompt", id }), [send]),
    promoteQueuedPrompt: useCallback((id) => send({ type: "promote_queued_prompt", id }), [send]),
    abortRun: useCallback(() => send({ type: "abort" }), [send]),
    stopSubagent: useCallback(
      (activity) => send({ type: "stop_subagent", id: activity.id, background: activity.background }),
      [send],
    ),
    resumeSubagent: useCallback((activity) => send({ type: "resume_subagent", id: activity.id }), [send]),
  };
}
