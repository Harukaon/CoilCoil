import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

/**
 * Drop the bodies of old tool results before they reach the model.
 *
 * Pi has exactly one answer to a context window filling up: compaction, which
 * replaces everything older than the recent window with a single prose summary.
 * That is the most destructive tool available, and it is also the only one, so
 * a session pays the full price the first time it crosses the threshold —
 * including for whatever filled the window, which in a coding agent is almost
 * always bulk tool output (file reads, greps, terminal logs) rather than the
 * conversation itself.
 *
 * Clearing those bodies is the cheap lever that belongs before compaction. The
 * tool call stays in the history, so the model still knows which file it read
 * and with which arguments and can read it again if it turns out to matter.
 * Nothing is lost from the session file either: this rewrites only the copy
 * handed to the provider for one request, which is what `context` hands us.
 *
 * Two rules keep it from being disruptive:
 *
 * - The newest results are never touched, so the work in progress stays intact.
 * - Clearing happens in batches that must free a worthwhile amount at once.
 *   Rewriting a message invalidates the prompt cache from that point on, so
 *   moving the boundary forward one result per turn would cost more than it
 *   saves. A cleared result stays cleared, which keeps the prefix stable
 *   between batches.
 */

/**
 * Pi compacts once the context passes `contextWindow - reserveTokens`; this
 * mirrors its default reserve so clearing can be timed against that line.
 */
const PI_RESERVE_TOKENS = 16_384;

/**
 * How far ahead of Pi's compaction line clearing goes to work.
 *
 * It has to be ahead of it, not level with it: Pi decides to compact from the
 * usage the provider reported for the request that just finished, and clearing
 * only affects the request after that. Level with the line, Pi always wins the
 * race and the cheap stage never gets to run.
 */
const HEADROOM_TOKENS = 24_000;

/**
 * Clearing is the first stage of compaction, not a background chore.
 *
 * It used to start at half the context window and top itself up every 8,000
 * tokens. Simulated against a real 4,700-tool-call session that fired 289
 * times — roughly every sixteen tool calls — and it was throwing away tool
 * output while a hundred thousand tokens of headroom sat unused. Nothing was
 * gained by being early; the results were merely destroyed sooner.
 *
 * So it waits for the same pressure that would otherwise trigger a summary, and
 * then clears everything it is allowed to touch in one pass. If that is enough,
 * the expensive lossy stage never runs at all.
 */
export function clearingThreshold(contextWindow: number): number {
  // Never sillier than half the window: on a small model Pi's line sits below
  // this one, and clearing from the first turn is worse than just compacting.
  return Math.max(contextWindow * 0.5, contextWindow - PI_RESERVE_TOKENS - HEADROOM_TOKENS);
}

/**
 * How much of the recent conversation keeps its tool output no matter what.
 *
 * Measured in tokens, and deliberately the same number compaction keeps
 * verbatim, so both stages draw one line: whatever is recent enough to survive
 * a summary is recent enough to keep its tool output.
 *
 * It used to be a count — the newest twelve results. A count is not a span. In
 * this user's real sessions the median turn issues thirteen tool calls and half
 * of all turns issue more than twelve, so half the time the model had its own
 * earlier output cleared while it was still working inside that turn. That is
 * the one thing this stage must never do.
 */
const KEEP_RECENT_TOKENS = 50_000;

/** A floor under the token guard, so a tiny window still protects something. */
const KEEP_RECENT_RESULTS = 8;

/** A result smaller than this is not worth the cache invalidation. */
const MIN_RESULT_TOKENS = 400;

/**
 * A pass has to free a worthwhile share of the window, or it is not worth doing.
 *
 * Expressed against the window rather than as a flat count so it means the same
 * thing on a 200k model and a 1M one. Below it, clearing cannot relieve the
 * pressure anyway and the summary is the honest answer.
 */
const MIN_BATCH_RATIO = 0.05;
const MIN_BATCH_FLOOR = 8_000;

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

/** Rough size of any message, for measuring how far back the protected span reaches. */
function messageTokens(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; text?: string; arguments?: unknown };
    if (record.type === "text") chars += (record.text ?? "").length;
    else if (record.type === "toolCall") chars += JSON.stringify(record.arguments ?? {}).length;
    else chars += IMAGE_CHARS;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Tool results old enough to be eligible, oldest first.
 *
 * Everything inside the protected span at the end of the conversation is off
 * limits, and the span is measured by walking backwards adding up messages —
 * all of them, not just the tool results, because the span is a stretch of
 * conversation rather than a number of lookups.
 */
function clearableResults(messages: readonly AgentMessage[]): ToolResultMessage[] {
  let budget = KEEP_RECENT_TOKENS;
  let boundary = messages.length;
  let protectedResults = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "toolResult") protectedResults += 1;
    // The floor keeps a handful of results safe even when they are individually
    // larger than the whole budget.
    if (budget <= 0 && protectedResults > KEEP_RECENT_RESULTS) break;
    budget -= messageTokens(message);
    boundary = index;
  }
  const results: ToolResultMessage[] = [];
  for (let index = 0; index < boundary; index++) {
    const message = messages[index];
    if (message.role === "toolResult") results.push(message);
  }
  return results;
}

export interface ClearingPlan {
  /** Tool call ids whose results this batch removes. */
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
  messages: readonly AgentMessage[],
  cleared: ReadonlySet<string>,
  usage: { tokens: number | null; contextWindow: number },
): ClearingPlan {
  if (usage.tokens === null || usage.contextWindow <= 0) return NOTHING_TO_CLEAR;
  if (usage.tokens < clearingThreshold(usage.contextWindow)) return NOTHING_TO_CLEAR;

  const toolCallIds: string[] = [];
  let freedTokens = 0;
  for (const result of clearableResults(messages)) {
    if (cleared.has(result.toolCallId)) continue;
    if (STATE_TOOLS.has(result.toolName)) continue;
    const tokens = resultTokens(result);
    if (tokens < MIN_RESULT_TOKENS) continue;
    toolCallIds.push(result.toolCallId);
    freedTokens += tokens;
  }

  const minimum = Math.max(MIN_BATCH_FLOOR, usage.contextWindow * MIN_BATCH_RATIO);
  return freedTokens >= minimum ? { toolCallIds, freedTokens } : NOTHING_TO_CLEAR;
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
    if (message.role !== "toolResult" || !cleared.has(message.toolCallId)) return message;
    changed = true;
    return { ...message, content: [{ type: "text" as const, text: clearedText(message) }] };
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

  pi.on("context", (event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage) {
      const plan = planToolResultClearing(event.messages, cleared, usage);
      for (const toolCallId of plan.toolCallIds) cleared.add(toolCallId);
      if (plan.toolCallIds.length) {
        pi.events.emit(CONTEXT_CLEARING_EVENT, {
          at: Date.now(),
          clearedResults: plan.toolCallIds.length,
          freedTokens: plan.freedTokens,
        } satisfies ContextClearingRecord);
      }
    }
    const messages = applyToolResultClearing(event.messages, cleared);
    return messages ? { messages } : undefined;
  });
}
