import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  MoveSessionResult,
  ProjectSelection,
  SessionSnapshot,
  SessionSummary,
} from "@suocode/runtime-protocol";
import type { SessionActivityState } from "./WorkspaceSidebar";
import { PROJECTS_STORAGE_KEY } from "../../appState";
import { toastError } from "../../ui/toast";

/**
 * The conversation-level commands the sidebar issues: archive, rename, pin,
 * fork, move to another workspace, and project reordering.
 *
 * These live outside App so it stays inside the renderer's 600-line module
 * limit. They intentionally return plain functions rather than memoized ones:
 * they close over `openConversation`, which App rebuilds every render.
 */
export function useConversationActions({
  sessionActivity,
  projectRef,
  snapshotRef,
  snapshotCacheRef,
  runtimeSessionRef,
  optimisticSessionsRef,
  setProjects,
  setSessionsByProject,
  setSessionActivity,
  setExpandedProjects,
  startPendingConversation,
  openConversation,
}: {
  sessionActivity: Record<string, SessionActivityState>;
  projectRef: MutableRefObject<ProjectSelection | null>;
  snapshotRef: MutableRefObject<SessionSnapshot | undefined>;
  snapshotCacheRef: MutableRefObject<Map<string, SessionSnapshot>>;
  runtimeSessionRef: MutableRefObject<Map<string, string>>;
  optimisticSessionsRef: MutableRefObject<Map<string, SessionSummary>>;
  setProjects: Dispatch<SetStateAction<ProjectSelection[]>>;
  setSessionsByProject: Dispatch<SetStateAction<Record<string, SessionSummary[]>>>;
  setSessionActivity: Dispatch<SetStateAction<Record<string, SessionActivityState>>>;
  setExpandedProjects: Dispatch<SetStateAction<Set<string>>>;
  startPendingConversation(selection: ProjectSelection): void;
  openConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
}): {
  archiveConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  renameConversation(owner: ProjectSelection, session: SessionSummary, name: string): Promise<void>;
  pinConversation(owner: ProjectSelection, session: SessionSummary, pinned: boolean): Promise<void>;
  forkConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  moveConversation(owner: ProjectSelection, session: SessionSummary, target: ProjectSelection): Promise<void>;
  reorderProjects(fromPath: string, toPath: string): void;
} {
  const forgetSession = (sessionPath: string): void => {
    snapshotCacheRef.current.delete(sessionPath);
    optimisticSessionsRef.current.delete(sessionPath);
    for (const [runtimeId, path] of runtimeSessionRef.current) {
      if (path === sessionPath) runtimeSessionRef.current.delete(runtimeId);
    }
    setSessionActivity((current) => {
      const updated = { ...current };
      delete updated[sessionPath];
      return updated;
    });
  };

  const isActiveConversation = (owner: ProjectSelection, session: SessionSummary): boolean =>
    owner.path === projectRef.current?.path && session.id === snapshotRef.current?.session.id;

  const archiveConversation = async (owner: ProjectSelection, session: SessionSummary): Promise<void> => {
    if (sessionActivity[session.path]?.running) {
      toastError("请先停止正在运行的会话，再进行归档。");
      return;
    }
    try {
      const next = await window.suocode.request<SessionSummary[]>({ type: "archive_session", cwd: owner.path, sessionPath: session.path });
      optimisticSessionsRef.current.delete(session.path);
      setSessionsByProject((current) => ({ ...current, [owner.path]: next }));
      setSessionActivity((current) => {
        const updated = { ...current };
        delete updated[session.path];
        return updated;
      });
      if (isActiveConversation(owner, session)) startPendingConversation(owner);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const renameConversation = async (owner: ProjectSelection, session: SessionSummary, name: string): Promise<void> => {
    const next = await window.suocode.request<SessionSummary[]>({ type: "rename_session", cwd: owner.path, sessionPath: session.path, name });
    setSessionsByProject((current) => ({ ...current, [owner.path]: next }));
  };

  const pinConversation = async (owner: ProjectSelection, session: SessionSummary, pinned: boolean): Promise<void> => {
    try {
      const next = await window.suocode.request<SessionSummary[]>({ type: "pin_session", cwd: owner.path, sessionPath: session.path, pinned });
      setSessionsByProject((current) => ({ ...current, [owner.path]: next }));
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const forkConversation = async (owner: ProjectSelection, session: SessionSummary): Promise<void> => {
    if (sessionActivity[session.path]?.running) {
      toastError("请先停止正在运行的会话，再进行 Fork。");
      return;
    }
    try {
      const result = await window.suocode.request<{ sessions: SessionSummary[]; session: SessionSummary }>({
        type: "fork_session",
        cwd: owner.path,
        sessionPath: session.path,
      });
      setSessionsByProject((current) => ({ ...current, [owner.path]: result.sessions }));
      await openConversation(owner, result.session);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const moveConversation = async (owner: ProjectSelection, session: SessionSummary, target: ProjectSelection): Promise<void> => {
    if (sessionActivity[session.path]?.running) {
      toastError("请先停止正在运行的会话，再移动到其他工作区。");
      return;
    }
    try {
      const result = await window.suocode.request<MoveSessionResult>({
        type: "move_session",
        cwd: owner.path,
        sessionPath: session.path,
        targetCwd: target.path,
      });
      // The conversation belongs to another project now, so everything cached
      // against the old workspace is stale: the snapshot carries the previous
      // cwd and file tree, and the runtime that produced it has been released.
      // That release also closed this session's browser tabs in the main process.
      const wasActive = isActiveConversation(owner, session);
      forgetSession(session.path);
      setSessionsByProject((current) => ({
        ...current,
        [owner.path]: result.sessions,
        [target.path]: result.targetSessions,
      }));
      setExpandedProjects((current) => new Set(current).add(target.path));
      // Following the conversation into its new workspace is less disorienting
      // than dropping the user on a blank composer where it used to be.
      if (wasActive) await openConversation(target, result.session);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const reorderProjects = (fromPath: string, toPath: string): void => {
    setProjects((current) => {
      const from = current.findIndex((item) => item.path === fromPath);
      const to = current.findIndex((item) => item.path === toPath);
      if (from === -1 || to === -1 || from === to) return current;
      const next = [...current];
      next.splice(to, 0, ...next.splice(from, 1));
      window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next.filter((item) => item.kind === "workspace")));
      return next;
    });
  };

  return {
    archiveConversation,
    renameConversation,
    pinConversation,
    forkConversation,
    moveConversation,
    reorderProjects,
  };
}
