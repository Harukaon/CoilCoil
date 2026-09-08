import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve as resolvePath } from "node:path";

/**
 * List a workspace's sessions without reading every session on the machine.
 *
 * Pi answers "which sessions are there" by streaming **every line of every
 * session file**, and only then discarding the ones belonging to other
 * workspaces. It also builds an `allMessagesText` for each — every message of
 * every conversation concatenated — which CoilCoil has never used. On this
 * machine that was 285 files and 398 MB read on each call, to display four
 * sessions.
 *
 * The workspace a session belongs to is on its **first line**. So the sweep
 * reads one line per file to decide what is relevant, and only the survivors —
 * a handful — are read through for the things that genuinely need a scan: the
 * message count, the first message, the time of the last activity.
 *
 * Pi already knows this trick; `findMostRecentSession` uses exactly it. Only
 * `list` does not, and `list` is what the workspace picker calls.
 */

/** What CoilCoil's session list actually shows. Deliberately a subset of Pi's. */
export interface SessionListEntry {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

interface SessionHeaderLine {
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  parentSession?: unknown;
  type?: unknown;
}

/**
 * Reading a whole line at a time still streams the file, so the header read
 * stops the stream as soon as it has what it came for. A session file's first
 * line is small; the rest of it can be hundreds of megabytes.
 */
async function readFirstLine(path: string): Promise<string | undefined> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) return line;
    return undefined;
  } finally {
    reader.close();
    stream.destroy();
  }
}

function parseJson(line: string | undefined): SessionHeaderLine | undefined {
  if (!line) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as SessionHeaderLine : undefined;
  } catch {
    return undefined;
  }
}

/** Same rule Pi applies: a session belongs to the workspace its header names. */
export function sessionBelongsTo(headerCwd: unknown, resolvedCwd: string): boolean {
  return typeof headerCwd === "string" && headerCwd !== "" && resolvePath(headerCwd) === resolvedCwd;
}

function textOfMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; text?: string };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("");
}

/**
 * When a message counts as activity, matching Pi's rule exactly.
 *
 * Only what a person or the model actually said moves the clock — tool traffic
 * does not — and the message's own timestamp wins over the entry's. Getting this
 * wrong does not fail loudly: it quietly reorders the session list and shows the
 * wrong "last used" time.
 */
function activityTimeOf(entry: Record<string, unknown>): number | undefined {
  const message = entry.message;
  if (!message || typeof message !== "object" || !("content" in message)) return undefined;
  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") return undefined;

  const own = (message as { timestamp?: unknown }).timestamp;
  if (typeof own === "number") return own;
  const entryTime = entry.timestamp;
  if (typeof entryTime === "string" || typeof entryTime === "number") {
    const parsed = new Date(entryTime).getTime();
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Read one session through for the parts that cannot be known any other way.
 *
 * `allMessagesText` is deliberately not built. Pi accumulates it for its own
 * search; nothing in CoilCoil reads it, and it is most of what made listing
 * expensive in memory as well as in time.
 */
export async function readSessionDetail(path: string): Promise<SessionListEntry | undefined> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
  } catch {
    return undefined;
  }
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let header: SessionHeaderLine | undefined;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let lastActivityTime: number | undefined;
  try {
    for await (const line of reader) {
      const entry = parseJson(line) as (Record<string, unknown> & SessionHeaderLine) | undefined;
      if (!entry) continue;
      if (!header) {
        // A file whose first entry is not a session header is not a session.
        if (entry.type !== "session") return undefined;
        header = entry;
        continue;
      }
      if (entry.type === "session_info") {
        const candidate = entry.name;
        name = typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
        continue;
      }
      if (entry.type !== "message") continue;
      messageCount += 1;
      const activity = activityTimeOf(entry);
      if (typeof activity === "number") lastActivityTime = Math.max(lastActivityTime ?? 0, activity);
      if (firstMessage) continue;
      const message = entry.message as { role?: unknown } | undefined;
      if (!message || message.role !== "user") continue;
      const text = textOfMessage(message);
      if (text) firstMessage = text;
    }
  } catch {
    return undefined;
  } finally {
    reader.close();
    stream.destroy();
  }
  if (!header) return undefined;

  const headerTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
  return {
    path,
    id: typeof header.id === "string" ? header.id : "",
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
    created: Number.isNaN(headerTime) ? stats.mtime : new Date(headerTime),
    modified: lastActivityTime && lastActivityTime > 0
      ? new Date(lastActivityTime)
      : Number.isNaN(headerTime) ? stats.mtime : new Date(headerTime),
    messageCount,
    firstMessage: firstMessage || "(no messages)",
  };
}

/** Read enough files at once to keep the disk busy, without opening hundreds. */
const SWEEP_CONCURRENCY = 16;

async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      results.push(await work(next));
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Every session belonging to one workspace, newest first.
 *
 * Two passes on purpose: one line per file to find out what is relevant, then a
 * full read of only those. The first pass is what used to be the whole cost.
 */
export async function listSessionsForCwd(sessionDir: string, cwd: string): Promise<SessionListEntry[]> {
  const resolvedCwd = resolvePath(cwd);
  let names: string[];
  try {
    names = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const candidates = await mapLimited(names, SWEEP_CONCURRENCY, async (name) => {
    const path = join(sessionDir, name);
    const header = parseJson(await readFirstLine(path).catch(() => undefined));
    return header && sessionBelongsTo(header.cwd, resolvedCwd) ? path : undefined;
  });

  const detailed = await mapLimited(
    candidates.filter((path): path is string => Boolean(path)),
    SWEEP_CONCURRENCY,
    (path) => readSessionDetail(path),
  );
  return detailed
    .filter((entry): entry is SessionListEntry => Boolean(entry))
    .sort((first, second) => second.modified.getTime() - first.modified.getTime());
}
