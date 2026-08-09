import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  RuntimeInspectionSnapshot,
  RuntimeSummaryEvent,
  RuntimeSummaryUsage,
} from "@suocode/runtime-protocol";

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

export function summaryEventFromEntry(
  entry: ReturnType<SessionManager["getEntries"]>[number],
  activeIds: ReadonlySet<string>,
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
      firstKeptEntryId: entry.firstKeptEntryId,
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
  const activeIds = new Set(manager.getBranch().map((entry) => entry.id));
  const projected = manager.getEntries()
    .map((entry) => summaryEventFromEntry(entry, activeIds))
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
  };
}
