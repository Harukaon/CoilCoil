import type { Api, AssistantMessage, CacheRetention, Context, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CachedSessionRequest } from "../anthropic-cache-policy.ts";
import type { AnthropicCacheController } from "../cache/controller.ts";

export interface SummaryPrefix {
  context: Context;
  cacheRetention: CacheRetention;
  maxTokens: number;
  cache?: AnthropicCacheController;
}

/** Reuse only a captured, still-warm request that the selected model actually accepted. */
export function summaryPrefix(
  request: CachedSessionRequest | undefined,
  model: Model<Api>,
  branch: readonly SessionEntry[],
  now = Date.now(),
  firstKeptEntryId?: string,
): SummaryPrefix | undefined {
  if (!request || model.api !== "anthropic-messages" || request.cacheRetention === "none") return undefined;
  if (request.model.provider !== model.provider || request.model.id !== model.id || request.model.api !== model.api) return undefined;
  // Older models invalidate message caches when the summary changes the thinking budget.
  if ((model.compat as { supportsMidConvoEffort?: boolean } | undefined)?.supportsMidConvoEffort !== true) return undefined;
  const ttl = request.cacheRetention === "long" ? 3_600_000 : 300_000;
  if (now < request.at || now - request.at >= ttl - 10_000) return undefined;
  const reply = [...branch].reverse().find((entry) => entry.type === "compaction"
    || (entry.type === "message" && entry.message.role === "assistant"));
  if (reply?.type !== "message" || reply.message.role !== "assistant") return undefined;
  const message = reply.message as AssistantMessage;
  if (message.provider !== model.provider || message.model !== model.id || message.timestamp < request.at) return undefined;
  if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
  // The accepted request predates its reply and subsequent tool results. A
  // split long turn can compact those new messages too; use the full text
  // summary in that case so the summary does not silently omit them.
  if (firstKeptEntryId !== undefined) {
    const keptIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
    if (keptIndex < 0 || keptIndex > branch.indexOf(reply)) return undefined;
  }
  if (request.cache) {
    const baseline = request.cache.ledger.state.baseline;
    const boundary = baseline?.boundary;
    if (!baseline?.shareable || !boundary || (message.responseId && baseline.record.responseId !== message.responseId)
      || now < boundary.at || now - boundary.at >= boundary.ttl - 10_000) return undefined;
  }
  const usage = message.usage;
  if (!usage || usage.cacheRead + usage.cacheWrite <= 0) return undefined;
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  // The full prefix already contains the prompt and tools. Reserve room for the summary instruction.
  const room = Math.floor(model.contextWindow - input - 4096);
  if (room < 4096) return undefined;
  return {
    context: { messages: request.context.messages },
    cacheRetention: request.cacheRetention,
    maxTokens: Math.min(room, model.maxTokens, 16_000),
    cache: request.cache,
  };
}
