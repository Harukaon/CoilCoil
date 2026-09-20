import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ClipboardCheck, Columns3, ListChecks, Play, Plus, Rows3, Square } from "lucide-react";
import type { Issue, IssueStatus } from "../../../../shared/desktop-api";
import { WindowDragBar } from "../../ui/WindowDragBar";
import { IssueCompose } from "./IssueCompose";
import { IssueDetail } from "./IssueDetail";
import { IssueReview } from "./IssueReview";
import { IssueTable } from "./IssueTable";
import {
  ISSUE_COLUMNS,
  ISSUE_PRIORITY_NAME,
  childrenOf,
  issuesInColumn,
  newIssue,
  nextRunnableIssue,
  rejectIssue,
  removeIssue,
  reviewQueue,
  upsertIssue,
  withComment,
  withDeferred,
  withStatus,
  type IssueSortKey,
} from "./issueModel";
import type { IssueRunState } from "./useIssueBoard";
import "./issues.css";

export type IssueView = "board" | "table";

const VIEW_STORAGE_KEY = "coilcoil.issues.view";

/** 上次用的是哪种视图。读不到就按看板——那是这块面板的默认样子。 */
function loadIssueView(): IssueView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "table" ? "table" : "board";
  } catch {
    return "board";
  }
}

function saveIssueView(view: IssueView): void {
  try { window.localStorage.setItem(VIEW_STORAGE_KEY, view); } catch { /* 隐私模式下写不进去，不值得为它报错 */ }
}

/**
 * 工作区自带的任务面板。
 *
 * 六列加一个「打回重做」的动作，流转是用户定的：想法先落在待办池，要做了才推进
 * 待处理，「开始」只从待处理里挑。完成默认不显示——面板要看的是还没了结的事。
 */
export function IssueBoard({
  workspaceName,
  issues,
  loading,
  run,
  layoutPending,
  onClose,
  onChange,
  onStart,
  onStop,
}: {
  workspaceName?: string;
  issues: Issue[];
  loading: boolean;
  run: IssueRunState;
  layoutPending: boolean;
  onClose(): void;
  onChange(next: Issue[]): void;
  onStart(): void;
  onStop(): void;
}): React.JSX.Element {
  const [composing, setComposing] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [dragId, setDragId] = useState<string | undefined>(undefined);
  const [dropStatus, setDropStatus] = useState<IssueStatus | undefined>(undefined);
  const [reviewing, setReviewing] = useState(false);
  const [view, setView] = useState<IssueView>(loadIssueView);
  const [sortKey, setSortKey] = useState<IssueSortKey>("priority");
  const [ascending, setAscending] = useState(true);
  /* 进面板时自动摆开批阅，但只自动一次：关掉之后不该一回头又弹出来。 */
  const [autoOpened, setAutoOpened] = useState(false);

  const open = issues.find((issue) => issue.id === openId);
  const running = issues.find((issue) => issue.id === run.issueId);
  const queued = nextRunnableIssue(issues);
  const queue = useMemo(() => reviewQueue(issues), [issues]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return issues;
    return issues.filter((issue) => `${issue.title} ${issue.body}`.toLowerCase().includes(needle));
  }, [issues, query]);

  useEffect(() => {
    if (autoOpened || loading || !queue.length) return;
    setAutoOpened(true);
    setReviewing(true);
  }, [autoOpened, loading, queue.length]);

  const columns = ISSUE_COLUMNS.filter((column) => column.status !== "done" || showDone);
  const rows = useMemo(
    () => showDone ? visible : visible.filter((issue) => issue.status !== "done"),
    [showDone, visible]);

  const changeView = (next: IssueView): void => {
    setView(next);
    saveIssueView(next);
  };

  return (
    <section className="shell-surface issue-board" style={{ visibility: layoutPending ? "hidden" : undefined }} aria-labelledby="issue-board-title">
      <header className="issue-board-header window-drag-bar">
        <WindowDragBar />
        <div>
          <span className="settings-icon"><ListChecks size={17} /></span>
          <div>
            <h1 id="issue-board-title">任务</h1>
            <p>{workspaceName ? `${workspaceName}：` : ""}你提，CoilCoil 挨个做，你批。</p>
          </div>
        </div>
        <div className="issue-board-header-actions no-drag">
          {queue.length ? (
            <button className="issue-primary" type="button" onClick={() => setReviewing(true)}>
              <ClipboardCheck size={13} />批阅 {queue.length} 条
            </button>
          ) : null}
          <button className="settings-header-action" type="button" onClick={onClose}>
            <ArrowLeft size={14} />返回对话
          </button>
        </div>
      </header>

      <div className="issue-board-toolbar">
        <button className="issue-primary" type="button" onClick={() => setComposing(true)}>
          <Plus size={13} />提一条任务
        </button>
        <div className="issue-runner">
          {run.phase === "idle" ? (
            <button className="issue-primary" type="button" disabled={!queued} onClick={onStart}>
              <Play size={13} />{queued ? "开始" : "没有待处理"}
            </button>
          ) : (
            <button className="issue-secondary" type="button" onClick={onStop}>
              <Square size={12} />{run.auto ? "跑完这条就停" : "正在收尾"}
            </button>
          )}
          <small>{running ? `正在做：${running.title}` : queued ? `下一条：${queued.title}` : "待处理空了"}</small>
        </div>
      </div>

      <div className="issue-board-filters">
        <input type="text" value={query} placeholder="搜索标题和描述" aria-label="搜索任务" onChange={(event) => setQuery(event.target.value)} />
        <label>
          <input type="checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} />
          显示已完成
        </label>
        <div className="issue-view-switch" role="group" aria-label="视图">
          <button className={view === "board" ? "active" : ""} type="button" onClick={() => changeView("board")}>
            <Columns3 size={13} />看板
          </button>
          <button className={view === "table" ? "active" : ""} type="button" onClick={() => changeView("table")}>
            <Rows3 size={13} />表格
          </button>
        </div>
      </div>

      {view === "table" ? (
        <IssueTable
          issues={rows}
          runningId={run.issueId}
          sortKey={sortKey}
          ascending={ascending}
          onSort={(key) => {
            // 点同一列是掉头，点别的列从正序开始——不然换列时方向莫名其妙。
            if (key === sortKey) setAscending((current) => !current);
            else { setSortKey(key); setAscending(true); }
          }}
          onOpen={setOpenId}
        />
      ) : (
      <div className={`issue-columns ${showDone ? "with-done" : ""}`}>
        {columns.map((column) => {
          const cards = issuesInColumn(visible, column.status);
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
              <h2 title={column.hint}>{column.name}<small>{cards.length || ""}</small></h2>
              <div className="issue-column-body">
                {cards.map((issue) => {
                  const children = childrenOf(issues, issue.id);
                  return (
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
                      <span className="issue-card-head">
                        <span className={`issue-priority ${issue.priority}`}>{ISSUE_PRIORITY_NAME[issue.priority]}</span>
                        {issue.parentId ? <span className="issue-tag">子任务</span> : null}
                        {issue.deferred ? <span className="issue-tag defer">以后再看</span> : null}
                      </span>
                      <span className="issue-card-title">{issue.title}</span>
                      {children.length || issue.events.length ? (
                        <small>
                          {children.length ? `${children.length} 条子任务` : ""}
                          {children.length && issue.events.length ? " · " : ""}
                          {issue.events.length ? `${issue.events.length} 条记录` : ""}
                        </small>
                      ) : null}
                    </button>
                  );
                })}
                {!cards.length ? <p className="issue-column-empty">{loading ? "读取中…" : column.status === "pool" ? "想到什么先记这儿" : "空"}</p> : null}
              </div>
            </section>
          );
        })}
      </div>
      )}

      {open ? (
        <IssueDetail
          issue={open}
          issues={issues}
          onClose={() => setOpenId(undefined)}
          onOpen={setOpenId}
          onStatus={(status) => onChange(withStatus(issues, open.id, status))}
          onDefer={(deferred) => onChange(withDeferred(issues, open.id, deferred))}
          onComment={(text, images) => onChange(withComment(issues, open.id, text, images))}
          onAddChild={(childTitle) => onChange(upsertIssue(issues, newIssue(childTitle, "", open.priority, { parentId: open.id })))}
          onDelete={() => { onChange(removeIssue(issues, open.id)); setOpenId(undefined); }}
        />
      ) : null}

      {composing ? (
        <IssueCompose
          onClose={() => setComposing(false)}
          onSubmit={(draft) => onChange(upsertIssue(
            issues,
            newIssue(draft.title, draft.body, draft.priority, { status: "ready", images: draft.images }),
          ))}
        />
      ) : null}

      {reviewing ? (
        <IssueReview
          queue={queue}
          onApprove={(issue) => onChange(withStatus(issues, issue.id, "done"))}
          onReject={(issue, reason, images) => onChange(rejectIssue(issues, issue.id, reason, images))}
          onReply={(issue, text, images) => onChange(withComment(issues, issue.id, text, images))}
          onDefer={(issue) => onChange(withDeferred(issues, issue.id, true))}
          onClose={() => setReviewing(false)}
        />
      ) : null}
    </section>
  );
}
