import { useCallback } from "react";
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type {
  ProjectSnapshot,
  RuntimeConfiguration,
  RuntimeEvent,
  PromptDocument,
  SessionSnapshot,
  SessionSummary,
  SubagentActivity,
  ToolRun,
} from "@coilcoil/runtime-protocol";
import type { SessionActivityState } from "../features/workspaces/WorkspaceSidebar";
import { upsertSessionSummary } from "../features/workspaces/sessionList";
import type { conversationMessagesReducer } from "../features/conversation/conversationMessages";
import { diagnostics } from "../diagnostics";
import { toastError, toastInfo, toastSuccess } from "../ui/toast";

type ConversationMessageAction = Parameters<typeof conversationMessagesReducer>[1];
type AgentPhase = "思考" | "回复" | "工具" | "重试";

function upsertTool(tools: ToolRun[], tool: ToolRun): ToolRun[] {
  const index = tools.findIndex((item) => item.id === tool.id);
  if (index < 0) return [...tools, tool];
  const next = [...tools];
  next[index] = tool;
  return next;
}

export function useRuntimeEventHandler({
  snapshotRef,
  snapshotCacheRef,
  runtimeSessionRef,
  optimisticSessionsRef,
  applySnapshot,
  dispatchConversationMessages,
  restoreDraft,
  restoreDocument,
  setSnapshot,
  setSessionActivity,
  setConfiguration,
  setSessionsByProject,
  setAgentPhase,
  setTools,
  setProjectState,
  setSubagents,
}: {
  snapshotRef: MutableRefObject<SessionSnapshot | undefined>;
  snapshotCacheRef: MutableRefObject<Map<string, SessionSnapshot>>;
  runtimeSessionRef: MutableRefObject<Map<string, string>>;
  optimisticSessionsRef: MutableRefObject<Map<string, SessionSummary>>;
  applySnapshot(next: SessionSnapshot): void;
  dispatchConversationMessages: Dispatch<ConversationMessageAction>;
  restoreDraft(text: string): void;
  restoreDocument?: (document: PromptDocument) => void;
  setSnapshot: Dispatch<SetStateAction<SessionSnapshot | undefined>>;
  setSessionActivity: Dispatch<SetStateAction<Record<string, SessionActivityState>>>;
  setConfiguration: Dispatch<SetStateAction<RuntimeConfiguration | undefined>>;
  setSessionsByProject: Dispatch<SetStateAction<Record<string, SessionSummary[]>>>;
  setAgentPhase: Dispatch<SetStateAction<AgentPhase | undefined>>;
  setTools: Dispatch<SetStateAction<ToolRun[]>>;
  setProjectState: Dispatch<SetStateAction<ProjectSnapshot>>;
  setSubagents: Dispatch<SetStateAction<SubagentActivity[]>>;
}): (event: RuntimeEvent, runtimeId?: string) => void {
  return useCallback((event: RuntimeEvent, runtimeId?: string): void => {
    if (event.type === "session_snapshot") {
      const path = event.snapshot.session.path;
      if (path) snapshotCacheRef.current.set(path, event.snapshot);
      if (runtimeId && path) runtimeSessionRef.current.set(runtimeId, path);
      if (path) {
        setSessionActivity((current) => {
          const active = snapshotRef.current?.runtimeId === runtimeId;
          return { ...current, [path]: { runtimeId, running: event.snapshot.running, unread: active ? false : current[path]?.unread ?? false } };
        });
      }
      if (runtimeId !== snapshotRef.current?.runtimeId) return;
    } else if (event.type === "run_state" && runtimeId) {
      const path = runtimeSessionRef.current.get(runtimeId);
      if (path) {
        setSessionActivity((current) => {
          const active = snapshotRef.current?.runtimeId === runtimeId;
          return { ...current, [path]: { runtimeId, running: event.running, unread: !event.running && !active ? true : active ? false : current[path]?.unread ?? false } };
        });
      }
      if (runtimeId !== snapshotRef.current?.runtimeId) return;
    } else if (runtimeId && runtimeId !== snapshotRef.current?.runtimeId && event.type !== "sessions_updated") {
      return;
    }
    switch (event.type) {
      case "runtime_ready":
      case "configuration_updated":
        setConfiguration(event.configuration);
        break;
      case "sessions_updated":
        setSessionsByProject((current) => {
          let sessions = event.sessions;
          const confirmedPaths = new Set(event.sessions.map((session) => session.path));
          for (const [path, optimistic] of optimisticSessionsRef.current) {
            if (confirmedPaths.has(path)) optimisticSessionsRef.current.delete(path);
            else if (optimistic.cwd === event.cwd) sessions = upsertSessionSummary(sessions, optimistic);
          }
          return { ...current, [event.cwd]: sessions };
        });
        break;
      case "session_snapshot":
        applySnapshot(event.snapshot);
        break;
      case "session_fast_updated":
        setSnapshot((current) => {
          if (!current) return current;
          const next = { ...current, fast: event.fast };
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
        break;
      case "goal_updated":
        setSnapshot((current) => {
          if (!current) return current;
          const next = { ...current, goal: event.goal };
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
        break;
      case "prompt_queue_updated":
        dispatchConversationMessages({
          type: "prompt_queue",
          queue: event.queue,
          revision: event.revision,
          sessionPath: runtimeId ? runtimeSessionRef.current.get(runtimeId) : snapshotRef.current?.session.path,
          runtimeId,
        });
        setSnapshot((current) => {
          if (!current) return current;
          const next = { ...current, promptQueue: event.queue };
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
        break;
      case "message_started":
      case "message_finished":
        dispatchConversationMessages({
          type: "runtime_message",
          message: event.message,
          revision: event.revision,
          sessionPath: runtimeId ? runtimeSessionRef.current.get(runtimeId) : snapshotRef.current?.session.path,
          runtimeId,
        });
        break;
      case "message_delta":
        setAgentPhase(event.field === "thinking" ? "思考" : "回复");
        dispatchConversationMessages({
          ...event,
          timestamp: Date.now(),
          sessionPath: runtimeId ? runtimeSessionRef.current.get(runtimeId) : snapshotRef.current?.session.path,
          runtimeId,
        });
        break;
      case "message_steering":
        // It has left the queue panel and Pi will only append it when the turn
        // ends, so the transcript carries it, marked, for that whole stretch.
        dispatchConversationMessages({
          type: "queue",
          sessionPath: snapshotRef.current?.session.path,
          message: {
            id: event.id,
            order: event.timestamp,
            role: "user",
            text: event.text,
            promptDocument: event.promptDocument,
            images: event.images,
            timestamp: event.timestamp,
            status: "steering",
          },
        });
        break;
      case "message_rejected":
        dispatchConversationMessages({ type: "reject", id: event.id, revision: event.revision });
        // A stop hands back the steered message Pi never delivered; without this
        // it would only vanish from the transcript, which loses what was typed.
        if (event.promptDocument && restoreDocument) restoreDocument(event.promptDocument);
        else if (event.text) restoreDraft(event.text);
        break;
      case "tool_started":
        setAgentPhase("工具");
        setTools((current) => upsertTool(current, event.tool));
        break;
      case "tool_updated":
      case "tool_finished":
        setTools((current) => upsertTool(current, event.tool));
        if (event.type === "tool_finished") setAgentPhase("思考");
        break;
      case "plan_updated":
        setProjectState((current) => ({ ...current, plan: event.plan }));
        break;
      case "plan_approval_updated":
        setProjectState((current) => ({ ...current, planApproval: event.plan }));
        setSnapshot((current) => {
          if (!current) return current;
          const next = { ...current, project: { ...current.project, planApproval: event.plan } };
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
        break;
      case "subagents_updated":
        setSubagents(event.subagents);
        setSnapshot((current) => {
          if (!current) return current;
          const next = { ...current, subagents: event.subagents };
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
        break;
      case "project_updated":
        setProjectState(event.project);
        break;
      case "metrics_updated":
        setSnapshot((current) => {
          if (!current) return current;
          const next = {
            ...current,
            responseMetrics: event.responseMetrics,
            responseMetricsHistory: event.responseMetricsHistory,
            contextUsage: event.contextUsage,
            tokenUsage: event.tokenUsage,
          };
          // The ref and the cache are what a session switch and every
          // synchronous read see. Leaving them behind here made the context
          // ring fall back to a stale token count on the way back to a session.
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
        break;
      case "runtime_inspection_updated":
        setSnapshot((current) => {
          if (!current) return current;
          const next = { ...current, runtimeInspection: event.inspection };
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
        break;
      case "agent_retry":
        // Silent retries were indistinguishable from the Agent giving up, which
        // is why a flaky upstream felt like a bug in CoilCoil.
        diagnostics.warn("agent-retry", "agent_retry", {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          message: event.message,
        });
        setAgentPhase("重试");
        toastInfo(`上游中断，${Math.round(event.delayMs / 1000)} 秒后重试（第 ${event.attempt}/${event.maxAttempts} 次）`);
        break;
      case "agent_retry_finished":
        setAgentPhase(event.success ? "思考" : undefined);
        if (!event.success) toastError(`重试 ${event.attempt} 次后仍未成功：${event.error ?? "上游持续不可用"}`);
        break;
      case "runtime_notice":
        diagnostics.info("runtime-notice", event.level, { message: event.message });
        if (event.level === "error") toastError(event.message);
        else if (event.level === "success") toastSuccess(event.message);
        else toastInfo(event.message);
        break;
      case "run_state":
        setSnapshot((current) => current ? { ...current, running: event.running, aborting: event.aborting } : current);
        setAgentPhase(event.running ? "思考" : undefined);
        break;
      case "runtime_error":
        // The toast is gone in seconds and never showed `detail` at all, so the
        // stack behind a failure had nowhere to land until now.
        diagnostics.error("runtime-error", "runtime_error", event.message, { detail: event.detail, runtimeId });
        toastError(event.message);
        break;
      default:
        break;
    }
  }, [applySnapshot, dispatchConversationMessages, optimisticSessionsRef, restoreDocument, restoreDraft, runtimeSessionRef,
    setAgentPhase, setConfiguration, setProjectState, setSessionActivity, setSessionsByProject,
    setSnapshot, setSubagents, setTools, snapshotCacheRef, snapshotRef]);
}
