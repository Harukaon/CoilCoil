import { useCallback, useEffect, useRef, useState } from "react";
import type { Issue } from "../../../../shared/desktop-api";
import { agentNote, issuePrompt, nextRunnableIssue, withEvent, withStatus } from "./issueModel";

/** 「开始」按下去之后，一条 Issue 走到哪一步了。 */
export type IssueRunPhase = "idle" | "starting" | "running";

export interface IssueRunState {
  phase: IssueRunPhase;
  issueId?: string;
  /** 还会不会自动接着做下一条。点「停止」之后是 false，但当前这条不打断。 */
  auto: boolean;
}

/** 发出去却起不来（最常见的是模型还没配好）时，等多久就认输。 */
const START_TIMEOUT_MS = 20_000;

/**
 * 面板的数据和那个「开始」按钮背后的东西。
 *
 * 执行是串行的，而且不是后台静默跑：按下开始之后界面会切回对话，你能看着它做，
 * 跟你自己发一条消息没有区别。这是用户定的——「也不考虑做后台静默」。
 *
 * 怎么知道一条做完了：发出去之后盯着这个对话的运行状态，从「在跑」变成「不跑了」
 * 就算这一轮结束，Issue 移到待验收等人看。agent 说自己做完了不算完成，「完成」
 * 只有用户能点。
 */
export function useIssueBoard({
  cwd,
  activeSessionPath,
  sessionRunning,
  startConversation,
  sendPrompt,
}: {
  cwd?: string;
  /** 当前打开的对话，用来认出「开始」刚刚新建的那一个。 */
  activeSessionPath?: string;
  /** 那个对话现在是不是在跑。 */
  sessionRunning(sessionPath: string): boolean;
  /** 在当前工作区起一个新对话。 */
  startConversation(): void;
  /** 把这段话作为一条消息发出去。 */
  sendPrompt(text: string): Promise<void>;
}): {
  issues: Issue[];
  loading: boolean;
  run: IssueRunState;
  update(next: Issue[]): void;
  start(): void;
  stop(): void;
} {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const [run, setRun] = useState<IssueRunState>({ phase: "idle", auto: false });
  /** 发出去之前当前是哪个对话；换掉的那一刻就知道新对话是哪个了。 */
  const beforePathRef = useRef<string | undefined>(undefined);
  const runSessionRef = useRef<string | undefined>(undefined);
  const sawRunningRef = useRef(false);
  const issuesRef = useRef<Issue[]>([]);
  issuesRef.current = issues;

  useEffect(() => {
    if (!cwd) { setIssues([]); return; }
    let cancelled = false;
    setLoading(true);
    void window.coilcoil.listIssues(cwd)
      .then((stored) => { if (!cancelled) setIssues(stored); })
      .catch(() => { if (!cancelled) setIssues([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd]);

  /** 改一次写一次盘。面板的数据量很小，不值得为它做防抖。 */
  const update = useCallback((next: Issue[]): void => {
    setIssues(next);
    if (cwd) void window.coilcoil.saveIssues(cwd, next).catch(() => undefined);
  }, [cwd]);

  const launch = useCallback((auto: boolean): void => {
    const issue = nextRunnableIssue(issuesRef.current);
    if (!issue) { setRun({ phase: "idle", auto: false }); return; }
    const parent = issue.parentId
      ? issuesRef.current.find((item) => item.id === issue.parentId)
      : undefined;
    beforePathRef.current = activeSessionPath;
    runSessionRef.current = undefined;
    sawRunningRef.current = false;
    update(withStatus(issuesRef.current, issue.id, "doing", "agent"));
    setRun({ phase: "starting", issueId: issue.id, auto });
    startConversation();
    void sendPrompt(issuePrompt(issue, parent)).catch(() => {
      update(withStatus(issuesRef.current, issue.id, "ready", "agent"));
      setRun({ phase: "idle", auto: false });
    });
  }, [activeSessionPath, sendPrompt, startConversation, update]);

  // 认出「开始」新建的那个对话：发完之后当前对话就换成它了。
  useEffect(() => {
    if (run.phase !== "starting" || !activeSessionPath) return;
    if (activeSessionPath === beforePathRef.current) return;
    runSessionRef.current = activeSessionPath;
    setRun((current) => current.phase === "starting" ? { ...current, phase: "running" } : current);
  }, [activeSessionPath, run.phase]);

  /* 发出去了却没起来。不管一管，这条就一直挂在「进行中」，面板再也开不了下一条。 */
  useEffect(() => {
    if (run.phase !== "starting" || !run.issueId) return;
    const issueId = run.issueId;
    const timer = window.setTimeout(() => {
      update(withEvent(
        withStatus(issuesRef.current, issueId, "ready", "agent"),
        issueId,
        agentNote("没能开始——对话没有起来，多半是模型还没配好。退回待处理了。"),
      ));
      setRun({ phase: "idle", auto: false });
    }, START_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [run.issueId, run.phase, update]);

  // 这一轮跑完了：移到待验收，记一条留言，然后接着做下一条。
  useEffect(() => {
    const sessionPath = runSessionRef.current;
    if (run.phase !== "running" || !run.issueId || !sessionPath) return;
    if (sessionRunning(sessionPath)) { sawRunningRef.current = true; return; }
    if (!sawRunningRef.current) return;
    const issueId = run.issueId;
    const next = withEvent(
      withStatus(issuesRef.current, issueId, "review", "agent"),
      issueId,
      agentNote("这一轮跑完了，改动在这条对话里，等你验收。"),
    ).map((issue) => issue.id === issueId ? { ...issue, sessionPath } : issue);
    update(next);
    runSessionRef.current = undefined;
    sawRunningRef.current = false;
    if (run.auto) launch(true);
    else setRun({ phase: "idle", auto: false });
  }, [launch, run, sessionRunning, update]);

  return {
    issues,
    loading,
    run,
    update,
    start: useCallback(() => launch(true), [launch]),
    stop: useCallback(() => setRun((current) => ({ ...current, auto: false })), []),
  };
}
