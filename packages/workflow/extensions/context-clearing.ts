import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

/**
 * Drop the bodies of old tool results instead of summarizing them.
 *
 * This is the cheap first stage of Pi's own compaction, not a mechanism beside
 * it. When Pi decides the context is full it prepares a compaction and asks its
 * extensions first; this hook clears the tool output from exactly the stretch
 * Pi was about to discard, and — if that alone brings the conversation back
 * under the line with room to keep going — cancels the summary. The tool call
 * stays, so the model still knows which file it read and with which arguments
 * and can read it again if it turns out to matter.
 *
 * Why bother, when Pi would summarize anyway: summarizing is lossy and it costs
 * the whole prompt cache, while dropping a web page's HTML costs nothing anyone
 * will miss. A conversation of forty ordinary turns fits easily; what fills the
 * window is a handful of huge tool results inside it. Take those out and the
 * same conversation runs for another forty turns with its chain intact. That is
 * the point of this stage — buying rounds before the lossy step, not saving
 * tokens for their own sake.
 *
 * Extending Pi's compaction rather than running alongside it is the whole
 * design, and getting that wrong cost three rounds of fixes. As a separate
 * mechanism it needed its own trigger, its own idea of how much recent
 * conversation to protect, and its own measurement of the context — and each of
 * those was a way to be wrong. Its trigger fired 289 times in one session; its
 * "keep the newest twelve results" left half of all turns clearing their own
 * output; its measurement read a number that clearing could never lower, so it
 * ran on every request forever.
 *
 * Here all three come from Pi: the trigger is Pi deciding to compact, the
 * protected span is whatever Pi kept out of `messagesToSummarize`, and there is
 * nothing to measure — Pi already did.
 *
 * Nothing is lost from the session file either: the `context` hook rewrites
 * only the copy handed to the provider for one request.
 */

/**
 * A result smaller than this is not worth replacing.
 *
 * It was 400, and a real session showed how wrong that is: 979 tool results,
 * 124k tokens of output, and only 31 of them were big enough to touch — 37% of
 * the output, while the browser and terminal work that filled the window came in
 * hundreds of results of a few hundred tokens each. The cache write is paid once
 * per batch, not per result, so the floor only has to be above the placeholder
 * that takes the result's place; at 120 the same session becomes 80% clearable.
 */
const MIN_RESULT_TOKENS = 120;

/**
 * Pi's own reserve: the room it keeps free for the answer, and so the line it
 * compacts at. Taken from the preparation when Pi hands it over; this is the
 * default every model starts from.
 */
const DEFAULT_RESERVE_TOKENS = 16_384;

/**
 * Our line sits ten thousand tokens below Pi's.
 *
 * Two stages deciding on the same line push against each other: clear just
 * enough to slip under it and the next request is back at the threshold, paying
 * another cache write for a single turn of relief. Landing a fixed distance
 * below it is what makes this stage buy rounds — and a fixed distance rather
 * than a share of the window because a number you can predict on every model is
 * worth more here than one that scales.
 */
const CLEARING_HEADROOM_TOKENS = 10_000;

/**
 * Tools whose result *is* live state rather than a lookup: the model has to
 * keep seeing the latest one, and re-running the tool would not reproduce it.
 */
const STATE_TOOLS = new Set(["todo", "goal"]);

const CLEARED_PREFIX = "[上下文已清理]";

/**
 * Channel this extension announces its batches on.
 *
 * Clearing is the one stage of compaction with no trace anywhere: the model
 * simply stops seeing old tool output, and the person watching the chat is told
 * nothing at all. Announcing each batch is what lets the transcript draw a line
 * where it happened.
 */
export const CONTEXT_CLEARING_EVENT = "coilcoil:context-clearing:v1";

export interface ContextClearingRecord {
  at: number;
  /** Tool results dropped in this batch. */
  clearedResults: number;
  /** Roughly how many tokens that freed. */
  freedTokens: number;
  /** Whether this batch was enough to skip Pi's summary this time. */
  cancelledCompaction: boolean;
  /** Results this stage could have taken, before the "is it worth it" test. */
  candidates: number;
  /** Pi was splitting a turn: most of what it meant to drop is the live turn's prefix. */
  splitTurn: boolean;
  /** What Pi measured when it decided to compact, and against which window. */
  contextTokens: number;
  contextWindow: number;
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

function clearedText(message: ToolResultMessage): string {
  return `${CLEARED_PREFIX} ${message.toolName} 的这次输出（约 ${resultChars(message)} 字符）已从上下文中移除以腾出窗口。调用参数仍在上面，需要内容就重新调用一次。`;
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

export interface ClearingPlan {
  /** Keys of the results this batch removes; see `resultKey`. */
  toolCallIds: string[];
  /** Estimated tokens the batch frees. */
  freedTokens: number;
}

const NOTHING_TO_CLEAR: ClearingPlan = { toolCallIds: [], freedTokens: 0 };

/**
 * Pick the next batch of results to clear. Returns nothing while the window is
 * still roomy, while the context size is unknown (which only happens right
 * after a compaction, when there is nothing to clear anyway), or when the batch
 * would be too small to pay for the cache write it costs.
 */
export function planToolResultClearing(
  discardable: readonly AgentMessage[],
  cleared: ReadonlySet<string>,
): ClearingPlan {
  const toolCallIds: string[] = [];
  let freedTokens = 0;
  for (const message of discardable) {
    if (message.role !== "toolResult") continue;
    const result = message as ToolResultMessage;
    const key = resultKey(result);
    if (cleared.has(key)) continue;
    if (STATE_TOOLS.has(result.toolName)) continue;
    const tokens = resultTokens(result);
    if (tokens < MIN_RESULT_TOKENS) continue;
    toolCallIds.push(key);
    freedTokens += tokens;
  }
  return { toolCallIds, freedTokens };
}

/**
 * Whether the conversation fits again once this batch is gone.
 *
 * This is the whole ladder in one line, and the old version asked the wrong
 * question. It asked "did this free at least 5% of the window" — so with the
 * context already over the ceiling, freeing a sliver still counted as success,
 * the summary was cancelled, and the next request was refused by the provider.
 * That is how a real session ended up in overflow recovery.
 *
 * The question is the user's own: 清理完之后，还能不能接着聊。`contextTokens` is
 * what Pi just measured — the size that made it decide to compact — so
 * subtracting the batch gives the size of the next request. It has to come back
 * under Pi's line, with a margin, or clearing has not bought any rounds.
 */
export function clearingRelievesPressure(
  plan: ClearingPlan,
  contextWindow: number,
  contextTokens: number,
  reserveTokens = DEFAULT_RESERVE_TOKENS,
): boolean {
  if (contextWindow <= 0 || contextTokens <= 0) return false;
  const line = contextWindow - reserveTokens;
  return contextTokens - plan.freedTokens <= line - CLEARING_HEADROOM_TOKENS;
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
    if (message.role !== "toolResult") return message;
    const result = message as ToolResultMessage;
    if (!cleared.has(resultKey(result))) return message;
    // Belt and braces after the `call_0` disaster: this stage only ever chooses
    // results above the floor, so a small one matching a remembered key is a
    // key collision, not a decision anyone made. Leave it alone — replacing a
    // short result with a longer notice never made the context smaller anyway.
    if (resultTokens(result) < MIN_RESULT_TOKENS) return message;
    changed = true;
    return { ...result, content: [{ type: "text" as const, text: clearedText(result) }] };
  });
  return changed ? next : undefined;
}

export default function contextClearingExtension(pi: ExtensionAPI): void {
  let cleared = new Set<string>();

  // Tool call ids are unique per call, so the set survives a compaction — the
  // ids that stay in context keep their entry — but a different branch has to
  // start over, because its ids were never seen here.
  const reset = (): void => {
    cleared = new Set<string>();
  };

  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

  /**
   * Pi is about to summarize. Try the cheap stage first.
   *
   * Only for the automatic threshold: a manual `/compact` is someone asking for
   * a summary and should get one, and overflow recovery is already past the
   * point where a cheaper stage helps.
   *
   * Cancelling short-circuits the remaining handlers, which is why this
   * extension is registered ahead of `context-transcript` — a cancelled
   * compaction must not leave an archive claiming it happened.
   */
  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason !== "threshold") return undefined;
    const preparation = event.preparation;
    // Both halves of what Pi is about to drop. The prefix half only exists when
    // Pi is splitting a turn — the current turn has grown too big to keep whole
    // — and skipping it is what made this stage useless in exactly the session
    // that needed it most: twenty hours of browser work in a handful of turns,
    // where nearly everything Pi wanted to summarize was inside the live turn.
    // Pi is going to summarize that prefix either way; dropping its tool output
    // first is the cheaper half of the same decision.
    const discardable = [
      ...preparation?.messagesToSummarize ?? [],
      ...preparation?.isSplitTurn ? preparation.turnPrefixMessages ?? [] : [],
    ];
    const plan = planToolResultClearing(discardable, cleared);
    const usage = ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? 0;
    const contextTokens = usage?.tokens ?? 0;
    const enough = plan.toolCallIds.length > 0
      && clearingRelievesPressure(plan, contextWindow, contextTokens, preparation?.settings?.reserveTokens);
    // Reported either way. This stage used to leave no trace at all: nobody
    // could tell a session where clearing carried the load from one where it
    // never fired, which is how a session ran twenty hours at 24% over the
    // window with nothing in the log to say why.
    pi.events.emit(CONTEXT_CLEARING_EVENT, {
      at: Date.now(),
      clearedResults: enough ? plan.toolCallIds.length : 0,
      freedTokens: enough ? plan.freedTokens : 0,
      cancelledCompaction: enough,
      candidates: plan.toolCallIds.length,
      splitTurn: Boolean(preparation?.isSplitTurn),
      contextTokens,
      contextWindow,
    } satisfies ContextClearingRecord);
    if (!enough) return undefined;
    for (const toolCallId of plan.toolCallIds) cleared.add(toolCallId);
    return { cancel: true };
  });

  // Where the clearing actually takes effect: the outgoing copy of one request.
  pi.on("context", (event) => {
    const messages = applyToolResultClearing(event.messages, cleared);
    return messages ? { messages } : undefined;
  });
}
