import { useCallback, useEffect, useRef, useState } from "react";
import type { Issue } from "../../../../shared/desktop-api";
import { agentNote, issuePrompt, nextRunnableIssue, withNote, withStatus } from "./issueModel";

/** 「开始」按下去之后，一条 Issue 走到哪一步了。 */
export type IssueRunPhase = "idle" | "starting" | "running";

export interface IssueRunState {
  phase: IssueRunPhase;
  issueId?: string;
  /** 还会不会自动接着做下一条。点「停止」之后是 false，但当前这条不打断。 */
  auto: boolean;
}

/**
 * 看板的状态和那个「开始」按钮背后的东西。
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

  /** 改一次写一次盘。看板的数据量很小，不值得为它做防抖。 */
  const update = useCallback((next: Issue[]): void => {
    setIssues(next);
    if (cwd) void window.coilcoil.saveIssues(cwd, next).catch(() => undefined);
  }, [cwd]);

  const launch = useCallback((auto: boolean): void => {
    const issue = nextRunnableIssue(issuesRef.current);
    if (!issue) { setRun({ phase: "idle", auto: false }); return; }
    beforePathRef.current = activeSessionPath;
    runSessionRef.current = undefined;
    sawRunningRef.current = false;
    update(withStatus(issuesRef.current, issue.id, "doing"));
    setRun({ phase: "starting", issueId: issue.id, auto });
    startConversation();
    void sendPrompt(issuePrompt(issue)).catch(() => {
      update(withStatus(issuesRef.current, issue.id, "todo"));
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

  /* 发出去了却没起来（最常见的是还没配模型，那种情况下发送会被挡下来并弹个提示）。
     不管一管，这条 Issue 就一直挂在「进行中」，看板再也开不了下一条，所以给它一个
     上限：到点了退回待办，把话说清楚。 */
  useEffect(() => {
    if (run.phase !== "starting" || !run.issueId) return;
    const issueId = run.issueId;
    const timer = window.setTimeout(() => {
      update(withNote(
        withStatus(issuesRef.current, issueId, "todo"),
        issueId,
        agentNote("没能开始——对话没有起来，多半是模型还没配好。退回待办了。"),
      ));
      setRun({ phase: "idle", auto: false });
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [run.issueId, run.phase, update]);

  // 这一轮跑完了：移到待验收，记一条 agent 留言，然后接着做下一条。
  useEffect(() => {
    const sessionPath = runSessionRef.current;
    if (run.phase !== "running" || !run.issueId || !sessionPath) return;
    if (sessionRunning(sessionPath)) { sawRunningRef.current = true; return; }
    if (!sawRunningRef.current) return;
    const issueId = run.issueId;
    const next = withNote(
      withStatus(issuesRef.current, issueId, "review"),
      issueId,
      agentNote("这一轮跑完了，改动在下面那个对话里，等你验收。"),
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
