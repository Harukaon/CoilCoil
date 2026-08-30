import { useState } from "react";
import { ArrowLeft, ListChecks, PanelLeft, Play, Plus, Square } from "lucide-react";
import type { Issue, IssuePriority, IssueStatus } from "../../../../shared/desktop-api";
import { Select } from "../../ui/Select";
import { WindowDragBar } from "../../ui/WindowDragBar";
import { IssueDetail } from "./IssueDetail";
import {
  ISSUE_COLUMNS,
  ISSUE_PRIORITY_NAME,
  issuesInColumn,
  newIssue,
  nextRunnableIssue,
  removeIssue,
  upsertIssue,
  userNote,
  withNote,
  withStatus,
} from "./issueModel";
import type { IssueRunState } from "./useIssueBoard";
import "./issues.css";

/**
 * 工作区自带的 Issue 看板。
 *
 * 和用户在浏览器里用的那块 HTML 看板是同一套东西，只是搬进了产品里：五列、一条
 * Issue 一张卡、点开看时间线。「开始」按下去之后 agent 按优先级挨个做，一次一条。
 */
export function IssueBoard({
  workspaceName,
  issues,
  loading,
  run,
  leftOpen,
  onOpenLeft,
  onClose,
  onChange,
  onStart,
  onStop,
  onOpenSession,
}: {
  workspaceName?: string;
  issues: Issue[];
  loading: boolean;
  run: IssueRunState;
  leftOpen: boolean;
  onOpenLeft(): void;
  onClose(): void;
  onChange(next: Issue[]): void;
  onStart(): void;
  onStop(): void;
  onOpenSession(sessionPath: string): void;
}): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [dragId, setDragId] = useState<string | undefined>(undefined);
  const [dropStatus, setDropStatus] = useState<IssueStatus | undefined>(undefined);

  const open = issues.find((issue) => issue.id === openId);
  const running = issues.find((issue) => issue.id === run.issueId);
  const queued = nextRunnableIssue(issues);

  const submit = (): void => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onChange(upsertIssue(issues, newIssue(trimmed, body, priority)));
    setTitle("");
    setBody("");
  };

  return (
    <section className="issue-board" aria-labelledby="issue-board-title">
      <header className="issue-board-header">
        <WindowDragBar />
        <div>
          {!leftOpen ? (
            <button className="icon-button no-drag" type="button" aria-label="展开侧栏" onClick={onOpenLeft}>
              <PanelLeft size={17} />
            </button>
          ) : null}
          <span className="settings-icon"><ListChecks size={17} /></span>
          <div>
            <h1 id="issue-board-title">看板</h1>
            <p>{workspaceName ? `${workspaceName} 的 Issue` : "这个工作区的 Issue"}：你提，CoilCoil 挨个做，你验收。</p>
          </div>
        </div>
        <button className="settings-header-action no-drag" type="button" onClick={onClose}>
          <ArrowLeft size={14} />返回对话
        </button>
      </header>

      <div className="issue-board-toolbar">
        <form
          className="issue-new"
          onSubmit={(event) => { event.preventDefault(); submit(); }}
        >
          <input
            value={title}
            placeholder="提一条 Issue"
            aria-label="Issue 标题"
            onChange={(event) => setTitle(event.target.value)}
          />
          <input
            value={body}
            placeholder="说清楚要改成什么样（可留空）"
            aria-label="Issue 描述"
            onChange={(event) => setBody(event.target.value)}
          />
          <Select
            className="issue-select"
            value={priority}
            ariaLabel="优先级"
            options={(["high", "medium", "low"] as const).map((level) => ({ value: level, label: `优先级 ${ISSUE_PRIORITY_NAME[level]}` }))}
            onChange={(value) => setPriority(value as IssuePriority)}
          />
          <button className="issue-primary" type="submit" disabled={!title.trim()}><Plus size={13} />提交</button>
        </form>
        <div className="issue-runner">
          {run.phase === "idle" ? (
            <button className="issue-primary" type="button" disabled={!queued} onClick={onStart}>
              <Play size={13} />{queued ? "开始" : "没有待办"}
            </button>
          ) : (
            <button className="issue-secondary" type="button" onClick={onStop}>
              <Square size={12} />{run.auto ? "跑完这条就停" : "正在收尾"}
            </button>
          )}
          <small>
            {running ? `正在做：${running.title}` : queued ? `下一条：${queued.title}` : "待办空了"}
          </small>
        </div>
      </div>

      <div className="issue-columns">
        {ISSUE_COLUMNS.map((column) => {
          const cards = issuesInColumn(issues, column.status);
          return (
            <section
              key={column.status}
              className={`issue-column ${dropStatus === column.status ? "drop" : ""}`}
              onDragOver={(event) => {
                if (!dragId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropStatus(column.status);
              }}
              onDragLeave={() => setDropStatus((current) => current === column.status ? undefined : current)}
              onDrop={(event) => {
                event.preventDefault();
                const id = dragId;
                setDragId(undefined);
                setDropStatus(undefined);
                if (id) onChange(withStatus(issues, id, column.status));
              }}
            >
              <h2>{column.name}<small>{cards.length || ""}</small></h2>
              <div className="issue-column-body">
                {cards.map((issue) => (
                  <button
                    key={issue.id}
                    className={`issue-card ${issue.id === run.issueId ? "active" : ""}`}
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", issue.id);
                      setDragId(issue.id);
                    }}
                    onDragEnd={() => { setDragId(undefined); setDropStatus(undefined); }}
                    onClick={() => setOpenId(issue.id)}
                  >
                    <span className={`issue-priority ${issue.priority}`}>{ISSUE_PRIORITY_NAME[issue.priority]}</span>
                    <span className="issue-card-title">{issue.title}</span>
                    {issue.notes.length ? <small>{issue.notes.length} 条留言</small> : null}
                  </button>
                ))}
                {!cards.length ? <p className="issue-column-empty">{loading ? "读取中…" : "空"}</p> : null}
              </div>
            </section>
          );
        })}
      </div>

      {open ? (
        <IssueDetail
          issue={open}
          onClose={() => setOpenId(undefined)}
          onStatus={(status) => onChange(withStatus(issues, open.id, status))}
          onComment={(text) => onChange(withNote(issues, open.id, userNote(text)))}
          onDelete={() => { onChange(removeIssue(issues, open.id)); setOpenId(undefined); }}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </section>
  );
}
