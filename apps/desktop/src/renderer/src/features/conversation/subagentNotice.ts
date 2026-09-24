import type { ChatMessage } from "@coilcoil/runtime-protocol";

/**
 * 后台子 Agent 跑完时插进主会话的那条通知（workflow 的 subagents.ts，notifyParent）。
 *
 * 它的正文是写给模型看的：报告全文、runId、会话文件路径都在里面，模型要靠它们接着
 * 干活。原样铺在聊天里，用户看到的就是一大段内部信息。所以界面不读正文，只读它带的
 * details，画成一张卡片；报告默认收起。
 */
export const SUBAGENT_COMPLETE_TYPE = "subagent-complete";

export interface SubagentCompletionNotice {
  agent: string;
  status: string;
  task?: string;
  report?: string;
  error?: string;
  toolCount?: number;
  durationMs?: number;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseSubagentCompletion(message: ChatMessage): SubagentCompletionNotice | undefined {
  if (message.custom?.type !== SUBAGENT_COMPLETE_TYPE) return undefined;
  const details = message.custom.details ?? {};
  return {
    agent: text(details.agent) ?? "子 Agent",
    status: text(details.status) ?? "completed",
    task: text(details.task),
    report: text(details.finalOutput),
    error: text(details.error),
    toolCount: count(details.toolCount),
    durationMs: count(details.durationMs),
  };
}

export function subagentCompletionLabel(status: string): string {
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "stopped") return "已停止";
  return status;
}

export function subagentCompletionMeta(notice: SubagentCompletionNotice): string {
  const parts: string[] = [];
  if (notice.toolCount !== undefined) parts.push(`${notice.toolCount} 次工具`);
  if (notice.durationMs !== undefined) {
    const seconds = Math.round(notice.durationMs / 1000);
    parts.push(seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`);
  }
  return parts.join(" · ");
}
