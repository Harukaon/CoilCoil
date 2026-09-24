import { toolRunId } from "./tool-run-ids.js";
import {
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  type CacheUsageSummary,
  type ContextUsage,
  type ContextClearingRecord,
  type ResponseMetrics,
  type TokenUsage,
  summarizeCacheUsage,
} from "@coilcoil/runtime-protocol";
import {
  RESPONSE_METRICS_ENTRY_TYPE,
  TOOL_PURPOSE_POLICY_STATE,
  WORKFLOW_AUDIT_ENTRY_TYPE,
  WORKFLOW_PURPOSE_FIELDS,
  WORKFLOW_PURPOSE_REGISTRY
} from "./runtime-constants.js";
import {
  isRecord,
  stringValue
} from "./runtime-utils.js";

export function redactSensitiveText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function redactSensitiveValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSensitiveText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSensitiveValue(entry, secrets)]));
}

export function purposeFromArgs(args: Record<string, unknown>): string | undefined {
  for (const field of WORKFLOW_PURPOSE_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const [field, value] of Object.entries(args)) {
    if (field.startsWith("__auditPurpose_") && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * The purpose recorded for a live tool call, before its audit entry is readable.
 *
 * Scoped by session: tool call ids repeat across conversations (several
 * providers number them per response, so `call_0` comes back every time), and
 * the registry is shared by every session in this process.
 */
export function liveToolPurpose(
  sessionId: string | undefined,
  toolCallId: string | undefined,
): string | undefined {
  if (!sessionId || !toolCallId) return undefined;
  const registry = (globalThis as Record<PropertyKey, unknown>)[WORKFLOW_PURPOSE_REGISTRY];
  if (!(registry instanceof Map)) return undefined;
  const record = registry.get(`${sessionId}\u0000${toolCallId}`);
  if (!isRecord(record)) return undefined;
  const purpose = stringValue(record.purpose).trim();
  return purpose || undefined;
}

export function setGlobalToolPurposeAuditEnabled(enabled: boolean): void {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const state = globals[TOOL_PURPOSE_POLICY_STATE];
  const registry = state instanceof Map ? state as Map<string, boolean> : new Map<string, boolean>();
  registry.set("*", enabled);
  globals[TOOL_PURPOSE_POLICY_STATE] = registry;
}

export function globalToolPurposeAuditEnabled(): boolean {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const state = globals[TOOL_PURPOSE_POLICY_STATE];
  return state instanceof Map ? state.get("*") !== false : true;
}

export interface RestoredToolPurpose {
  purpose: string;
  /** The tool the purpose was written for, used to refuse a mismatched pairing. */
  toolName: string;
}

/**
 * The purpose recorded for each tool call, keyed the way tool runs are keyed.
 *
 * The audit trail records the provider's own tool call id, and several providers
 * reuse those inside one session — `openai-completions` endpoints number their
 * calls `call_0`, `call_1`, … and restart at zero every assistant turn (see
 * `tool-run-ids.ts`). Keying this map by the bare id therefore let the last
 * `call_0` of a conversation overwrite every earlier one, so reopening a session
 * captioned every one of those cards with the final call's purpose: three
 * different tool calls, one explanation, and it belonged to none of the first
 * two.
 *
 * Counting occurrences in entry order reproduces exactly the numbering
 * `ToolRunIds` gives the cards, so each purpose lands back on the call that
 * wrote it. Providers with genuinely unique ids see no change at all: the first
 * occurrence of an id keeps that id verbatim.
 */
export function restoredToolPurposes(session: AgentSession): Map<string, RestoredToolPurpose> {
  const purposes = new Map<string, RestoredToolPurpose>();
  const occurrences = new Map<string, number>();
  for (const entry of session.sessionManager.getEntries()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== WORKFLOW_AUDIT_ENTRY_TYPE ||
      !isRecord(entry.data)
    ) {
      continue;
    }
    const toolCallId = stringValue(entry.data.toolCallId);
    const purpose = stringValue(entry.data.purpose).trim();
    if (!toolCallId || !purpose) continue;
    const occurrence = (occurrences.get(toolCallId) ?? 0) + 1;
    occurrences.set(toolCallId, occurrence);
    purposes.set(toolRunId(toolCallId, occurrence), { purpose, toolName: stringValue(entry.data.toolName) });
  }
  return purposes;
}

/**
 * The purpose belonging to one restored card, or nothing when it cannot be sure.
 *
 * A call the model announced but never ran leaves a card without ever writing an
 * audit entry, so the two sequences can drift apart by one. The tool name is the
 * check that catches that: a purpose written for `bash` must never end up
 * captioning an `edit`. When they disagree the card simply shows its ordinary
 * label — no explanation is better than someone else's.
 */
export function restoredPurposeFor(
  purposes: ReadonlyMap<string, RestoredToolPurpose>,
  runId: string,
  toolName: string,
): string | undefined {
  const found = purposes.get(runId);
  if (!found) return undefined;
  if (found.toolName && toolName && found.toolName !== toolName) return undefined;
  return found.purpose;
}

export function responseMetricsFromData(data: unknown): ResponseMetrics | undefined {
  if (!isRecord(data)) return undefined;
  const outputTokens = Number(data.outputTokens);
  const totalMs = Number(data.totalMs);
  const turnDurationMs = Number(data.turnDurationMs);
  const timestamp = Number(data.timestamp);
  if (![outputTokens, totalMs, turnDurationMs, timestamp].every(Number.isFinite)) return undefined;
  const firstTokenMs = Number(data.firstTokenMs);
  const averageTokensPerSecond = Number(data.averageTokensPerSecond);
  const inputTokens = Number(data.inputTokens);
  const cacheReadTokens = Number(data.cacheReadTokens);
  const cacheWriteTokens = Number(data.cacheWriteTokens);
  return {
    firstTokenMs: Number.isFinite(firstTokenMs) ? firstTokenMs : undefined,
    averageTokensPerSecond: Number.isFinite(averageTokensPerSecond) ? averageTokensPerSecond : undefined,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : undefined,
    outputTokens,
    cacheReadTokens: Number.isFinite(cacheReadTokens) ? cacheReadTokens : undefined,
    cacheWriteTokens: Number.isFinite(cacheWriteTokens) ? cacheWriteTokens : undefined,
    totalMs,
    turnDurationMs,
    timestamp,
  };
}

export function restoredResponseMetrics(session: AgentSession): ResponseMetrics[] {
  const metricsHistory: ResponseMetrics[] = [];
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== RESPONSE_METRICS_ENTRY_TYPE) continue;
    const metrics = responseMetricsFromData(entry.data);
    if (metrics) metricsHistory.push(metrics);
  }
  return metricsHistory.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * A context reading is only believable up to the window it is measured against.
 *
 * Pi derives the reading from the last response's usage — input + cacheRead +
 * cacheWrite — and takes the provider at its word. One gateway, retrying a
 * request it had failed, came back with `cacheRead: 433326` against a 200000
 * window: more than twice a full context read in a single request, which is not
 * a thing that can happen. The number went straight to the UI as 「434k / 200k」
 * and to the clearing stage as an emergency.
 *
 * Going *somewhat* over the window is real and must stay visible — that is what
 * overflow is, and the reading is how it gets noticed: an accepted request plus
 * whatever was appended after it. What cannot be real is half a window of that
 * tail. One accepted request fits by definition, and a single response's
 * aftermath does not add another hundred thousand tokens, so a reading past one
 * and a half windows is the provider's arithmetic, not the conversation's size.
 *
 * It is dropped rather than clamped: `null` means "unknown", which is the truth,
 * and the next real response restores it. A clamped number would look like a
 * measurement and be believed.
 */
const IMPOSSIBLE_CONTEXT_RATIO = 1.5;

export function believableContextUsage(usage: ContextUsage | undefined): ContextUsage | undefined {
  if (!usage || usage.tokens === null) return usage;
  const { contextWindow } = usage;
  if (!contextWindow || contextWindow <= 0) return usage;
  if (usage.tokens <= contextWindow * IMPOSSIBLE_CONTEXT_RATIO) return usage;
  return { ...usage, tokens: null, percent: null };
}

export function contextUsageAfterClearing(
  usage: ContextUsage | undefined,
  clearing: ContextClearingRecord | undefined,
  lastAssistantTimestamp: number | undefined,
): ContextUsage | undefined {
  if (
    !usage?.contextWindow ||
    clearing?.projectedTokens === undefined ||
    clearing.contextWindow !== usage.contextWindow ||
    (lastAssistantTimestamp !== undefined && lastAssistantTimestamp >= clearing.at)
  ) return usage;
  const tokens = clearing.projectedTokens;
  return { ...usage, tokens, percent: (tokens / usage.contextWindow) * 100, estimated: true };
}

export function sessionUsage(
  session: AgentSession,
  clearings?: readonly ContextClearingRecord[],
): { contextUsage?: ContextUsage; tokenUsage: TokenUsage; } {
  const stats = session.getSessionStats();
  const contextUsage = believableContextUsage(stats.contextUsage);
  const latestClearing = clearings?.at(-1);
  let lastAssistantTimestamp: number | undefined;
  if (latestClearing?.projectedTokens !== undefined) {
    const entries = session.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      lastAssistantTimestamp = entry.message.timestamp;
      break;
    }
  }
  return {
    contextUsage: contextUsageAfterClearing(contextUsage, latestClearing, lastAssistantTimestamp),
    tokenUsage: { ...stats.tokens },
  };
}

/**
 * Add up what the model responses in this session actually consumed.
 *
 * Pi's own totals also fold in context compaction and branch summaries. Those
 * are separate requests built from a fresh prompt, so they can never hit the
 * cache; counting them made the session's hit rate look far worse than the
 * conversation it describes.
 */
export function sessionResponseCacheUsage(session: AgentSession): CacheUsageSummary {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } };
    if (message.role !== "assistant" || !message.usage) continue;
    input += Math.max(0, message.usage.input ?? 0);
    cacheRead += Math.max(0, message.usage.cacheRead ?? 0);
    cacheWrite += Math.max(0, message.usage.cacheWrite ?? 0);
  }
  return summarizeCacheUsage(input, cacheRead, cacheWrite);
}

/**
 * The two cache figures the inspector shows.
 *
 * `cacheHitRate` is the latest request alone — a lifetime average would
 * permanently hold a healthy session down for the request that first filled the
 * cache — while `cache` sums this session's model responses.
 */
export function sessionCacheInspection(
  session: AgentSession,
  latest: ResponseMetrics | undefined,
): { cacheHitRate?: number; cache: CacheUsageSummary } {
  const latestCache = latest
    ? summarizeCacheUsage(latest.inputTokens, latest.cacheReadTokens, latest.cacheWriteTokens)
    : undefined;
  return {
    cacheHitRate: latestCache && (latestCache.cacheReadTokens > 0 || latestCache.cacheWriteTokens > 0)
      ? latestCache.hitRate
      : undefined,
    cache: sessionResponseCacheUsage(session),
  };
}

export function usageIncludingPendingResponse(usage: TokenUsage, metrics: ResponseMetrics): TokenUsage {
  const input = usage.input + (metrics.inputTokens ?? 0);
  const output = usage.output + metrics.outputTokens;
  const cacheRead = usage.cacheRead + (metrics.cacheReadTokens ?? 0);
  const cacheWrite = usage.cacheWrite + (metrics.cacheWriteTokens ?? 0);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
