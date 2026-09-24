import { useCallback, useEffect, useRef, useState } from "react";
import type { GitAction, GitBranch, GitDiff, GitStatus } from "@coilcoil/runtime-protocol";

/** 面板开着时隔多久重新问一次 git：Agent、终端、别的编辑器随时在改工作区。 */
const REFRESH_INTERVAL_MS = 4000;

export type GitBusy = "stage" | "unstage" | "discard" | "commit" | "push" | "pull" | "checkout" | "create_branch";

function request<T>(cwd: string, action: GitAction): Promise<T> {
  return window.coilcoil.request<T>({ type: "git", cwd, action });
}

/**
 * 一个工作区的 git 状态和操作。
 *
 * 状态只从 git 读，不在界面里推算：每个改动类操作都直接返回改完之后的状态。
 * `active` 为假（面板不可见）时不轮询。
 */
export function useGit(cwd: string | undefined, active: boolean): {
  status?: GitStatus;
  error?: string;
  busy?: GitBusy;
  refresh: () => Promise<void>;
  run: (action: Exclude<GitAction, { op: "status" | "diff" | "branches" }>) => Promise<boolean>;
  diff: (path: string, staged: boolean) => Promise<GitDiff>;
  branches: () => Promise<GitBranch[]>;
} {
  const [status, setStatus] = useState<GitStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<GitBusy>();
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const refresh = useCallback(async (): Promise<void> => {
    const target = cwdRef.current;
    if (!target) return;
    try {
      const next = await request<GitStatus>(target, { op: "status" });
      if (cwdRef.current === target) {
        setStatus(next);
        setError(undefined);
      }
    } catch (caught) {
      if (cwdRef.current === target) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
    if (!cwd || !active) return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
    const onFocus = (): void => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, cwd, refresh]);

  const run = useCallback(async (action: Exclude<GitAction, { op: "status" | "diff" | "branches" }>): Promise<boolean> => {
    const target = cwdRef.current;
    if (!target) return false;
    setBusy(action.op);
    try {
      const next = await request<GitStatus>(target, action);
      if (cwdRef.current === target) {
        setStatus(next);
        setError(undefined);
      }
      return true;
    } catch (caught) {
      if (cwdRef.current === target) setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(undefined);
    }
  }, []);

  const diff = useCallback((path: string, staged: boolean) => request<GitDiff>(cwdRef.current ?? "", { op: "diff", path, staged }), []);
  const branches = useCallback(() => request<GitBranch[]>(cwdRef.current ?? "", { op: "branches" }), []);

  return { status, error, busy, refresh, run, diff, branches };
}
