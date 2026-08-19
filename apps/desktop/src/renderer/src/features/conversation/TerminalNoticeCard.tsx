import { ChevronDown, ChevronRight, TerminalSquare } from "lucide-react";
import { useState } from "react";
import type { ChatMessage } from "@suocode/runtime-protocol";
import {
  parseTerminalNotice,
  terminalNoticeLabel,
  terminalNoticePreview,
} from "./terminalNotice";

/**
 * A terminal event as a card instead of a wall of text.
 *
 * The Agent still receives the full message; this only changes how the same
 * event reads in the transcript.
 */
export function TerminalNoticeCard({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const notice = parseTerminalNotice(message);
  if (!notice) return null;
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
