import { useCallback, useEffect, useRef, useState } from "react";
import type { GitAction, GitBranch, GitCommitFile, GitDiff, GitLog, GitRepository, GitStatus } from "@coilcoil/runtime-protocol";

/** 面板开着时隔多久重新问一次 git：Agent、终端、别的编辑器随时在改工作区。 */
const REFRESH_INTERVAL_MS = 4000;

export type GitBusy = "stage" | "unstage" | "discard" | "stage_all" | "unstage_all" | "discard_all" | "commit" | "push" | "pull" | "checkout" | "create_branch";

type ReadAction = "status" | "diff" | "branches" | "log" | "commit_files" | "commit_diff" | "repositories";

function request<T>(cwd: string, action: GitAction): Promise<T> {
  return window.coilcoil.request<T>({ type: "git", cwd, action });
}

/** 工作区里的 git 仓库：工作区本身所在的，加上子文件夹里的。 */
export function listRepositories(workspace: string): Promise<GitRepository[]> {
  return request<GitRepository[]>(workspace, { op: "repositories" });
}

/**
 * 一个工作区的 git 状态和操作。
 *
 * 状态只从 git 读，不在界面里推算：每个改动类操作都直接返回改完之后的状态。
 * `active` 为假（面板不可见）或窗口在后台时不轮询；上一次还没回来就不发下一次；
 * 状态没变就不更新，免得每次轮询都把整张列表重画一遍。
 */
export function useGit(cwd: string | undefined, active: boolean): {
  status?: GitStatus;
  error?: string;
  busy?: GitBusy;
  refresh: () => Promise<void>;
  run: (action: Exclude<GitAction, { op: ReadAction }>) => Promise<boolean>;
  diff: (path: string, staged: boolean) => Promise<GitDiff>;
  branches: () => Promise<GitBranch[]>;
  log: (limit: number, all: boolean) => Promise<GitLog>;
  commitFiles: (hash: string) => Promise<GitCommitFile[]>;
  commitDiff: (hash: string, path: string, originalPath?: string) => Promise<GitDiff>;
} {
  const [status, setStatus] = useState<GitStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<GitBusy>();
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const inFlight = useRef(false);
  const lastJson = useRef<string | undefined>(undefined);

  const apply = useCallback((next: GitStatus): void => {
    const json = JSON.stringify(next);
    if (json === lastJson.current) return;
    lastJson.current = json;
    setStatus(next);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const target = cwdRef.current;
    if (!target || inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await request<GitStatus>(target, { op: "status" });
      if (cwdRef.current === target) {
        apply(next);
        setError(undefined);
      }
    } catch (caught) {
      if (cwdRef.current === target) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      inFlight.current = false;
    }
  }, [apply]);

  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
    lastJson.current = undefined;
    if (!cwd || !active) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    const onFocus = (): void => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, cwd, refresh]);

  const run = useCallback(async (action: Exclude<GitAction, { op: ReadAction }>): Promise<boolean> => {
    const target = cwdRef.current;
    if (!target) return false;
    setBusy(action.op);
    try {
      const next = await request<GitStatus>(target, action);
      if (cwdRef.current === target) {
        apply(next);
        setError(undefined);
      }
      return true;
    } catch (caught) {
      if (cwdRef.current === target) setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(undefined);
    }
  }, [apply]);

  const diff = useCallback((path: string, staged: boolean) => request<GitDiff>(cwdRef.current ?? "", { op: "diff", path, staged }), []);
  const branches = useCallback(() => request<GitBranch[]>(cwdRef.current ?? "", { op: "branches" }), []);

  const log = useCallback((limit: number, all: boolean) => request<GitLog>(cwdRef.current ?? "", { op: "log", limit, all }), []);
  const commitFiles = useCallback((hash: string) => request<GitCommitFile[]>(cwdRef.current ?? "", { op: "commit_files", hash }), []);
  const commitDiff = useCallback((hash: string, path: string, originalPath?: string) => (
    request<GitDiff>(cwdRef.current ?? "", { op: "commit_diff", hash, path, originalPath })
  ), []);

  return { status, error, busy, refresh, run, diff, branches, log, commitFiles, commitDiff };
}
