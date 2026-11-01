import { type CacheFingerprint, type CachePoint, type CachePurpose, type WirePlan, object } from "#cache/wire";

export const CACHE_LEDGER_ENTRY = "coilcoil-prompt-cache-v1";
export type CacheReason = "cold_start" | "hit" | "uncached" | "model_changed" | "scope_changed" | "tools_changed"
  | "system_changed" | "parameters_changed" | "cache_policy_changed" | "messages_changed" | "ttl_expired" | "unknown"
  | "compaction" | "user_tools_changed" | "user_rewind";
export interface CacheRecord {
  at: number;
  purpose: CachePurpose;
  model: string;
  responseId?: string;
  outcome: "cold" | "hit" | "miss" | "expected" | "uncached";
  reason: CacheReason;
  input: number;
  read: number;
  write: number;
  write1h: number;
  output: number;
  ttl: number;
  parentPinned: boolean;
  firstChangedBlock?: number;
  diagnostic?: string;
  transportHash?: string;
}
export interface CacheLedgerState {
  version: 1;
  requests: number;
  hits: number;
  misses: number;
  expected: number;
  cold: number;
  input: number;
  read: number;
  write: number;
  write1h: number;
  output: number;
  recent: CacheRecord[];
  baseline?: { fingerprint: CacheFingerprint; record: CacheRecord; boundary?: CachePoint; shareable?: boolean };
  points: CachePoint[];
}

/** Persist a compact checkpoint, not forty copies of prior records on every turn. */
export function cacheLedgerCheckpoint(state: CacheLedgerState): CacheLedgerState {
  return structuredClone({ ...state, recent: state.recent.slice(-1), points: state.points.slice(-2) });
}

export function restoreCacheLedger(entries: readonly unknown[]): CacheLedgerState | undefined {
  const snapshots = entries.filter((entry) => object(entry) && entry.type === "custom" && entry.customType === CACHE_LEDGER_ENTRY)
    .slice(-40).map((entry) => new PromptCacheLedger((entry as Record<string, unknown>).data).state);
  const latest = snapshots.at(-1);
  if (!latest) return undefined;
  const recent = [...new Map(snapshots.flatMap((snapshot) => snapshot.recent)
    .map((record) => [`${record.at}/${record.purpose}/${record.responseId ?? ""}`, record])).values()].slice(-40);
  const points = [...new Map(snapshots.flatMap((snapshot) => snapshot.points).map((point) => [point.hash, point])).values()].slice(-32);
  return { ...latest, recent, points };
}

const empty = (): CacheLedgerState => ({ version: 1, requests: 0, hits: 0, misses: 0, expected: 0, cold: 0,
  input: 0, read: 0, write: 0, write1h: 0, output: 0, recent: [], points: [] });
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
const numeric = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0;
const validPoint = (point: unknown): boolean => object(point) && typeof point.hash === "string"
  && ["message", "block", "at", "ttl"].every((key) => numeric(point[key]));
const validRecord = (record: unknown): boolean => object(record) && typeof record.model === "string" && typeof record.reason === "string"
  && ["conversation", "compaction", "branch_summary"].includes(String(record.purpose))
  && ["cold", "hit", "miss", "expected", "uncached"].includes(String(record.outcome))
  && ["at", "input", "read", "write", "write1h", "output", "ttl"].every((key) => numeric(record[key]));

/** Persistent metadata has no prompt text, tool arguments, credentials or response content. */
export class PromptCacheLedger {
  state: CacheLedgerState;
  private blocks?: string[];
  private expected = new Set<CacheReason>();

  constructor(saved?: unknown) {
    this.state = empty();
    if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.recent) || !Array.isArray(saved.points)) return;
    // Session files are local, but malformed metadata must never break model requests.
    if (!["requests", "hits", "misses", "expected", "cold", "input", "read", "write", "write1h", "output"]
      .every((key) => numeric(saved[key]))) return;
    if (!saved.points.every(validPoint) || !saved.recent.every(validRecord)) return;
    if (saved.baseline !== undefined) {
      const baseline = saved.baseline;
      if (!object(baseline) || !object(baseline.fingerprint) || !validRecord(baseline.record)) return;
      const fingerprint = baseline.fingerprint;
      if (!["model", "tools", "system", "parameters", "scope"].every((key) => typeof fingerprint[key] === "string")) return;
      if (baseline.boundary !== undefined && !validPoint(baseline.boundary)) return;
    }
    this.state = structuredClone(saved) as unknown as CacheLedgerState;
    this.state.recent = this.state.recent.slice(-40);
    this.state.points = this.state.points.slice(-32);
  }

  expect(reason: "compaction" | "user_tools_changed" | "user_rewind"): void { this.expected.add(reason); }

  complete(plan: WirePlan, purpose: CachePurpose, raw: unknown, responseId?: string, diagnostic?: string, at = Date.now()): CacheRecord {
    const usage = object(raw) ? raw : {};
    const prior = this.state.baseline;
    const input = number(usage.input), read = number(usage.cacheRead), write = number(usage.cacheWrite);
    let reason: CacheReason = "hit";
    if (!prior) reason = read > 0 ? "hit" : "cold_start";
    else {
      const old = prior.fingerprint, current = plan.fingerprint;
      if (old.model !== current.model) reason = "model_changed";
      else if (old.scope !== current.scope) reason = "scope_changed";
      else if (old.tools !== current.tools) reason = "tools_changed";
      else if (old.system !== current.system) reason = "system_changed";
      else if (old.parameters !== current.parameters) reason = "parameters_changed";
      else if (old.policy !== current.policy) reason = "cache_policy_changed";
      else if (prior.boundary && !plan.blocks.includes(prior.boundary.hash)) reason = "messages_changed";
    }
    const comparable = prior ? Math.min(prior.record.input + prior.record.read + prior.record.write, input + read + write) : 0;
    const drop = prior !== undefined && read < comparable * 0.95 && comparable - read >= 2000;
    let outcome: CacheRecord["outcome"] = !read && !write ? "uncached" : !prior && !read ? "cold" : drop ? "miss" : "hit";
    if (outcome === "uncached") reason = "uncached";
    else if (drop && reason === "hit") {
      const ttl = prior?.record.ttl ?? 0;
      reason = ttl > 0 && at - prior!.record.at >= ttl ? "ttl_expired" : "unknown";
    }
    if (drop) {
      const expected = reason === "tools_changed" && this.expected.has("user_tools_changed") ? "user_tools_changed"
        : reason === "messages_changed" && this.expected.has("compaction") ? "compaction"
        : reason === "messages_changed" && this.expected.has("user_rewind") ? "user_rewind" : undefined;
      if (expected) { reason = expected; outcome = "expected"; }
    }
    const firstChangedBlock = this.blocks?.findIndex((block, index) => plan.blocks[index] !== block);
    const record: CacheRecord = { at, purpose, model: plan.fingerprint.model, responseId, outcome, reason,
      input, read, write, write1h: number(usage.cacheWrite1h), output: number(usage.output),
      ttl: plan.ttl, parentPinned: plan.parentHit,
      firstChangedBlock: firstChangedBlock !== undefined && firstChangedBlock >= 0 ? firstChangedBlock : undefined, diagnostic };
    this.state.requests++;
    if (outcome === "hit") this.state.hits++;
    if (outcome === "miss") this.state.misses++;
    if (outcome === "expected") this.state.expected++;
    if (outcome === "cold") this.state.cold++;
    for (const key of ["input", "read", "write", "write1h", "output"] as const) this.state[key] += record[key];
    this.state.recent = [...this.state.recent, record].slice(-40);
    // Head-only cache activity does not prove that the entire conversation was
    // cached. A small ordinary tail permits protocol closing-token overhead.
    const throughEnd = plan.boundary?.hash === plan.blocks.at(-1) && input <= 16 && read + write > 0;
    const confirmed = plan.points.flatMap((point) => {
      const old = this.state.points.find((candidate) => candidate.hash === point.hash && candidate.tokens !== undefined);
      if (throughEnd && point.hash === plan.boundary?.hash) return [{ ...point, at, tokens: read + write }];
      return old?.tokens !== undefined && read + write >= old.tokens - 16 ? [{ ...old, at }] : [];
    });
    const points = new Map(this.state.points.map((point) => [point.hash, point]));
    for (const point of confirmed) {
      if (point.at >= (points.get(point.hash)?.at ?? -1)) points.set(point.hash, point);
    }
    this.state.points = [...points.values()].filter((point) => at - point.at < point.ttl)
      .sort((left, right) => left.at - right.at).slice(-32);
    // Responses can complete out of order (for example a cancelled warmer).
    // Their usage still counts, but an older dispatch must not replace newer state.
    if (purpose === "conversation" && (!prior || at >= prior.record.at)) {
      const boundary = confirmed.find((point) => point.hash === plan.boundary?.hash);
      this.state.baseline = { fingerprint: plan.fingerprint, record, boundary, shareable: !plan.preservedPolicy && Boolean(boundary) };
      this.blocks = plan.blocks;
      this.expected.clear();
    }
    return record;
  }
}
