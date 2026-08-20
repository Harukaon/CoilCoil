import type { ChatMessage } from "@suocode/runtime-protocol";

export const TERMINAL_NOTIFICATION_TYPE = "terminal-notification";

export type TerminalNoticeMode = "exit" | "match" | "regex" | "stalled";

export interface TerminalNotice {
  terminalId: string;
  mode?: TerminalNoticeMode;
  status?: string;
  /** The one-line reason, without the `Terminal <id>：` prefix. */
  reason: string;
  /** Everything the terminal printed after the headline. */
  output: string;
}

function stringField(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMode(value: string | undefined): TerminalNoticeMode | undefined {
  return value === "exit" || value === "match" || value === "regex" || value === "stalled" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** One entry of the `notices` array the workflow attaches to a batched event. */
function readBatchedNotice(value: unknown): TerminalNotice | undefined {
  if (!isRecord(value)) return undefined;
  const terminalId = stringField(value, "terminalId");
  const reason = stringField(value, "reason");
  if (!terminalId || !reason) return undefined;
  const output = value.output;
  return {
    terminalId,
    mode: readMode(stringField(value, "mode")),
    status: stringField(value, "status"),
    reason,
    output: typeof output === "string" ? output.trim() : "",
  };
}

/**
 * Read the terminal events the workflow sent to the Agent.
 *
 * One message can carry several terminals: the workflow batches everything that
 * fired inside one window so a burst of background exits costs the Agent a
 * single turn. `details.notices` is the structured copy of that batch; the text
 * body is written for the model, so a message from before batching existed is
 * still recovered by taking its headline apart.
 */
export function parseTerminalNotices(message: ChatMessage): TerminalNotice[] {
  if (message.custom?.type !== TERMINAL_NOTIFICATION_TYPE) return [];
  const details = message.custom.details;
  const batched = details?.notices;
  if (Array.isArray(batched)) {
    const notices = batched.map(readBatchedNotice).filter((notice): notice is TerminalNotice => notice !== undefined);
    if (notices.length > 0) return notices;
  }
  const [headline = "", ...rest] = message.text.split("\n");
  const headlineMatch = /^Terminal\s+(\S+?)[：:]\s*(.*)$/.exec(headline.trim());
  const terminalId = stringField(details, "terminalId") ?? headlineMatch?.[1] ?? "terminal";
  const reason = headlineMatch?.[2]?.trim() || headline.trim();
  return [{
    terminalId,
    mode: readMode(stringField(details, "mode")),
    status: stringField(details, "status"),
    reason,
    output: rest.join("\n").trim(),
  }];
}

/** The first event in a message; a batch carries more, read them with `parseTerminalNotices`. */
export function parseTerminalNotice(message: ChatMessage): TerminalNotice | undefined {
  return parseTerminalNotices(message)[0];
}

/** Short label for the status pill; falls back to the mode when Pi sent no status. */
export function terminalNoticeLabel(notice: TerminalNotice): string {
  if (notice.status === "running") return notice.mode === "stalled" ? "无新输出" : "运行中";
  if (notice.status === "exited") return "已退出";
  if (notice.status === "stopped") return "已停止";
  if (notice.status === "failed") return "失败";
  if (notice.mode === "match" || notice.mode === "regex") return "已匹配";
  return "终端事件";
}

/** The last line worth showing when the output stays collapsed. */
export function terminalNoticePreview(output: string): string {
  const lines = output.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  return lines.at(-1) ?? "";
}
