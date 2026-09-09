import { useCallback, useEffect, useRef, useState } from "react";
import type { Issue } from "../../../../shared/desktop-api";
import { agentNote, comment, issueImages, issuePrompt, nextRunnableIssue, withEvent, withStatus } from "./issueModel";

/** 「开始」按下去之后，一条 Issue 走到哪一步了。 */
export type IssueRunPhase = "idle" | "running";

export interface IssueRunState {
  phase: IssueRunPhase;
  issueId?: string;
  /** 还会不会自动接着做下一条。点「停止」之后是 false，但当前这条不打断。 */
  auto: boolean;
}

/** 运行时那边跑完一条任务后交回来的东西。 */
interface IssueRunResult {
  kind: "reply" | "ask" | "fallback";
  text: string;
  verify?: string;
  turns: number;
}

/**
 * 面板的数据和那个「开始」按钮背后的东西。
 *
 * 执行是串行的，而且和你自己的对话完全没有关系：按下开始不会新建对话、不会跳界
 * 面、侧栏也不会多出一条记录。那条运行在后台自己跑，跑完只交回一段结论，写进这条
 * 任务的时间线——「这本来就是完全两个隔离的东西……它只和 issue 相关联」。
 *
 * 所以这里不再盯着某个对话的运行状态：一次调用从头等到尾，回来什么就记什么。
 * · 它交了结论 → 待验收
 * · 它要你拿主意 → 待回复
 * · 它一句话都没说（催满了）→ 也是待验收，但会说明这是它最后那段话，不是结论
 */
export function useIssueBoard({
  cwd,
  runIssue,
}: {
  cwd?: string;
  /** 把一条任务交给后台跑，跑完给结论。 */
  runIssue(input: { cwd: string; issue: Issue; parent?: Issue }): Promise<IssueRunResult>;
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
  const issuesRef = useRef<Issue[]>([]);
  issuesRef.current = issues;
  const autoRef = useRef(false);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

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
    if (cwdRef.current) void window.coilcoil.saveIssues(cwdRef.current, next).catch(() => undefined);
  }, []);

  const launch = useCallback(async (): Promise<void> => {
    const workspace = cwdRef.current;
    if (!workspace) { setRun({ phase: "idle", auto: false }); return; }
    const issue = nextRunnableIssue(issuesRef.current);
    if (!issue) { autoRef.current = false; setRun({ phase: "idle", auto: false }); return; }
    const parent = issue.parentId
      ? issuesRef.current.find((item) => item.id === issue.parentId)
      : undefined;
    update(withStatus(issuesRef.current, issue.id, "doing", "agent"));
    setRun({ phase: "running", issueId: issue.id, auto: autoRef.current });

    try {
      const result = await runIssue({ cwd: workspace, issue, parent });
      const finished = result.kind === "ask" ? "reply" : "review";
      const note = result.kind === "ask"
        ? comment(result.text, "agent")
        : comment([
          result.text,
          result.verify ? `\n怎么验收：${result.verify}` : "",
          result.kind === "fallback" ? "\n（它没有主动交结论，这是它最后说的那段话。）" : "",
        ].filter(Boolean).join(""), "agent");
      update(withEvent(withStatus(issuesRef.current, issue.id, finished, "agent"), issue.id, note));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      update(withEvent(
        withStatus(issuesRef.current, issue.id, "ready", "agent"),
        issue.id,
        agentNote(`没能跑起来，退回待处理了：${reason}`),
      ));
      autoRef.current = false;
    }

    if (autoRef.current) void launch();
    else setRun({ phase: "idle", auto: false });
  }, [runIssue, update]);

  return {
    issues,
    loading,
    run,
    update,
    start: useCallback(() => {
      if (run.phase === "running") return;
      autoRef.current = true;
      void launch();
    }, [launch, run.phase]),
    stop: useCallback(() => {
      autoRef.current = false;
      setRun((current) => ({ ...current, auto: false }));
    }, []),
  };
}

/** 把一条任务连同它的图交给后台运行。放在这里，因为提示词就长在 issueModel 里。 */
export function requestIssueRun(input: { cwd: string; issue: Issue; parent?: Issue }): Promise<IssueRunResult> {
  return window.coilcoil.request<IssueRunResult>({
    type: "run_issue",
    cwd: input.cwd,
    issueId: input.issue.id,
    prompt: issuePrompt(input.issue, input.parent),
    images: issueImages(input.issue),
  });
}
