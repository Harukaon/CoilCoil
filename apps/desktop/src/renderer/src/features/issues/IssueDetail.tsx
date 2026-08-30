import { useState } from "react";
import { Trash2, X } from "lucide-react";
import type { Issue, IssueStatus } from "../../../../shared/desktop-api";
import { Select } from "../../ui/Select";
import { ISSUE_COLUMNS, ISSUE_PRIORITY_NAME } from "./issueModel";

const WHEN = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * 一条 Issue 的详情：正文，加上你和 agent 交替的一条时间线。
 *
 * 状态在这里改，「完成」也在这里点——agent 只能把它推到待验收，最后一步是人的。
 */
export function IssueDetail({
  issue,
  onClose,
  onStatus,
  onComment,
  onDelete,
  onOpenSession,
}: {
  issue: Issue;
  onClose(): void;
  onStatus(status: IssueStatus): void;
  onComment(text: string): void;
  onDelete(): void;
  onOpenSession(sessionPath: string): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  return (
    <aside className="issue-detail" aria-label={`Issue：${issue.title}`}>
      <header>
        <div>
          <h2>{issue.title}</h2>
          <small>优先级 {ISSUE_PRIORITY_NAME[issue.priority]} · 提于 {WHEN.format(new Date(issue.createdAt))}</small>
        </div>
        <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="issue-detail-body">
        {issue.body ? <p className="issue-detail-text">{issue.body}</p> : <p className="issue-detail-empty">这条没有写描述。</p>}
        <div className="issue-detail-status">
          <span>状态</span>
          <Select
            className="issue-select"
            value={issue.status}
            ariaLabel="Issue 状态"
            options={ISSUE_COLUMNS.map((column) => ({ value: column.status, label: column.name }))}
            onChange={(value) => onStatus(value as IssueStatus)}
          />
        </div>
        {issue.sessionPath ? (
          <button className="issue-detail-session" type="button" onClick={() => onOpenSession(issue.sessionPath ?? "")}>
            打开做这条时的对话
          </button>
        ) : null}
        <ol className="issue-notes">
          {issue.notes.map((note, index) => (
            <li key={`${note.at}-${index}`} className={note.by === "agent" ? "agent" : "user"}>
              <strong>{note.by === "agent" ? "CoilCoil" : "我"}</strong>
              <time>{WHEN.format(new Date(note.at))}</time>
              <p>{note.text}</p>
            </li>
          ))}
        </ol>
      </div>
      <form
        className="issue-comment"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text) return;
          onComment(text);
          setDraft("");
        }}
      >
        <textarea
          value={draft}
          placeholder="写点什么（比如打回重做的理由）"
          aria-label="给这条 Issue 留言"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div>
          <button className="issue-delete" type="button" onClick={onDelete}><Trash2 size={13} />删除</button>
          <button className="issue-primary" type="submit" disabled={!draft.trim()}>留言</button>
        </div>
      </form>
    </aside>
  );
}
