import { ChevronDown, ChevronRight, TerminalSquare } from "lucide-react";
import { useState } from "react";
import type { ChatMessage } from "@suocode/runtime-protocol";
import {
  parseTerminalNotices,
  terminalNoticeLabel,
  terminalNoticePreview,
  type TerminalNotice,
} from "./terminalNotice";

function TerminalNoticeRow({ notice }: { notice: TerminalNotice }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const preview = terminalNoticePreview(notice.output);
  const lineCount = notice.output ? notice.output.split("\n").length : 0;
  return (
    <section className={`terminal-notice status-${notice.status ?? "unknown"}`}>
      <div className="terminal-notice-head">
        <span className="terminal-notice-icon" aria-hidden="true"><TerminalSquare size={14} /></span>
        <span className="terminal-notice-copy">
          <strong>终端 {notice.terminalId}</strong>
          <small>{notice.reason}</small>
        </span>
        <span className="terminal-notice-status">{terminalNoticeLabel(notice)}</span>
        {notice.output ? (
          <button
            className="terminal-notice-toggle"
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "收起终端输出" : `展开终端输出，共 ${lineCount} 行`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>{expanded ? "收起输出" : `输出 ${lineCount} 行`}</span>
          </button>
        ) : null}
      </div>
      {notice.output ? (
        expanded
          ? <pre className="terminal-notice-output">{notice.output}</pre>
          : preview ? <div className="terminal-notice-preview" title={preview}>{preview}</div> : null
      ) : null}
    </section>
  );
}

/**
 * Terminal events as cards instead of a wall of text.
 *
 * One message can carry several terminals, because the workflow batches a burst
 * of events into a single wake-up for the Agent; each still gets its own card.
 */
export function TerminalNoticeCard({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const notices = parseTerminalNotices(message);
  if (notices.length === 0) return null;
  if (notices.length === 1 && notices[0]) return <TerminalNoticeRow notice={notices[0]} />;
  return (
    <div className="terminal-notice-batch">
      {notices.map((notice, index) => (
        <TerminalNoticeRow key={`${notice.terminalId}-${notice.mode ?? "event"}-${index}`} notice={notice} />
      ))}
    </div>
  );
}
