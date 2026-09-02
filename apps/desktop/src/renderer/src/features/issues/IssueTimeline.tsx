import type { Issue, IssueEvent } from "../../../../shared/desktop-api";
import { IssueImageStrip } from "./IssueImages";

const WHEN = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const KIND_LABEL: Record<IssueEvent["kind"], string> = {
  comment: "",
  note: "",
  status: "状态",
  commit: "提交",
};

/**
 * 一条 Issue 的经过，按时间排成一条线。
 *
 * 你的话、它的话、状态变动、提交，全在同一条线上按时间先后排——用户要的就是这个，
 * 不是「AI 一摞、我一摞」并列着看。排序在存盘时就做掉了（见 workspace-issues），
 * 这里只负责画。
 */
export function IssueTimeline({ issue, limit }: { issue: Issue; limit?: number }): React.JSX.Element {
  const events = limit ? issue.events.slice(-limit) : issue.events;
  if (!events.length) return <p className="issue-timeline-empty">还没有记录。</p>;
  return (
    <ol className="issue-timeline">
      {events.map((event, index) => (
        <li key={`${event.at}-${index}`} className={`${event.by} ${event.kind}`}>
          <strong>{event.by === "agent" ? "CoilCoil" : "我"}</strong>
          {KIND_LABEL[event.kind] ? <em>{KIND_LABEL[event.kind]}</em> : null}
          <time>{WHEN.format(new Date(event.at))}</time>
          <p>{event.text}{event.ref ? ` · ${event.ref}` : ""}</p>
          {event.images?.length ? <IssueImageStrip images={event.images} /> : null}
        </li>
      ))}
    </ol>
  );
}

export { WHEN as ISSUE_TIME_FORMAT };
