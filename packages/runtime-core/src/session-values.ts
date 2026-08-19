import {
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  type CacheUsageSummary,
  type ContextUsage,
  type ResponseMetrics,
  type TokenUsage,
  summarizeCacheUsage,
} from "@suocode/runtime-protocol";
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

export function liveToolPurpose(toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  const registry = (globalThis as Record<PropertyKey, unknown>)[WORKFLOW_PURPOSE_REGISTRY];
  if (!(registry instanceof Map)) return undefined;
  const record = registry.get(toolCallId);
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

export function restoredToolPurposes(session: AgentSession): Map<string, string> {
  const purposes = new Map<string, string>();
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
    if (toolCallId && purpose) purposes.set(toolCallId, purpose);
  }
  return purposes;
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

export function sessionUsage(session: AgentSession): { contextUsage?: ContextUsage; tokenUsage: TokenUsage; } {
  const stats = session.getSessionStats();
  return {
    contextUsage: stats.contextUsage,
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
