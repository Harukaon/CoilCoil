import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Read a browser's SQLite file without touching the browser's own copy.
 *
 * The source may be open in a running Chrome, which holds locks and may have
 * uncommitted pages in a write-ahead log. Opening it in place risks both a
 * `SQLITE_BUSY` and — far worse — writing a hot journal back into a file the
 * user's browser owns. Copying the database and its sidecars into a temporary
 * directory removes both risks; the copy is deleted before this returns.
 */
export function withDatabaseCopy<T>(source: string, read: (database: DatabaseSync) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-import-"));
  const target = join(directory, basename(source));
  try {
    copyFileSync(source, target);
    // The -wal file carries committed transactions that never reached the main
    // database; without it a recently written cookie is simply missing.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (existsSync(source + suffix)) copyFileSync(source + suffix, target + suffix);
    }
    const database = new DatabaseSync(target);
    try {
      return read(database);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Chromium timestamps are microseconds since 1601-01-01; JavaScript wants Unix seconds. */
export function chromiumTimeToUnixSeconds(value: number | bigint): number {
  const microseconds = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(microseconds) || microseconds <= 0) return 0;
  return Math.round(microseconds / 1_000_000 - 11_644_473_600);
}
