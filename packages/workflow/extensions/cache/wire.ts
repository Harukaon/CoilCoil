import { createHash } from "node:crypto";

export type WireObject = Record<string, unknown>;
export type CachePurpose = "conversation" | "compaction" | "branch_summary";
export interface CachePoint { hash: string; message: number; block: number; at: number; ttl: number; tokens?: number }
export interface CacheFingerprint {
  model: string;
  tools: string;
  system: string;
  parameters: string;
  scope: string;
  policy?: string;
}
export interface WirePlan {
  payload: WireObject;
  fingerprint: CacheFingerprint;
  points: CachePoint[];
  blocks: string[];
  boundary?: CachePoint;
  parentHit: boolean;
  ttl: number;
  preservedPolicy: boolean;
}

export function object(value: unknown): value is WireObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Key order is deterministic; arrays, text, signatures and tool results remain unchanged. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Tool input/schema property order can change the model's rendered prefix. */
function wireHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

function controls(payload: WireObject): { tools: unknown[]; system: unknown[]; messages: unknown[]; automatic: unknown } {
  const marked = (items: unknown): unknown[] => Array.isArray(items) ? items.filter(object).map((item) => item.cache_control).filter(object) : [];
  return { tools: marked(payload.tools), system: marked(payload.system),
    messages: Array.isArray(payload.messages) ? payload.messages.filter(object).flatMap((message) => marked(message.content)) : [],
    automatic: payload.cache_control };
}

function policyHash(payload: WireObject): string {
  const current = controls(payload);
  return hash({ ...current, tools: [...new Set(current.tools.map(canonical))], system: [...new Set(current.system.map(canonical))],
    messages: [...new Set(current.messages.map(canonical))] });
}

function unmarked(value: unknown): unknown {
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control"));
}

function eligible(block: WireObject): boolean {
  return ["text", "image", "document", "tool_use", "tool_result", "tool_addition", "tool_removal"].includes(String(block.type))
    && (block.type !== "text" || (typeof block.text === "string" && block.text.trim().length > 0));
}

/** Plan against final wire blocks, never against UI message indices. All points share one TTL. */
export function planCache(
  input: unknown,
  scope: string,
  ttl: number,
  purpose: CachePurpose,
  previous: readonly CachePoint[] = [],
  now = Date.now(),
  features: { tools?: boolean; parameters?: unknown } = {},
): WirePlan | undefined {
  if (!object(input) || !Array.isArray(input.messages)) return undefined;
  const original = structuredClone(input);
  const existing = controls(original);
  const configurations = [...existing.tools, ...existing.system, ...existing.messages, existing.automatic].filter(object);
  const preservedPolicy = ttl > 0 && (original.cache_control !== undefined || configurations.some((control) =>
    Object.keys(control).some((key) => key !== "type" && key !== "ttl")
    || control.type !== "ephemeral" || (control.ttl === "1h" ? 3_600_000 : 300_000) !== ttl));
  const payload = structuredClone(input);
  // Remove only protocol markers, never schema properties or nested tool result data.
  delete payload.cache_control;
  if (Array.isArray(payload.tools)) payload.tools = payload.tools.map(unmarked);
  if (typeof payload.system === "string") payload.system = [{ type: "text", text: payload.system }];
  if (Array.isArray(payload.system)) payload.system = payload.system.map(unmarked);
  const messages = (payload.messages as unknown[]).map((raw) => {
    if (!object(raw)) return raw;
    const content = typeof raw.content === "string" ? [{ type: "text", text: raw.content }]
      : Array.isArray(raw.content) ? raw.content.map(unmarked) : raw.content;
    return { ...raw, content };
  });
  payload.messages = messages;
  const parameters = Object.fromEntries(["thinking", "output_config", "output_format", "tool_choice", "betas", "speed", "context_management"]
    .filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]));
  const fingerprint: CacheFingerprint = { model: String(payload.model), tools: wireHash(payload.tools), system: wireHash(payload.system),
    parameters: wireHash([parameters, features.parameters]), scope };
  const control = { type: "ephemeral", ...(ttl === 3_600_000 ? { ttl: "1h" } : {}) };
  let prefix = wireHash(fingerprint);
  const blocks: string[] = [];
  const candidates: Array<CachePoint & { value: WireObject }> = [];
  for (let message = 0; message < messages.length; message++) {
    const item = messages[message];
    if (!object(item) || !Array.isArray(item.content)) continue;
    // Include all message fields other than content in the cumulative prefix.
    const { content, ...envelope } = item;
    prefix = wireHash([prefix, envelope]);
    for (let block = 0; block < content.length; block++) {
      const value = content[block];
      prefix = wireHash([prefix, value]);
      blocks.push(prefix);
      if (object(value) && eligible(value)) candidates.push({ hash: prefix, message, block, at: now, ttl, value });
    }
  }
  const warm = new Set(previous.filter((point) => now >= point.at && now - point.at < point.ttl - 10_000).map((point) => point.hash));
  const parent = [...candidates].reverse().find((point) => warm.has(point.hash));
  const tail = purpose === "conversation" ? candidates.at(-1) : undefined;
  if (preservedPolicy) {
    // Respect caller-owned mixed TTL, scope and automatic policies. Do not add
    // markers or silently promote a cheap 5m conversation suffix to 1h.
    const points = candidates.flatMap(({ value: _value, ...point }) => {
      const message = (original.messages as unknown[])[point.message];
      const content = object(message) && Array.isArray(message.content) ? message.content : [];
      const raw = content[point.block];
      const explicit = object(raw) && object(raw.cache_control) ? raw.cache_control : undefined;
      const automatic = object(original.cache_control) && point.hash === candidates.at(-1)?.hash ? original.cache_control : undefined;
      const control = explicit ?? automatic;
      return control?.type === "ephemeral" ? [{ ...point, ttl: control.ttl === "1h" ? 3_600_000 : 300_000 }] : [];
    });
    fingerprint.policy = policyHash(original);
    return { payload: original, fingerprint, blocks, points, boundary: points.at(-1), parentHit: false,
      ttl: points.at(-1)?.ttl ?? ttl, preservedPolicy: true };
  }
  // Two stable head points and at most two message points fit the API's four slots.
  if (ttl > 0) {
    if (features.tools !== false && Array.isArray(payload.tools)) {
      const last = [...payload.tools].reverse().find((tool) => object(tool) && tool.defer_loading !== true);
      if (last) last.cache_control = control;
    }
    if (Array.isArray(payload.system)) {
      const last = [...payload.system].reverse().find((value) => object(value) && eligible(value));
      if (object(last)) last.cache_control = control;
    }
  }
  const selected = ttl > 0 ? [...new Map([parent, tail].filter((point) => point !== undefined).map((point) => [point.hash, point])).values()] : [];
  for (const point of selected) point.value.cache_control = control;
  const points = selected.map(({ value: _value, ...point }) => point);
  fingerprint.policy = policyHash(payload);
  return { payload, fingerprint, blocks, points, boundary: points.at(-1), parentHit: Boolean(parent && ttl > 0), ttl, preservedPolicy: false };
}
