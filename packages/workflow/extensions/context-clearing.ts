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

/** Fraction of the context window that has to be in use before clearing starts. */
const TRIGGER_RATIO = 0.5;

/** Newest tool results kept verbatim no matter how full the window is. */
const KEEP_RECENT_RESULTS = 12;

/** A result smaller than this is not worth the cache invalidation. */
const MIN_RESULT_TOKENS = 400;

/** A batch has to free at least this much, or it waits for more candidates. */
const MIN_BATCH_TOKENS = 8_000;

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

/** Tool results old enough to be eligible, oldest first. */
function clearableResults(messages: readonly AgentMessage[]): ToolResultMessage[] {
  const results: ToolResultMessage[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") results.push(message);
  }
  return results.slice(0, Math.max(0, results.length - KEEP_RECENT_RESULTS));
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
  if (usage.tokens < usage.contextWindow * TRIGGER_RATIO) return NOTHING_TO_CLEAR;

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

  return freedTokens >= MIN_BATCH_TOKENS ? { toolCallIds, freedTokens } : NOTHING_TO_CLEAR;
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
