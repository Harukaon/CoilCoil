import { useEffect, useState } from "react";
import { Check, Clock, RotateCcw, SkipForward, X } from "lucide-react";
import type { Issue } from "../../../../shared/desktop-api";
import { IssueTimeline } from "./IssueTimeline";
import { ISSUE_PRIORITY_NAME } from "./issueModel";

/**
 * 批阅：等你处理的那些，一次只摆一条在你面前，处理完自动上下一条。
 *
 * 用户要的就是这个感觉——「类似于批阅奏折一样，每次显示一个，批阅完毕后再显示
 * 下一个」。所以它是全屏的、没有别的东西可看，而且三条出口都留着：处理掉、
 * 跳过（这次先不看）、直接关掉回到面板。
 *
 * 待回复的排在前面，因为那是卡着它继续往下做的；待验收只是等你过目。
 */
export function IssueReview({
  queue,
  onApprove,
  onReject,
  onReply,
  onDefer,
  onClose,
}: {
  queue: Issue[];
  onApprove(issue: Issue): void;
  onReject(issue: Issue, reason: string): void;
  onReply(issue: Issue, text: string): void;
  onDefer(issue: Issue): void;
  onClose(): void;
}): React.JSX.Element | null {
  const [skipped, setSkipped] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const pending = queue.filter((issue) => !skipped.includes(issue.id));
  const issue = pending[0];

  // 换到下一条时把上一条写了一半的话清掉，免得它跟着落到别人头上。
  useEffect(() => { setDraft(""); }, [issue?.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!issue) return null;
  const waitingReply = issue.status === "reply";
  const done = queue.length - pending.length;

  return (
    <div className="issue-review" role="dialog" aria-modal="true" aria-label="批阅">
      <header>
        <div>
          <span className={`issue-priority ${issue.priority}`}>{ISSUE_PRIORITY_NAME[issue.priority]}</span>
          <strong>{waitingReply ? "它在等你拿个主意" : "做完了，等你验收"}</strong>
          <small>还剩 {pending.length} 条{done ? ` · 已跳过 ${done} 条` : ""}</small>
        </div>
        <button className="icon-button" type="button" aria-label="关闭批阅" onClick={onClose}><X size={17} /></button>
      </header>

      <div className="issue-review-body">
        <h1>{issue.title}</h1>
        {issue.body ? <p className="issue-review-text">{issue.body}</p> : null}
        <IssueTimeline issue={issue} limit={8} />
      </div>

      <footer>
        <textarea
          value={draft}
          placeholder={waitingReply ? "写下你的决定，它会接着做" : "打回重做的话，在这里写清楚哪里不对"}
          aria-label={waitingReply ? "回复" : "打回理由"}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="issue-review-actions">
          <button className="issue-ghost" type="button" onClick={() => setSkipped((current) => [...current, issue.id])}>
            <SkipForward size={13} />跳过
          </button>
          {waitingReply ? (
            <button className="issue-primary" type="button" disabled={!draft.trim()} onClick={() => onReply(issue, draft)}>
              <Check size={13} />回复并继续
            </button>
          ) : (
            <>
              <button className="issue-ghost" type="button" onClick={() => onDefer(issue)}>
                <Clock size={13} />以后再验收
              </button>
              <button className="issue-secondary" type="button" onClick={() => onReject(issue, draft)}>
                <RotateCcw size={13} />打回重做
              </button>
              <button className="issue-primary" type="button" onClick={() => onApprove(issue)}>
                <Check size={13} />通过
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
