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
 * Three outcomes, one rule. Clearing lands the request below this line: carry
 * on. It lands between the two lines: also carry on — Pi's line is what forces a
 * summary, and it has not been reached. It stays above Pi's line: Pi summarizes,
 * and that is this stage stepping aside, not failing.
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
 * The tool call itself always stays, with its arguments, so the model knows what
 * it read and can read it again. And nothing is lost from the session file: the
 * `context` hook rewrites only the copy handed to the provider for one request.
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
const KEEP_RECENT_TOKENS = 50_000;

/**
 * Tools whose result *is* live state rather than a lookup: the model has to
 * keep seeing the latest one, and re-running the tool would not reproduce it.
 */
const STATE_TOOLS = new Set(["todo", "goal"]);

const CLEARED_PREFIX = "[上下文已清理]";

/**
 * Channel this extension announces its batches on.
 *
 * Clearing is the one stage with no trace anywhere: the model simply stops
 * seeing old tool output, and the person watching the chat is told nothing.
 * Announcing each batch is what lets the transcript draw a line where it
 * happened — and what lets the log tell "kept up" apart from "never ran".
 */
export const CONTEXT_CLEARING_EVENT = "coilcoil:context-clearing:v1";

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
  let firstClearableIndex = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    recent += messageTokens(messages[index]);
    if (recent >= keepRecentTokens) {
      firstClearableIndex = index;
      break;
    }
  }

  const toolCallIds: string[] = [];
  let freedTokens = 0;
  for (let index = 0; index < firstClearableIndex; index += 1) {
    const message = messages[index];
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
    // results above the floor, so a small one matching a remembered key is a key
    // collision, not a decision anyone made. Leave it alone — replacing a short
    // result with a longer notice never made the context smaller anyway.
    if (resultTokens(result) < MIN_RESULT_TOKENS) return message;
    changed = true;
    return { ...result, content: [{ type: "text" as const, text: clearedText(result) }] };
  });
  return changed ? next : undefined;
}

export default function contextClearingExtension(pi: ExtensionAPI): void {
  let cleared = new Set<string>();

  // A cleared result keeps its entry while the branch that produced it is the
  // one being sent; a different branch starts over, because its messages were
  // never seen here.
  const reset = (): void => {
    cleared = new Set<string>();
  };

  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

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

    if (contextWindow > 0 && contextTokens > line) {
      const plan = planToolResultClearing(event.messages, cleared);
      if (plan.toolCallIds.length > 0) {
        for (const key of plan.toolCallIds) cleared.add(key);
        pi.events.emit(CONTEXT_CLEARING_EVENT, {
          at: Date.now(),
          clearedResults: plan.toolCallIds.length,
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
