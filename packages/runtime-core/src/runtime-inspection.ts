import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  RuntimeInspectionSnapshot,
  RuntimeSummaryEvent,
  RuntimeSummaryUsage,
} from "@coilcoil/runtime-protocol";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  return list.length ? list : undefined;
}

function projectUsage(value: unknown): RuntimeSummaryUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = finiteNumber(value.input) ?? 0;
  const output = finiteNumber(value.output) ?? 0;
  const cacheRead = finiteNumber(value.cacheRead) ?? 0;
  const cacheWrite = finiteNumber(value.cacheWrite) ?? 0;
  const total = finiteNumber(value.totalTokens) ?? input + output + cacheRead + cacheWrite;
  const cost = isRecord(value.cost) ? finiteNumber(value.cost.total) : undefined;
  return { input, output, cacheRead, cacheWrite, total, cost };
}

function projectFiles(details: unknown): Pick<RuntimeSummaryEvent, "readFiles" | "modifiedFiles"> {
  if (!isRecord(details)) return {};
  return {
    readFiles: stringList(details.readFiles),
    modifiedFiles: stringList(details.modifiedFiles),
  };
}

/**
 * The first entry the compaction kept that the transcript actually draws.
 *
 * Pi's `firstKeptEntryId` is the first *entry* it kept, and that is routinely a
 * metadata entry — response metrics, a tool-purpose audit — which the chat never
 * renders. The renderer looks the id up among its messages, finds nothing, and
 * falls back to placing the rule by timestamp, i.e. at the end of the
 * conversation. The rule then sits below the fifty thousand tokens that were
 * kept verbatim while saying everything above it had been folded into a summary,
 * which is the opposite of what happened.
 *
 * Resolving it here rather than in the renderer because only this side has the
 * branch: the chat holds messages, not entries.
 */
function firstKeptMessageId(
  branch: ReturnType<SessionManager["getBranch"]> | undefined,
  firstKeptEntryId: string | undefined,
): string | undefined {
  if (!branch || !firstKeptEntryId) return firstKeptEntryId;
  const index = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  if (index < 0) return firstKeptEntryId;
  for (let cursor = index; cursor < branch.length; cursor += 1) {
    if (branch[cursor].type === "message") return branch[cursor].id;
  }
  return undefined;
}

export function summaryEventFromEntry(
  entry: ReturnType<SessionManager["getEntries"]>[number],
  activeIds: ReadonlySet<string>,
  branch?: ReturnType<SessionManager["getBranch"]>,
): RuntimeSummaryEvent | undefined {
  if (entry.type === "compaction") {
    return {
      id: entry.id,
      kind: "compaction",
      status: "succeeded",
      timestamp: Date.parse(entry.timestamp),
      active: activeIds.has(entry.id),
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      firstKeptEntryId: firstKeptMessageId(branch, entry.firstKeptEntryId),
      usage: projectUsage(entry.usage),
      ...projectFiles(entry.details),
    };
  }
  if (entry.type === "branch_summary") {
    return {
      id: entry.id,
      kind: "branch_summary",
      status: "succeeded",
      timestamp: Date.parse(entry.timestamp),
      active: activeIds.has(entry.id),
      summary: entry.summary,
      fromId: entry.fromId,
      usage: projectUsage(entry.usage),
      ...projectFiles(entry.details),
    };
  }
  return undefined;
}

export function buildRuntimeInspection(
  manager: SessionManager,
  sessionRevision: number,
  liveSummary?: RuntimeSummaryEvent,
): RuntimeInspectionSnapshot {
  const branch = manager.getBranch();
  const activeIds = new Set(branch.map((entry) => entry.id));
  const projected = manager.getEntries()
    .map((entry) => summaryEventFromEntry(entry, activeIds, branch))
    .filter((event): event is RuntimeSummaryEvent => Boolean(event));

  if (liveSummary) {
    const index = projected.findIndex((event) => event.id === liveSummary.id);
    const next = {
      ...(index >= 0 ? projected[index] : {}),
      ...liveSummary,
      active: index >= 0 ? activeIds.has(liveSummary.id) : liveSummary.active,
    } satisfies RuntimeSummaryEvent;
    if (index >= 0) projected[index] = next;
    else projected.push(next);
  }

  projected.sort((left, right) => left.timestamp - right.timestamp);
  return {
    sessionRevision,
    activeLeafId: manager.getLeafId() ?? undefined,
    summaryEvents: projected,
    systemPromptOverride: false,
    estimates: {},
    tools: [],
    skills: [],
    capabilities: {
      editSystemPrompt: true,
      removeOriginalSessionItems: false,
      removeOriginalSessionItemsReason: "Pi 当前没有安全修改原 Session 中间历史的 API；未执行任何修改。",
    },
  };
}
