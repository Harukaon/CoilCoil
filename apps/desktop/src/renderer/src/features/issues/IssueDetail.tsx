import { useState } from "react";
import { CornerDownRight, Plus, Trash2, X } from "lucide-react";
import type { PromptImage } from "@coilcoil/runtime-protocol";
import type { Issue, IssueStatus } from "../../../../shared/desktop-api";
import { Select } from "../../ui/Select";
import { IssueImagePicker, IssueImageStrip, imageDropHandlers } from "./IssueImages";
import { IssueTimeline, ISSUE_TIME_FORMAT } from "./IssueTimeline";
import { ISSUE_COLUMNS, ISSUE_PRIORITY_NAME, childrenOf } from "./issueModel";

/**
 * 一条 Issue 的详情：正文、子任务、一条按时间排的经过。
 *
 * 状态在这里改，「完成」也在这里点——它自己只会把一条推到待验收，最后一步是人的。
 */
export function IssueDetail({
  issue,
  issues,
  onClose,
  onOpen,
  onStatus,
  onDefer,
  onComment,
  onAddChild,
  onDelete,
  onOpenSession,
}: {
  issue: Issue;
  issues: Issue[];
  onClose(): void;
  onOpen(id: string): void;
  onStatus(status: IssueStatus): void;
  onDefer(deferred: boolean): void;
  onComment(text: string, images: PromptImage[]): void;
  onAddChild(title: string): void;
  onDelete(): void;
  onOpenSession(sessionPath: string): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<PromptImage[]>([]);
  const [childTitle, setChildTitle] = useState("");
  const parent = issue.parentId ? issues.find((item) => item.id === issue.parentId) : undefined;
  const children = childrenOf(issues, issue.id);
  return (
    <aside className="issue-detail" aria-label={`任务：${issue.title}`}>
      <header>
        <div>
          {parent ? (
            <button className="issue-parent-link" type="button" onClick={() => onOpen(parent.id)}>
              <CornerDownRight size={11} />{parent.title}
            </button>
          ) : null}
          <h2>{issue.title}</h2>
          <small>优先级 {ISSUE_PRIORITY_NAME[issue.priority]} · 提于 {ISSUE_TIME_FORMAT.format(new Date(issue.createdAt))}</small>
        </div>
        <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={16} /></button>
      </header>

      <div className="issue-detail-body">
        {issue.body ? <p className="issue-detail-text">{issue.body}</p> : <p className="issue-detail-empty">这条没有写描述。</p>}
        <IssueImageStrip images={issue.images ?? []} />

        <div className="issue-detail-status">
          <span>状态</span>
          <Select
            className="issue-select"
            value={issue.status}
            ariaLabel="任务状态"
            options={ISSUE_COLUMNS.map((column) => ({ value: column.status, label: column.name, detail: column.hint }))}
            onChange={(value) => onStatus(value as IssueStatus)}
          />
        </div>
        {issue.status === "review" ? (
          <label className="issue-defer">
            <input type="checkbox" checked={Boolean(issue.deferred)} onChange={(event) => onDefer(event.target.checked)} />
            以后再验收（留在这一列，但批阅时先跳过它）
          </label>
        ) : null}
        {issue.sessionPath ? (
          <button className="issue-detail-session" type="button" onClick={() => onOpenSession(issue.sessionPath ?? "")}>
            打开做这条时的对话
          </button>
        ) : null}

        <section className="issue-children">
          <h3>子任务{children.length ? <small>{children.length}</small> : null}</h3>
          {children.map((child) => (
            <button key={child.id} className="issue-child" type="button" onClick={() => onOpen(child.id)}>
              <span className={`issue-priority ${child.priority}`}>{ISSUE_PRIORITY_NAME[child.priority]}</span>
              <span>{child.title}</span>
              <small>{ISSUE_COLUMNS.find((column) => column.status === child.status)?.name}</small>
            </button>
          ))}
          <form
            className="issue-child-new"
            onSubmit={(event) => {
              event.preventDefault();
              const text = childTitle.trim();
              if (!text) return;
              onAddChild(text);
              setChildTitle("");
            }}
          >
            <input
              value={childTitle}
              placeholder="拆一条子任务"
              aria-label="子任务标题"
              onChange={(event) => setChildTitle(event.target.value)}
            />
            <button className="issue-secondary" type="submit" disabled={!childTitle.trim()}><Plus size={12} />拆分</button>
          </form>
        </section>

        <IssueTimeline issue={issue} />
      </div>

      <form
        className="issue-comment"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          // 只贴张图不写字也算一条留言——很多时候截图就是全部要说的话。
          if (!text && !draftImages.length) return;
          onComment(text, draftImages);
          setDraft("");
          setDraftImages([]);
        }}
        {...imageDropHandlers((next) => setDraftImages((current) => [...current, ...next]))}
      >
        <textarea
          value={draft}
          placeholder={issue.status === "reply" ? "回复它（回复完这条会自动回到待处理）" : "写点什么，截图可以直接粘进来"}
          aria-label="给这条任务留言"
          onChange={(event) => setDraft(event.target.value)}
        />
        {draftImages.length ? <IssueImagePicker images={draftImages} onChange={setDraftImages} /> : null}
        <div>
          <button className="issue-delete" type="button" onClick={onDelete}><Trash2 size={13} />删除</button>
          <button className="issue-primary" type="submit" disabled={!draft.trim() && !draftImages.length}>留言</button>
        </div>
      </form>
    </aside>
  );
}
