import type {
  ChatMessage,
  ContextClearingRecord,
  RuntimeSummaryEvent,
  ToolRun,
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
  /**
   * Why a failed compaction failed.
   *
   * The runtime has always had this — it logs the text and flashes it in a
   * toast — but the rule, which is the part that stays on screen, said only
   * 「上下文整理失败」. 「失败为啥我看不到报错？」. A failure that leaves no
   * reason behind is the one kind of failure the user cannot act on.
   */
  error?: string;
  /** Which of Pi's own retries is in flight, while one is. */
  retryAttempt?: number;
  retryMaxAttempts?: number;
}

/** Half a step before an entry, so the mark lands between two of them. */
const BEFORE = 0.5;

/**
 * One place in the transcript: what its counter says, and when it happened.
 *
 * Messages and tool runs share a single counter, and a mark has to be placed
 * against both. Placing it against messages alone is what put a command *below*
 * a compaction that was still running — the model cannot be running anything
 * while its context is being summarized, and it was not: the command had run
 * before, and the rule landed on top of it because the last message was older
 * still. 「怎么可能会有模型继续在运行命令呢」.
 */
interface Anchor { order: number; timestamp: number }

/** Everything a mark can be placed against, in transcript order. */
export function timelineAnchors(
  messages: readonly ChatMessage[],
  tools: readonly ToolRun[] = [],
): Anchor[] {
  const anchors: Anchor[] = [
    ...messages.map((message) => ({ order: message.order, timestamp: message.timestamp })),
    ...tools.map((tool) => ({ order: tool.order, timestamp: tool.startedAt })),
  ];
  return anchors.sort((left, right) => left.order - right.order);
}

/**
 * The order a mark should take to sit immediately before `anchor`.
 *
 * Entries are ordered by a monotonic counter rather than by time, so a mark is
 * placed relative to an entry rather than at its timestamp; the fallback for a
 * mark with nothing after it is the end of the transcript — past the tool runs
 * as well as the messages.
 */
function orderBefore(anchors: readonly Anchor[], anchor: Anchor | undefined): number {
  if (anchor) return anchor.order - BEFORE;
  const last = anchors.at(-1);
  return last ? last.order + BEFORE : 0;
}

/** The first entry at or after a moment in time. */
function firstAfter(anchors: readonly Anchor[], at: number): Anchor | undefined {
  return anchors.find((entry) => entry.timestamp >= at);
}

function summaryStatus(status: RuntimeSummaryEvent["status"]): CompactionMark["status"] {
  if (status === "running") return "running";
  return status === "succeeded" ? "done" : "failed";
}

export function buildCompactionMarks(
  messages: readonly ChatMessage[],
  summaryEvents: readonly RuntimeSummaryEvent[] = [],
  clearings: readonly ContextClearingRecord[] = [],
  tools: readonly ToolRun[] = [],
): CompactionMark[] {
  const marks: CompactionMark[] = [];
  const anchors = timelineAnchors(messages, tools);

  for (const event of summaryEvents) {
    // Only compactions of the branch being shown. A summary from an abandoned
    // branch describes messages this transcript never contained.
    if (event.kind !== "compaction" || !event.active) continue;
    const keptMessage = event.firstKeptEntryId
      ? messages.find((message) => message.entryId === event.firstKeptEntryId)
      : undefined;
    const kept = keptMessage ? { order: keptMessage.order, timestamp: keptMessage.timestamp } : undefined;
    const anchor = kept ?? firstAfter(anchors, event.timestamp);
    marks.push({
      id: event.id,
      layer: 2,
      order: orderBefore(anchors, anchor),
      at: event.timestamp,
      status: summaryStatus(event.status),
      error: event.error,
      retryAttempt: event.retryAttempt,
      retryMaxAttempts: event.retryMaxAttempts,
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
      order: orderBefore(anchors, firstAfter(anchors, clearing.at)),
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
  if (mark.status === "failed") {
    // 说清楚三件事：没压成、因此会怎样、现在能做什么。原因是用户唯一能据此行动
    // 的东西，所以它必须在这儿，而不是只在一个几秒钟就消失的提示里。
    //
    // 「重试」这两个字也要说准。摘要请求走的是和普通对话同一套退避重试——临时性
    // 的 429/502/503、超时这些，最多试 8 次。所以一条线走到「失败」，意味着那几
    // 次都已经试完了，不是还有得等。
    const because = mark.error ? `原因：${mark.error}` : "运行时没有给出原因";
    return `这次压缩没做成，重试也用完了，上下文原样发给了模型。${because}。会话会继续变长，必要时手动 /compact 压一次。`;
  }
  if (mark.status === "running") {
    const retry = mark.retryAttempt
      ? `上游刚才没应答，正在第 ${mark.retryAttempt} 次重试${mark.retryMaxAttempts ? `（最多 ${mark.retryMaxAttempts} 次）` : ""}。`
      : "";
    return `${retry}正在把较早的对话折叠成一段摘要，这一步要向模型发一次请求，通常要等上十几秒。`;
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
