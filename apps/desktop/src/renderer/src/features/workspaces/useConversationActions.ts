import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  MoveSessionResult,
  ProjectSelection,
  SessionSnapshot,
  SessionSummary,
} from "@coilcoil/runtime-protocol";
import type { SessionActivityState } from "./WorkspaceSidebar";
import { nextSelectionAfterArchive } from "./sessionList";
import { saveMountedProjects, syncMountedProjects } from "../../appState";
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
  projects,
  sessionsByProject,
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
  removeProject,
}: {
  projects: ProjectSelection[];
  sessionsByProject: Record<string, SessionSummary[]>;
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
  removeProject(owner: ProjectSelection): void;
}): {
  archiveConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  deleteConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  deleteWorkspaceData(owner: ProjectSelection): Promise<void>;
  renameConversation(owner: ProjectSelection, session: SessionSummary, name: string): Promise<void>;
  pinConversation(owner: ProjectSelection, session: SessionSummary, pinned: boolean): Promise<void>;
  forkConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  moveConversation(owner: ProjectSelection, session: SessionSummary, target: ProjectSelection): Promise<void>;
  reorderProjects(fromPath: string, toPath: string): void;
} {
  /* 开机对一次账：磁盘上的挂载清单和界面本地那份取并集。
     这段本该在 App 里，放在这里是因为 App 卡在 600 行的模块上限上——这个文件本来
     就是为此拆出来的，挂载清单的写入也在这里。 */
  useEffect(() => {
    let cancelled = false;
    void syncMountedProjects().then((stored) => {
      if (cancelled || !stored.length) return;
      setProjects((current) => {
        const known = new Set(current.map((item) => item.path));
        const missing = stored.filter((item) => !known.has(item.path));
        return missing.length ? [...current, ...missing] : current;
      });
    });
    return () => { cancelled = true; };
    // 只在挂载时对一次账，之后每次改动都会自己写盘。
  }, []);

  /* 归档和删除要在渲染之前就知道「动手之前这个工作区有哪些对话」：拿它算下一个该
     选谁，也拿它在后端失败时把列表整份放回去。直接读参数会拿到这一轮渲染的快照，
     异步回来时已经过期，所以照 projectRef 的样子挂一个镜像。 */
  const sessionsByProjectRef = useRef(sessionsByProject);
  sessionsByProjectRef.current = sessionsByProject;

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

  /**
   * 归档一条对话。
   *
   * 前端不等后端。归档要把会话文件挪进归档目录、再把整个工作区重列一遍，这一趟
   * 回来之前界面上那一行还杵在那儿，点下去就是一段说不清的僵住——用户的话是
   * 「不管你做了什么操作，至少前端这里必须立刻没有状态…你可以去后台慢慢做」。
   * 所以先按预期把行拿掉、把选中挪走，请求丢到后面去跑；成功了用后端那份权威
   * 列表对齐，失败了把列表整份放回去并报错。
   */
  const archiveConversation = async (owner: ProjectSelection, session: SessionSummary): Promise<void> => {
    if (sessionActivity[session.path]?.running) {
      toastError("请先停止正在运行的会话，再进行归档。");
      return;
    }
    const previous = sessionsByProjectRef.current[owner.path] ?? [];
    // 选中要在列表被改之前算：算的是「归档前的邻居」。
    const successor = isActiveConversation(owner, session)
      ? nextSelectionAfterArchive(previous, session.path)
      : undefined;
    const wasActive = isActiveConversation(owner, session);

    optimisticSessionsRef.current.delete(session.path);
    setSessionsByProject((current) => ({
      ...current,
      [owner.path]: (current[owner.path] ?? []).filter((item) => item.path !== session.path),
    }));
    setSessionActivity((current) => {
      const updated = { ...current };
      delete updated[session.path];
      return updated;
    });
    if (wasActive) {
      // 没有下一条就落到空白：不再凭空弹一个「新对话」出来。
      if (successor) void openConversation(owner, successor);
      else startPendingConversation(owner);
    }

    try {
      const next = await window.coilcoil.request<SessionSummary[]>({ type: "archive_session", cwd: owner.path, sessionPath: session.path });
      setSessionsByProject((current) => ({ ...current, [owner.path]: next }));
    } catch (caught) {
      setSessionsByProject((current) => ({ ...current, [owner.path]: previous }));
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  /**
   * 永久删除一条对话。除了请求不一样，和归档走同一套：前端先撤、后端慢慢做、
   * 失败了整份放回去。确认框在侧栏那一层，到这里已经是确定要删了。
   */
  const deleteConversation = async (owner: ProjectSelection, session: SessionSummary): Promise<void> => {
    if (sessionActivity[session.path]?.running) {
      toastError("请先停止正在运行的会话，再进行删除。");
      return;
    }
    const previous = sessionsByProjectRef.current[owner.path] ?? [];
    const wasActive = isActiveConversation(owner, session);
    const successor = wasActive ? nextSelectionAfterArchive(previous, session.path) : undefined;

    forgetSession(session.path);
    setSessionsByProject((current) => ({
      ...current,
      [owner.path]: (current[owner.path] ?? []).filter((item) => item.path !== session.path),
    }));
    if (wasActive) {
      if (successor) void openConversation(owner, successor);
      else startPendingConversation(owner);
    }

    try {
      const next = await window.coilcoil.request<SessionSummary[]>({ type: "delete_session", cwd: owner.path, sessionPath: session.path });
      setSessionsByProject((current) => ({ ...current, [owner.path]: next }));
    } catch (caught) {
      setSessionsByProject((current) => ({ ...current, [owner.path]: previous }));
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  /**
   * 删掉一个工作区的全部对话记录，然后把它从侧栏卸载。
   *
   * 用完就想扔掉的工作区，以前只能「卸载」——记录还在磁盘上，重新挂回来它们又都
   * 回来了。确认框在侧栏那一层，到这里已经确定要删。
   */
  const deleteWorkspaceData = async (target: ProjectSelection): Promise<void> => {
    if (target.kind === "home") return;
    // 先按预期把它从界面上撤掉，删表在后面慢慢跑。
    removeProject(target);
    setSessionsByProject((current) => {
      const next = { ...current };
      delete next[target.path];
      return next;
    });
    if (projectRef.current?.path === target.path) {
      const fallback = projects.find((item) => item.path !== target.path);
      if (fallback) startPendingConversation(fallback);
    }
    try {
      await window.coilcoil.request<{ deleted: number }>({ type: "delete_workspace_sessions", cwd: target.path });
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const renameConversation = async (owner: ProjectSelection, session: SessionSummary, name: string): Promise<void> => {
    const next = await window.coilcoil.request<SessionSummary[]>({ type: "rename_session", cwd: owner.path, sessionPath: session.path, name });
    setSessionsByProject((current) => ({ ...current, [owner.path]: next }));
  };

  const pinConversation = async (owner: ProjectSelection, session: SessionSummary, pinned: boolean): Promise<void> => {
    try {
      const next = await window.coilcoil.request<SessionSummary[]>({ type: "pin_session", cwd: owner.path, sessionPath: session.path, pinned });
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
      const result = await window.coilcoil.request<{ sessions: SessionSummary[]; session: SessionSummary }>({
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
      const result = await window.coilcoil.request<MoveSessionResult>({
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
      saveMountedProjects(next);
      return next;
    });
  };

  return {
    archiveConversation,
    deleteConversation,
    deleteWorkspaceData,
    renameConversation,
    pinConversation,
    forkConversation,
    moveConversation,
    reorderProjects,
  };
}
