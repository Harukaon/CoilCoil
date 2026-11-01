import { createHash } from "node:crypto";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Describe arguments/results without copying their values into diagnostics. */
export function diagnosticValueSummary(value: unknown): { bytes: number; fingerprint: string; shape: unknown; bounded: boolean } {
  const hash = createHash("sha256");
  const seen = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  let bounded = false;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 2_000 || depth > 10) { bounded = true; return { type: "omitted" }; }
    if (item === null) { hash.update("null"); return { type: "null" }; }
    const type = typeof item;
    hash.update(`${type}:`);
    if (type === "string") {
      const size = Buffer.byteLength(item as string);
      bytes += size;
      hash.update(`${size}:`).update(item as string);
      return { type, bytes: size };
    }
    if (type !== "object") { hash.update(String(item)); return { type }; }
    if (seen.has(item as object)) { bounded = true; return { type: "circular" }; }
    seen.add(item as object);
    if (Array.isArray(item)) {
      const shapes = item.slice(0, 100).map((entry) => visit(entry, depth + 1));
      if (item.length > 100) bounded = true;
      hash.update(`length:${item.length}`);
      return { type: "array", length: item.length, ...(depth < 2 ? { items: shapes.slice(0, 3) } : {}) };
    }
    const entries = Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const fields: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of entries.slice(0, 100)) {
      hash.update(`key:${Buffer.byteLength(key)}:${key}`);
      const shape = visit(entry, depth + 1);
      if (depth < 3 && Object.keys(fields).length < 30) fields[key] = shape;
    }
    if (entries.length > 100) bounded = true;
    return { type: "object", keys: entries.length, ...(depth < 3 ? { fields } : {}) };
  };
  const shape = visit(value, 0);
  return { bytes, fingerprint: hash.digest("hex").slice(0, 24), shape, bounded };
}

/** Only routing information, never commands, prompts, URL queries or content. */
export function diagnosticToolTarget(name: string, args: unknown): Record<string, string> {
  const result: Record<string, string> = { name };
  if (!object(args)) return result;
  for (const key of ["action", "server", "tool", "mode"] as const) {
    const value = args[key];
    if (typeof value === "string" && /^[\w.\/:\-]{1,160}$/.test(value)) result[key] = value;
  }
  if (["read", "write", "edit", "grep", "ls"].includes(name) && typeof args.path === "string") {
    result.path = args.path.slice(0, 1_000);
  }
  return result;
}

/** Remove literal argument values echoed by validation/backend errors, preserving field names. */
export function diagnosticArgumentValues(args: unknown): string[] {
  const values = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number, key?: string): void => {
    if (values.size >= 100 || depth > 6) return;
    if (typeof value === "string") {
      if (value.length >= 4 && !["action", "server", "tool", "mode", "path"].includes(key ?? "")) {
        const bounded = value.slice(0, 2_000);
        values.add(bounded);
        values.add(JSON.stringify(bounded).slice(1, -1));
      }
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [name, child] of Object.entries(value).slice(0, 100)) visit(child, depth + 1, name);
  };
  visit(args, 0);
  return [...values].sort((a, b) => b.length - a.length);
}

export function omitArgumentEchoes(message: string, values: readonly string[]): string {
  let result = message;
  for (const value of values) result = result.split(value).join("[argument value omitted]");
  return result;
}
