/**
 * Secrets, on the way to the model and back.
 *
 * The settings panel has always masked sensitive values before they cross IPC;
 * the Agent path did not, so `mcp get_json` handed a real `X-API-Key` straight
 * into the conversation — which is to say into the transcript, the session
 * file, the logs, and the provider. The same masking runs here.
 *
 * Masking is only half of it. A masked value that comes back on a save must
 * mean "unchanged", never the literal `••••••` — otherwise the first edit after
 * a read destroys the credential it was hiding.
 */
import { sensitiveConfigurationKey } from "./runtime-utils.js";

/** The panel's mask. Same six dots, so both surfaces speak one language. */
export const MASKED_SECRET_VALUE = "••••••";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Mask a `{ key: value }` map by key name, leaving ordinary values alone. */
export function maskSecretMap(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => (
    [key, sensitiveConfigurationKey(key) && value ? MASKED_SECRET_VALUE : value]
  )));
}

/** Put back whatever the mask was standing in for; `undefined` keeps the mask. */
export function restoreSecretMap(
  next: Record<string, string>,
  previous: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(next).map(([key, value]) => (
    [key, value === MASKED_SECRET_VALUE && previous[key] !== undefined ? previous[key]! : value]
  )));
}

/** A credential can also ride inside the address; mask those too. */
export function maskSecretUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = MASKED_SECRET_VALUE;
    for (const [key, value] of [...parsed.searchParams]) {
      if (sensitiveConfigurationKey(key) && value) parsed.searchParams.set(key, MASKED_SECRET_VALUE);
    }
    return parsed.toString();
  } catch {
    // An unparseable address is the user's own text; we do not rewrite it.
    return url;
  }
}

export function restoreSecretUrl(next: string | undefined, previous: string | undefined): string | undefined {
  if (!next?.includes(MASKED_SECRET_VALUE) || !previous) return next;
  try {
    const target = new URL(next);
    const source = new URL(previous);
    if (target.password === MASKED_SECRET_VALUE) target.password = source.password;
    for (const [key, value] of [...target.searchParams]) {
      if (value !== MASKED_SECRET_VALUE) continue;
      const original = source.searchParams.get(key);
      if (original === null) target.searchParams.delete(key);
      else target.searchParams.set(key, original);
    }
    return target.toString();
  } catch {
    return next;
  }
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * Mask every credential in a whole `mcp.json` document, text in, text out.
 *
 * Invalid JSON is handed back untouched: the document belongs to the user, and
 * a parser that rewrites what it cannot understand is worse than one that does
 * nothing. It cannot leak either — a file that will not parse has no servers
 * this masking would have covered anyway.
 */
export function maskMcpJsonText(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return content;
  const servers: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(parsed.mcpServers)) {
    if (!isRecord(definition)) {
      servers[name] = definition;
      continue;
    }
    const masked: Record<string, unknown> = { ...definition };
    if (isRecord(definition.env)) masked.env = maskSecretMap(stringMap(definition.env));
    if (isRecord(definition.headers)) masked.headers = maskSecretMap(stringMap(definition.headers));
    if (typeof definition.url === "string") masked.url = maskSecretUrl(definition.url);
    servers[name] = masked;
  }
  return `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`;
}

/**
 * Resolve the masks in an edited document against the one on disk.
 *
 * A mask with nothing behind it is refused rather than written: `••••••` in a
 * configuration file is a broken server with a puzzling 401, and the person who
 * typed it would have no idea where it came from.
 */
export function restoreMcpJsonText(nextContent: string, previousContent: string): string {
  if (!nextContent.includes(MASKED_SECRET_VALUE)) return nextContent;
  let next: unknown;
  try {
    next = JSON.parse(nextContent);
  } catch {
    // Let the caller's own validation report the syntax error.
    return nextContent;
  }
  let previous: unknown;
  try {
    previous = JSON.parse(previousContent);
  } catch {
    previous = undefined;
  }
  if (!isRecord(next) || !isRecord(next.mcpServers)) return nextContent;
  const previousServers = isRecord(previous) && isRecord(previous.mcpServers) ? previous.mcpServers : {};
  const servers: Record<string, unknown> = {};
  const unresolved: string[] = [];
  for (const [name, definition] of Object.entries(next.mcpServers)) {
    if (!isRecord(definition)) {
      servers[name] = definition;
      continue;
    }
    const before = isRecord(previousServers[name]) ? previousServers[name] as Record<string, unknown> : {};
    const restored: Record<string, unknown> = { ...definition };
    if (isRecord(definition.env)) restored.env = restoreSecretMap(stringMap(definition.env), stringMap(before.env));
    if (isRecord(definition.headers)) {
      restored.headers = restoreSecretMap(stringMap(definition.headers), stringMap(before.headers));
    }
    if (typeof definition.url === "string") {
      restored.url = restoreSecretUrl(definition.url, typeof before.url === "string" ? before.url : undefined);
    }
    for (const [key, value] of Object.entries(restored)) {
      if (typeof value === "string" && value.includes(MASKED_SECRET_VALUE)) unresolved.push(`${name}.${key}`);
      if (!isRecord(value)) continue;
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childValue === MASKED_SECRET_VALUE) unresolved.push(`${name}.${key}.${childKey}`);
      }
    }
    servers[name] = restored;
  }
  if (unresolved.length) {
    throw new Error(
      `这些字段还是掩码，没有可还原的原值，拒绝写入：${unresolved.join("、")}。要改就填真实值，不改就删掉这些字段。`,
    );
  }
  return `${JSON.stringify({ ...next, mcpServers: servers }, null, 2)}\n`;
}
