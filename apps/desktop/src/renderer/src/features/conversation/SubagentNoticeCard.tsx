import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  subagentCompletionLabel,
  subagentCompletionMeta,
  type SubagentCompletionNotice,
} from "./subagentNotice";

/**
 * 后台子 Agent 跑完的通知：一张卡片，而不是一整段报告。
 *
 * 和终端通知同一套样式。报告默认收起，点开才看；runId、会话文件这些给模型用的
 * 内部信息不展示。`report` 由时间线用它自己的 Markdown 渲染好了再传进来。
 */
export function SubagentNoticeCard({ notice, report }: { notice: SubagentCompletionNotice; report?: ReactNode }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const status = notice.status === "completed" ? "succeeded" : notice.status;
  const meta = subagentCompletionMeta(notice);
  return (
    <section className={`terminal-notice subagent-notice status-${status}`}>
      <div className="terminal-notice-head">
        <span className="terminal-notice-icon" aria-hidden="true"><Bot size={14} /></span>
        <span className="terminal-notice-copy">
          <strong>子 Agent {notice.agent} {subagentCompletionLabel(notice.status)}</strong>
          {notice.task ? <small title={notice.task}>{notice.task}</small> : null}
        </span>
        {meta ? <span className="terminal-notice-status">{meta}</span> : null}
        {notice.report ? (
          <button
            className="terminal-notice-toggle"
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "收起子 Agent 报告" : "查看子 Agent 报告"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>{expanded ? "收起报告" : "查看报告"}</span>
          </button>
        ) : null}
      </div>
      {notice.error ? <div className="subagent-notice-error">{notice.error}</div> : null}
      {expanded && notice.report ? <div className="subagent-notice-report">{report}</div> : null}
    </section>
  );
}
