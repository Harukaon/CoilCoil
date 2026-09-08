import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Stop re-reading every session on disk to answer "which sessions are there".
 *
 * Pi builds its session list by streaming **every line of every session file** —
 * it needs the message count and the first message, and those are only knowable
 * by reading. On a machine with a few hundred sessions that is hundreds of
 * megabytes of JSONL parsed per call, and opening a workspace calls it more than
 * once. Measured on the user's Mac: 285 files, 398 MB, about a second each time,
 * and it grows with every conversation they ever have.
 *
 * Stat-ing the same files costs two milliseconds. Sessions are append-only, so
 * size and mtime together say everything about whether a listing could have
 * changed: same signature, same answer. The expensive read happens once and then
 * only when something has actually moved.
 *
 * Concurrent callers share one computation as well. The burst at startup is
 * several callers asking the same question at the same moment, and letting each
 * of them do the full scan is the worst version of this.
 */

export interface SessionListingLoader<T> {
  (): Promise<T[]>;
}

/**
 * A cheap description of a directory's contents.
 *
 * Names, sizes and modification times only — never contents. A session that
 * gained a line changed size; one that was rewritten in place changed mtime; one
 * that appeared or vanished changed the name list. Nothing else about a session
 * file can change without one of the three moving.
 */
export function directorySignature(directory: string): string {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    // A missing directory is a stable state of its own, and a real answer:
    // there are no sessions.
    return "missing";
  }
  const parts: string[] = [];
  for (const name of names) {
    try {
      const stats = statSync(join(directory, name));
      parts.push(`${name}:${stats.size}:${Math.round(stats.mtimeMs)}`);
    } catch {
      // Disappeared between the listing and the stat; its absence is itself
      // part of the signature.
      parts.push(`${name}:gone`);
    }
  }
  return parts.join("|");
}

export class SessionListingCache<T> {
  private signature?: string;
  private readonly cached = new Map<string, T[]>();
  private readonly inFlight = new Map<string, Promise<T[]>>();

  /**
   * Answer from cache when the directory has not moved, otherwise load once.
   *
   * `key` separates callers that want different slices of the same directory —
   * the listing is filtered by workspace, so two projects sharing a session
   * directory must not be served each other's answer.
   */
  async list(key: string, directory: string, load: SessionListingLoader<T>): Promise<T[]> {
    const signature = directorySignature(directory);
    if (signature !== this.signature) {
      // Anything on disk moved, so every slice of it is suspect, not just this
      // one. Dropping the lot is correct and costs one rebuild per project.
      this.signature = signature;
      this.cached.clear();
    }
    const hit = this.cached.get(key);
    if (hit) return hit;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = load().then((result) => {
      // Only keep it if the directory still looks the way it did when this
      // started; a session written mid-scan would otherwise be cached away.
      if (this.signature === signature) this.cached.set(key, result);
      return result;
    }).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  /** Forget everything, for a caller that knows it just changed the directory. */
  invalidate(): void {
    this.signature = undefined;
    this.cached.clear();
  }
}
