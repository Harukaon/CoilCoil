import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

/**
 * Drop the bodies of old tool results before the conversation has to be
 * summarized at all.
 *
 * Two lines, two stages, and neither has to interrupt the other:
 *
 *   窗口 − 26,384  ← this stage. Clear the big tool outputs outside the recent
 *                    stretch. Whatever is left is what gets sent.
 *   窗口 − 16,384  ← Pi's line. Reached only when clearing could not keep up;
 *                    Pi then summarizes, which is lossy and costs the cache.
 *
 * The point is not to save tokens. Forty ordinary turns fit in any window; what
 * fills it is a handful of enormous tool results inside those turns — a web page
 * returned as HTML, a directory read whole. Take those out and the same
 * conversation runs on with its chain intact, in order, unsummarized. Every
 * round bought here is a round that never has to be compressed.
 *
 * One pass per cycle. Clearing sweeps everything it is eligible to touch, once,
 * and then stands down until a compaction has actually happened — 「这反复清理
 * 还不如直接压缩呢」. Three outcomes follow from that one pass. It lands the
 * request below this line: carry on, and the cycle has been bought outright. It
 * lands between the two lines: also carry on — Pi's line is what forces a
 * summary, and it has not been reached. It stays above Pi's line: Pi summarizes,
 * and that is this stage stepping aside, not failing. In every case the next
 * pass is handed back by `session_compact`, never by the context climbing again.
 *
 * Owning a line ahead of Pi's is what makes that work without a cancel. The
 * previous version hooked Pi's own decision and cancelled the summary when it
 * had cleared "enough"; a cancel that turned out not to be enough left the
 * request over the ceiling with nothing between it and the provider, and one
 * real session ended in overflow recovery that way. Arriving first needs no
 * cancel: Pi measures what the provider charged for the last request, which is
 * the copy this stage already trimmed, so clearing genuinely keeps Pi's line out
 * of reach — and when it cannot, Pi acts on its own schedule.
 *
 * What stays is the *fact* of the call — this tool ran, then that one. The
 * arguments go with the output: a grep pattern is small, five hundred of them
 * are not, and 「不要看它小就不删……积少成多也会很大」. Nothing is lost from the
 * session file either: the `context` hook rewrites only the copy handed to the
 * provider for one request, and the transcript keeps every byte.
 */

/**
 * No result is too small to clear.
 *
 * There used to be a per-result floor — 400 tokens, then 120 — and both were
 * wrong for the same reason: what fills a window is not one huge result, it is
 * hundreds of ordinary ones. A session of browser work produced 979 results
 * averaging 127 tokens; a floor of 400 could touch 31 of them. 「不要看它小就不
 * 删，它有可能几百次、成千次调用，积少成多也会很大」.
 *
 * What is still worth a floor is the *batch*: rewriting the middle of the prompt
 * costs the provider's cache, so a pass that frees a few hundred tokens buys one
 * turn and pays for it twice. Small results are cleared — just not one at a time.
 */
const MIN_BATCH_TOKENS = 2_000;

/** Pi's own reserve — its line is `contextWindow - reserveTokens`. */
const PI_RESERVE_TOKENS = 16_384;

/**
 * How far ahead of Pi's line this stage acts.
 *
 * A fixed distance rather than a share of the window: a number that means the
 * same thing on every model is worth more here than one that scales. Ten
 * thousand is enough room for a batch to be worth its cache write, and small
 * enough that the conversation really is near full when it happens.
 */
const CLEARING_LEAD_TOKENS = 10_000;

/**
 * How much recent conversation this stage never touches.
 *
 * The same stretch Pi keeps verbatim through a compaction, so the two stages
 * agree on what "recent" means: whatever this one clears, Pi would have
 * summarized away anyway.
 */
const KEEP_RECENT_TOKENS = 20_000;

/**
 * Tools whose result *is* live state rather than a lookup: the model has to
 * keep seeing the latest one, and re-running the tool would not reproduce it.
 */
const STATE_TOOLS = new Set(["todo", "goal"]);

const CLEARED_PREFIX = "[上下文已清理]";
/** 参数清掉之后留在原地的东西：调用本身还在，参数没了。 */
const CLEARED_ARGUMENTS = { note: CLEARED_PREFIX };

/**
 * Channel this extension announces its batches on.
 *
 * Clearing is the one stage with no trace anywhere: the model simply stops
 * seeing old tool output, and the person watching the chat is told nothing.
 * Announcing each batch is what lets the transcript draw a line where it
 * happened — and what lets the log tell "kept up" apart from "never ran".
 */
export const CONTEXT_CLEARING_EVENT = "coilcoil:context-clearing:v1";

/**
 * 两条只进日志的通道：一条记「交给 pi 去摘要的那一段瘦了多少」，一条记「到线了却
 * 没动手，为什么」。
 *
 * 不走上面那条，是因为那条会在对话里画一道横线。这两件事都没有改变对话本身——一
 * 个只影响那一发摘要请求，一个干脆什么都没做——画出来只会让人以为自己又少了一块
 * 上下文。但查问题的时候它们是最要紧的两条线索。
 */
export const CONTEXT_SUMMARY_TRIM_EVENT = "coilcoil:context-clearing:summary:v1";
export const CONTEXT_CLEARING_SKIPPED_EVENT = "coilcoil:context-clearing:skipped:v1";

export interface ContextSummaryTrimRecord {
  at: number;
  /** 两段各自的消息条数。 */
  historyMessages: number;
  turnPrefixMessages: number;
  /** 清掉的工具记录条数，以及这一段瘦下来的估算。 */
  clearedResults: number;
  tokensBefore: number;
  tokensAfter: number;
  /** 这个模型的窗口——瘦完到底进没进去，就看这两个数。 */
  contextWindow: number;
}

export interface ContextClearingSkippedRecord {
  at: number;
  reason: "no-pass-left" | "batch-too-small" | "reading-not-believable";
  contextTokens: number;
  contextWindow: number;
  /** 这一轮本来能腾出多少——门槛没够的时候看这个。 */
  freedTokens: number;
}

export interface ContextClearingRecord {
  at: number;
  /** Tool results dropped in this batch. */
  clearedResults: number;
  /** Roughly how many tokens that freed. */
  freedTokens: number;
  /** What the context measured when this ran, and against which window. */
  contextTokens: number;
  contextWindow: number;
  /** Whether the batch brought the request back under this stage's line. */
  fitsAgain: boolean;
}

/** Pi's own chars/4 heuristic, with the same allowance for an inline image. */
const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4_800;

function resultChars(message: ToolResultMessage): number {
  let chars = 0;
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length;
    else chars += IMAGE_CHARS;
  }
  return chars;
}

function resultTokens(message: ToolResultMessage): number {
  return Math.ceil(resultChars(message) / CHARS_PER_TOKEN);
}

/** Rough size of any message, for walking back over the recent stretch. */
function messageTokens(message: AgentMessage): number {
  if (message.role === "toolResult") return resultTokens(message as ToolResultMessage);
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content as Array<Record<string, unknown>>) {
    if (typeof block.text === "string") chars += block.text.length;
    else if (block.type === "image") chars += IMAGE_CHARS;
    else if (block.arguments !== undefined) chars += JSON.stringify(block.arguments).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** 一段消息的粗略大小，中文按一个字一个 token 算——这一条会进日志，得贴近真值。 */
function estimateTokens(messages: readonly AgentMessage[]): number {
  const text = JSON.stringify(messages);
  const han = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  return Math.round(han + (text.length - han) / CHARS_PER_TOKEN);
}

function clearedText(message: ToolResultMessage): string {
  return `${CLEARED_PREFIX} ${message.toolName} 的这次输出（约 ${resultChars(message)} 字符）已移除以腾出窗口，参数也一并清掉了。需要就重新调用一次。`;
}

/**
 * How one tool result is identified for clearing.
 *
 * Not the tool call id on its own, and this is the whole lesson of the bug this
 * exists to prevent: one provider hands out `call_0`, `call_1`, `call_2` and
 * restarts the numbering every turn. In a real session 990 of 996 results were
 * called `call_0`. Keyed by id alone, clearing one old result silently replaced
 * every result the session would ever produce — the model went blind mid-task
 * while the transcript on disk still held every byte. The timestamp is what
 * makes the key the *message* rather than the name of a slot.
 */
export function resultKey(message: Pick<ToolResultMessage, "toolCallId" | "timestamp">): string {
  return `${message.toolCallId}@${message.timestamp ?? 0}`;
}

/** 调用参数用同一个集合记，加个前缀免得和结果撞上。 */
function callKey(id: string): string {
  return `call:${id}`;
}

interface CallBlock { id?: unknown; name?: unknown; arguments?: unknown; type?: unknown }

/** 一条助手消息里的工具调用块。 */
function callBlocks(message: AgentMessage): CallBlock[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return (content as CallBlock[]).filter((block) => block?.type === "toolCall");
}

/** 参数被清掉之后留下的那一点点，算大小时按它扣。 */
const CLEARED_ARGUMENTS_TOKENS = 12;

export interface ClearingPlan {
  /** Keys of the results this batch removes; see `resultKey`. */
  toolCallIds: string[];
  /** Ids of the calls whose arguments go with them. */
  callIds: string[];
  /** Estimated tokens the batch frees. */
  freedTokens: number;
}

/** This stage's line: ten thousand tokens ahead of Pi's. */
export function clearingLine(contextWindow: number, reserveTokens = PI_RESERVE_TOKENS): number {
  return contextWindow - reserveTokens - CLEARING_LEAD_TOKENS;
}

/**
 * Pick everything worth clearing, in one batch.
 *
 * One batch rather than a trickle: every batch rewrites the middle of the prompt
 * and costs a cache write, so freeing the same tokens a little at a time across
 * thirty requests is the expensive way to do it.
 *
 * The newest `keepRecentTokens` are walked back over first and left alone — that
 * is the conversation in progress, and the model is still working from it.
 */
export function planToolResultClearing(
  messages: readonly AgentMessage[],
  cleared: ReadonlySet<string>,
  keepRecentTokens = KEEP_RECENT_TOKENS,
): ClearingPlan {
  let recent = 0;
  // 留 0 就是「一条都不留」——摘要那条路会这么用：交给 pi 去总结的那一段，按定义
  // 全都在保留窗口之外了。
  let firstClearableIndex = keepRecentTokens <= 0 ? messages.length : 0;
  for (let index = messages.length - 1; keepRecentTokens > 0 && index >= 0; index -= 1) {
    recent += messageTokens(messages[index]);
    if (recent >= keepRecentTokens) {
      firstClearableIndex = index;
      break;
    }
  }

  const toolCallIds: string[] = [];
  const callIds: string[] = [];
  let freedTokens = 0;
  for (let index = 0; index < firstClearableIndex; index += 1) {
    const message = messages[index];
    if (message.role === "toolResult") {
      const result = message as ToolResultMessage;
      const key = resultKey(result);
      if (cleared.has(key)) continue;
      // todo / goal 是「当前状态」，不是查阅内容：清掉它模型就不知道自己在做什么了。
      if (STATE_TOOLS.has(result.toolName)) continue;
      toolCallIds.push(key);
      freedTokens += resultTokens(result);
      continue;
    }
    // 调用参数也是内容：一条 grep 的正则不大，几百条就不小了。留下的只有「调用过
    // 什么工具」这件事本身，那是摘要接不住、模型又必须知道的。
    for (const block of callBlocks(message)) {
      const id = String(block.id ?? "");
      if (!id || cleared.has(callKey(id)) || STATE_TOOLS.has(String(block.name ?? ""))) continue;
      const size = Math.ceil(JSON.stringify(block.arguments ?? {}).length / CHARS_PER_TOKEN);
      if (size <= CLEARED_ARGUMENTS_TOKENS) continue;
      callIds.push(callKey(id));
      freedTokens += size - CLEARED_ARGUMENTS_TOKENS;
    }
  }
  return { toolCallIds, callIds, freedTokens };
}

/**
 * Replace the content of every cleared result with the placeholder. Returns
 * undefined when nothing matches, so an untouched context is handed on as-is.
 */
export function applyToolResultClearing(
  messages: readonly AgentMessage[],
  cleared: ReadonlySet<string>,
): AgentMessage[] | undefined {
  if (cleared.size === 0) return undefined;
  let changed = false;
  const next = messages.map((message) => {
    if (message.role === "toolResult") {
      const result = message as ToolResultMessage;
      if (!cleared.has(resultKey(result))) return message;
      const replacement = clearedText(result);
      // 换上去的说明比原文还长，就别换——那只会让上下文更大。这条也是 `call_0`
      // 那次事故留下的护栏：万一键撞上了，最坏也只是什么都没发生。
      if (replacement.length >= resultChars(result)) return message;
      changed = true;
      return { ...result, content: [{ type: "text" as const, text: replacement }] };
    }
    const calls = callBlocks(message);
    if (!calls.some((block) => cleared.has(callKey(String(block.id ?? ""))))) return message;
    changed = true;
    const content = ((message as { content: CallBlock[] }).content).map((block) => {
      if (block?.type !== "toolCall" || !cleared.has(callKey(String(block.id ?? "")))) return block;
      return { ...block, arguments: CLEARED_ARGUMENTS };
    });
    return { ...message, content } as AgentMessage;
  });
  return changed ? next : undefined;
}

/**
 * 把一段消息里的工具内容全部清掉，原地换成清理后的那一份。
 *
 * 给摘要用的。pi 做摘要时读的是磁盘上那份原始会话（`sessionManager.getBranch()`），
 * 不是我们在 `context` 钩子里改过的拷贝——那是设计如此：磁盘上一字不少，用户才翻
 * 得回去。可这意味着最该瘦的那一发请求反而是最胖的：同一条会话，平时发给模型的是
 * 13 万 token，pi 拿去摘要的是 49 万，而窗口只有 20 万。上游一句
 * `upstream_error` 秒拒，八次重试全废，压缩就再也做不成了。
 *
 * 交给 pi 去总结的这一段，按定义整段都在保留窗口之外——它本来就要被折叠成一段散
 * 文。所以这里不留情面，工具的输出和参数全清掉，只留「调过什么工具」。摘要要的是
 * 「发生过什么」，不是某个文件当时的 4 万字内容；原文一个字节也没丢，还在会话文
 * 件里。
 */
export function clearForSummary(messages: AgentMessage[]): { cleared: number; freedTokens: number } {
  const plan = planToolResultClearing(messages, new Set(), 0);
  if (!plan.toolCallIds.length && !plan.callIds.length) return { cleared: 0, freedTokens: 0 };
  const next = applyToolResultClearing(messages, new Set([...plan.toolCallIds, ...plan.callIds]));
  if (!next) return { cleared: 0, freedTokens: 0 };
  // 就地换掉：pi 把 preparation 按引用交给我们，之后用的还是这同一个数组。
  messages.splice(0, messages.length, ...next);
  return { cleared: plan.toolCallIds.length + plan.callIds.length, freedTokens: plan.freedTokens };
}

export default function contextClearingExtension(pi: ExtensionAPI): void {
  let cleared = new Set<string>();
  /**
   * One pass, then stand down until a compaction has actually happened.
   *
   * 「这反复清理还不如直接压缩呢」. A live session cleared nine times in
   * forty-five minutes, each pass buying ten or fifteen minutes before the
   * conversation climbed back to the line — and each one rewriting the middle of
   * the prompt and paying for a fresh cache write. A stage that has to keep
   * firing to hold the line is not postponing the summary, it is charging rent
   * for the delay.
   *
   * So the allowance is one. Spend it, and this stage is done until Pi
   * summarizes; `session_compact` is what hands back the next one. Clearing
   * still goes first every cycle — it is still the cheap layer, and the cycle
   * that starts with a clean sweep of old tool records is a cycle that reaches
   * Pi's line later.
   */
  let passesLeft = 1;
  /** 上一次「到线了却没动手」的理由；同一个理由不重复报。 */
  let lastDeclined: ContextClearingSkippedRecord["reason"] | undefined;

  // A cleared result keeps its entry while the branch that produced it is the
  // one being sent; a different branch starts over, because its messages were
  // never seen here.
  const reset = (): void => {
    cleared = new Set<string>();
    passesLeft = 1;
    lastDeclined = undefined;
  };

  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

  // A compaction has happened: the history behind the cut is a summary now, and
  // whatever tool records survived it are fair game for the one pass of the new
  // cycle. Only a compaction that succeeded counts — a cancelled or failed one
  // leaves the context exactly as it was, and handing back a pass there would
  // be the old repeat-clearing under another name.
  pi.on("session_compact", () => {
    passesLeft = 1;
    lastDeclined = undefined;
  });

  /**
   * 压缩没做成，也把机会还回来。
   *
   * 「一轮只清一次」这条规矩，说的是别抢在压缩前面反复出手——压缩能跑的时候，清理
   * 买来的那点时间不值它打碎一次缓存。可压缩要是压根跑不起来（服务商连着 502，这
   * 是真发生过的），那条规矩就把两道闸门一起关死了：上下文一点没少，清理又没机会
   * 动手，只能一路涨到溢出。
   *
   * 这种时候清理是仅剩的那一根杠杆，多清几次也比什么都不做强。被用户中断的那种不
   * 算——那是人自己按的停，不是没做成。
   */
  /**
   * 摘要请求也得瘦一遍，不然它是整条链上最胖的那一发。
   *
   * 这一层不返回任何东西，pi 自己的摘要逻辑一行不动——提示词、两段合并、重试、会
   * 话记账全是它的。我们只是让它看到的那份，和模型平时看到的那份一样瘦。
   */
  pi.on("session_before_compact", (event, ctx) => {
    const preparation = (event as { preparation?: { messagesToSummarize?: AgentMessage[]; turnPrefixMessages?: AgentMessage[] } }).preparation;
    if (!preparation) return undefined;
    const history = Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : [];
    const prefix = Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : [];
    const tokensBefore = estimateTokens([...history, ...prefix]);
    let clearedResults = 0;
    // 不往界面上画线：这一次清理没有改变对话本身，只是让那一发摘要请求发得出去。
    // 画一条「已清理 N 条」在压缩线旁边，只会让人以为自己的上下文又少了一块。日志
    // 里要记，因为「那一发到底多大」正是压缩挂掉时唯一说得清原因的数。
    for (const slice of [history, prefix]) {
      if (slice.length) clearedResults += clearForSummary(slice).cleared;
    }
    pi.events.emit(CONTEXT_SUMMARY_TRIM_EVENT, {
      at: Date.now(),
      historyMessages: history.length,
      turnPrefixMessages: prefix.length,
      clearedResults,
      tokensBefore,
      tokensAfter: estimateTokens([...history, ...prefix]),
      contextWindow: ctx.getContextUsage()?.contextWindow ?? 0,
    } satisfies ContextSummaryTrimRecord);
    return undefined;
  });

  pi.on("session_compact_failed", (event) => {
    if ((event as { aborted?: boolean }).aborted) return;
    passesLeft = 1;
    lastDeclined = undefined;
  });

  /**
   * Before every request: at this stage's line, clear what can be cleared, then
   * hand over the rewritten copy.
   *
   * Measuring by what Pi reports rather than counting the messages here is
   * deliberate. Pi's number is anchored on what the provider charged for the
   * last request — the copy this stage already trimmed — so clearing genuinely
   * lowers it, and both stages read the same dial.
   */
  pi.on("context", (event, ctx) => {
    const usage = ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? 0;
    const contextTokens = usage?.tokens ?? 0;
    const line = clearingLine(contextWindow);

    // 读数比窗口还大一半以上的时候，那不是上下文，是服务商算错了：一次被接受的
    // 请求按定义就装得下窗口，它之后补上的东西也不可能再多出半个窗口。真见过
    // 一次——网关在重试里把缓存读取重复计，200K 的窗口报回来 433K。照着这种数动
    // 手，一轮仅有的一次清理就白花了。
    const believable = contextWindow > 0 && contextTokens <= contextWindow * 1.5;
    const overLine = contextWindow > 0 && contextTokens > line;
    const decline = (reason: ContextClearingSkippedRecord["reason"], freedTokens: number): void => {
      // 同一个理由只报第一次：额度用光之后每一轮都会走到这儿，报满日志就等于没报。
      if (lastDeclined === reason) return;
      lastDeclined = reason;
      pi.events.emit(CONTEXT_CLEARING_SKIPPED_EVENT, {
        at: Date.now(),
        reason,
        contextTokens,
        contextWindow,
        freedTokens,
      } satisfies ContextClearingSkippedRecord);
    };

    if (overLine && !believable) decline("reading-not-believable", 0);
    else if (overLine && passesLeft <= 0) decline("no-pass-left", 0);

    if (passesLeft > 0 && believable && contextTokens > line) {
      const plan = planToolResultClearing(event.messages, cleared);
      // 单条不设门槛（几百次小调用加起来才是大头），但一批腾不出一定量就先不动：
      // 每清一次都要重写一遍提示词、打碎服务商的缓存。
      if (plan.freedTokens < MIN_BATCH_TOKENS) decline("batch-too-small", plan.freedTokens);
      if (plan.freedTokens >= MIN_BATCH_TOKENS) {
        for (const key of [...plan.toolCallIds, ...plan.callIds]) cleared.add(key);
        passesLeft -= 1;
        lastDeclined = undefined;
        pi.events.emit(CONTEXT_CLEARING_EVENT, {
          at: Date.now(),
          clearedResults: plan.toolCallIds.length + plan.callIds.length,
          freedTokens: plan.freedTokens,
          contextTokens,
          contextWindow,
          // Said plainly, because it is the only question that matters as a
          // session grows: did this stage keep up, or is Pi about to summarize?
          fitsAgain: contextTokens - plan.freedTokens <= line,
        } satisfies ContextClearingRecord);
      }
    }

    const messages = applyToolResultClearing(event.messages, cleared);
    return messages ? { messages } : undefined;
  });
}
