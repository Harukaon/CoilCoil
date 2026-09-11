import type {
  ChatMessage,
  ContextClearingRecord,
  RuntimeSummaryEvent,
} from "@coilcoil/runtime-protocol";

/**
 * Where the transcript says its own context was compacted.
 *
 * Compaction happens twice over, both times invisibly: first the bodies of old
 * tool results are dropped, then — if that is not enough — everything past the
 * recent window becomes one paragraph of prose. Both change what the model can
 * still see, and until now neither left any trace in the conversation, so a
 * long wait and a suddenly forgetful assistant had no visible cause.
 *
 * These marks are drawn from data the session already carries: Pi records its
 * own compactions in the session file, and the clearing extension announces its
 * batches. Nothing here costs a model call, which is the point — an explanation
 * of compaction that itself needed a request would be the wrong trade.
 */

export type CompactionLayer = 1 | 2;

export interface CompactionMark {
  id: string;
  /** 1 = tool outputs dropped; 2 = history summarized into prose. */
  layer: CompactionLayer;
  /** Sorts into the transcript between the message before and the one after. */
  order: number;
  at: number;
  status: "running" | "done" | "failed";
  /** Layer 1 only. */
  clearedResults?: number;
  freedTokens?: number;
  /** How many clearing passes this one rule stands for. */
  passes?: number;
  /**
   * Layer 2 only: whether the rule really sits at the cut point.
   *
   * False when the kept entry could not be found among the messages, in which
   * case the rule is placed by time and says nothing about "above the line".
   */
  atCutPoint?: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
}

/** Half a step before a message, so the mark lands between two turns. */
const BEFORE = 0.5;

/**
 * The order a mark should take to sit immediately before `anchor`.
 *
 * Messages are ordered by a monotonic counter rather than by time, so a mark is
 * placed relative to a message rather than at its timestamp; the fallback for a
 * mark with no message after it is the end of the transcript.
 */
function orderBefore(messages: readonly ChatMessage[], anchor: ChatMessage | undefined): number {
  if (anchor) return anchor.order - BEFORE;
  const last = messages.at(-1);
  return last ? last.order + BEFORE : 0;
}

/** The first message at or after a moment in time. */
function firstMessageAfter(messages: readonly ChatMessage[], at: number): ChatMessage | undefined {
  return messages.find((message) => message.timestamp >= at);
}

function summaryStatus(status: RuntimeSummaryEvent["status"]): CompactionMark["status"] {
  if (status === "running") return "running";
  return status === "succeeded" ? "done" : "failed";
}

export function buildCompactionMarks(
  messages: readonly ChatMessage[],
  summaryEvents: readonly RuntimeSummaryEvent[] = [],
  clearings: readonly ContextClearingRecord[] = [],
): CompactionMark[] {
  const marks: CompactionMark[] = [];

  for (const event of summaryEvents) {
    // Only compactions of the branch being shown. A summary from an abandoned
    // branch describes messages this transcript never contained.
    if (event.kind !== "compaction" || !event.active) continue;
    const kept = event.firstKeptEntryId
      ? messages.find((message) => message.entryId === event.firstKeptEntryId)
      : undefined;
    const anchor = kept ?? firstMessageAfter(messages, event.timestamp);
    marks.push({
      id: event.id,
      layer: 2,
      order: orderBefore(messages, anchor),
      at: event.timestamp,
      status: summaryStatus(event.status),
      atCutPoint: Boolean(kept),
      tokensBefore: event.tokensBefore,
      tokensAfter: event.estimatedTokensAfter,
      summary: event.summary,
    });
  }

  for (const clearing of clearings) {
    marks.push({
      id: `clearing:${clearing.at}`,
      layer: 1,
      order: orderBefore(messages, firstMessageAfter(messages, clearing.at)),
      at: clearing.at,
      status: "done",
      clearedResults: clearing.clearedResults,
      freedTokens: clearing.freedTokens,
    });
  }

  marks.sort((left, right) => left.order - right.order || left.at - right.at);

  // Several clearings can land between the same two messages. Drawing a rule for
  // each turns a long session into a ladder of near-identical lines, so they
  // become one line that says how many passes it took.
  const merged: CompactionMark[] = [];
  for (const mark of marks) {
    const previous = merged.at(-1);
    if (previous && previous.layer === 1 && mark.layer === 1 && previous.order === mark.order) {
      previous.clearedResults = (previous.clearedResults ?? 0) + (mark.clearedResults ?? 0);
      previous.freedTokens = (previous.freedTokens ?? 0) + (mark.freedTokens ?? 0);
      previous.passes = (previous.passes ?? 1) + 1;
      previous.at = mark.at;
      continue;
    }
    merged.push({ ...mark });
  }
  return merged;
}

/** The words in the middle of the rule. Short enough to read without stopping. */
export function compactionMarkLabel(mark: CompactionMark): string {
  if (mark.status === "running") return "正在整理上下文…";
  if (mark.status === "failed") return "上下文整理失败";
  if (mark.layer === 1) return `已清理 ${mark.clearedResults ?? 0} 条工具记录`;
  return "上下文已压缩";
}

/** Enough of the summary to tell what the model kept, without pasting it all back. */
export const COMPACTION_SUMMARY_PREVIEW_CHARS = 460;

export function compactionSummaryPreview(summary: string | undefined): string | undefined {
  const text = summary?.trim();
  if (!text) return undefined;
  const characters = Array.from(text);
  return characters.length > COMPACTION_SUMMARY_PREVIEW_CHARS
    ? `${characters.slice(0, COMPACTION_SUMMARY_PREVIEW_CHARS).join("")}…`
    : text;
}

/**
 * The sentence under the rule, explaining what this stage actually did.
 *
 * Written from numbers already in hand. The point is that someone reading it
 * understands which of the two stages ran and what it cost them, not that they
 * get a report.
 */
export function compactionMarkDetail(mark: CompactionMark): string {
  if (mark.layer === 1) {
    const freed = mark.freedTokens ? `，约省下 ${mark.freedTokens.toLocaleString()} tokens` : "";
    const passes = (mark.passes ?? 1) > 1 ? `（分 ${mark.passes} 次）` : "";
    return `上面较早的 ${mark.clearedResults ?? 0} 条工具调用，内容已从模型的上下文里移除${passes}${freed}。调过哪些工具还看得见，需要内容时模型会重新读一次。`;
  }
  const before = mark.tokensBefore?.toLocaleString();
  const after = mark.tokensAfter?.toLocaleString();
  const change = before && after ? `上下文从约 ${before} tokens 压到约 ${after} tokens。` : "";
  // 「以上」这两个字只有当线确实落在切分点上才成立。落不上去的时候（保留的第一条
  // 是一条不显示的元数据，找不到对应消息），线是按时间放的，就不能声称它上面的都
  // 被折叠了——最近那几万 token 的原文其实照常发给模型。
  const scope = mark.atCutPoint
    ? "这条线以上的对话已折叠成一段摘要发给模型，线以下的原文照常。"
    : "较早的对话已折叠成一段摘要发给模型，最近的原文照常。";
  return `${change}${scope}原文都还在会话文件里，往上翻看得到。`.trim();
}
