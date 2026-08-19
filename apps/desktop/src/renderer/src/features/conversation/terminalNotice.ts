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

/**
 * Read a terminal event the workflow sent to the Agent.
 *
 * The message is written for the model — one headline followed by the tail of
 * the output — so the card takes the headline apart again rather than asking the
 * extension to send a second, UI-shaped copy.
 */
export function parseTerminalNotice(message: ChatMessage): TerminalNotice | undefined {
  if (message.custom?.type !== TERMINAL_NOTIFICATION_TYPE) return undefined;
  const details = message.custom.details;
  const [headline = "", ...rest] = message.text.split("\n");
  const headlineMatch = /^Terminal\s+(\S+?)[：:]\s*(.*)$/.exec(headline.trim());
  const terminalId = stringField(details, "terminalId") ?? headlineMatch?.[1] ?? "terminal";
  const reason = headlineMatch?.[2]?.trim() || headline.trim();
  const mode = stringField(details, "mode");
  return {
    terminalId,
    mode: mode === "exit" || mode === "match" || mode === "regex" || mode === "stalled" ? mode : undefined,
    status: stringField(details, "status"),
    reason,
    output: rest.join("\n").trim(),
  };
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
