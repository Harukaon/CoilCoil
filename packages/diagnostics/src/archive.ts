import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import type { DiagnosticProcess } from "@coilcoil/runtime-protocol";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_ERROR_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const FILE_NAME = /^(main|runtime|renderer|memory)(?:-(\d+)-(\d+)-([a-f0-9]+))?(\.errors)?(?:\.archive-(\d+)-[a-f0-9]+)?\.jsonl(?:\.1)?(?:\.gz)?$/;

export interface DiagnosticRetentionOptions {
  maxTotalBytes: number;
  retentionDays: number;
  errorRetentionDays: number;
}

export interface DiagnosticLogFile {
  path: string;
  name: string;
  process: DiagnosticProcess;
  errors: boolean;
  compressed: boolean;
  archived: boolean;
  pid?: number;
  bytes: number;
  mtimeMs: number;
}

export function positiveSetting(value: number | string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Includes old fixed filenames, live streams, and immutable compressed archives. */
export function listDiagnosticLogFiles(directory: string): DiagnosticLogFile[] {
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  return names.flatMap((name): DiagnosticLogFile[] => {
    const match = FILE_NAME.exec(name);
    if (!match) return [];
    const path = join(directory, name);
    try {
      const info = statSync(path);
      if (!info.isFile()) return [];
      return [{ path, name, process: match[1] as DiagnosticProcess, pid: match[2] ? Number(match[2]) : undefined,
        errors: Boolean(match[5]), compressed: name.endsWith(".gz"),
        archived: Boolean(match[6]) || name.endsWith(".gz") || name.endsWith(".1"), bytes: info.size, mtimeMs: info.mtimeMs }];
    } catch { return []; } // Another process may have just completed a rotation.
  }).sort((left, right) => {
    const leftName = FILE_NAME.exec(left.name)!;
    const rightName = FILE_NAME.exec(right.name)!;
    // gzip timestamps can round filesystem sub-millisecond precision. Within
    // one writer, the rotation sequence is authoritative and live comes last.
    if (leftName.slice(1, 6).join("/") === rightName.slice(1, 6).join("/")) {
      if (Boolean(leftName[6]) !== Boolean(rightName[6])) return leftName[6] ? -1 : 1;
      if (leftName[6] && rightName[6]) return Number(leftName[6]) - Number(rightName[6]) || left.name.localeCompare(right.name);
    }
    return left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name);
  });
}

/** Bounded decompression protects report readers from damaged or oversized archives. */
export function readDiagnosticLogFile(path: string, maximumBytes = 32 * 1024 * 1024): string {
  const file = readFileSync(path);
  if (file.byteLength > maximumBytes) throw new Error("诊断日志超过读取上限。");
  return (path.endsWith(".gz") ? gunzipSync(file, { maxOutputLength: maximumBytes }) : file).toString("utf8");
}

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return true; // Legacy live streams have no reliable owner.
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Source is immutable after rotation. Failed compression always leaves it intact. */
export async function compressDiagnosticArchive(path: string): Promise<void> {
  const target = `${path}.gz`;
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const source = await stat(path);
    await pipeline(createReadStream(path), createGzip(), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await utimes(temporary, source.atime, source.mtime);
    await rename(temporary, target);
    await rm(path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** @internal Generations are claimed with O_EXCL; old owners never remove a successor. */
export async function acquireMaintenanceLock(directory: string): Promise<(() => Promise<void>) | undefined> {
  const lock = join(directory, ".archive-maintenance.lock");
  try { await mkdir(lock, { recursive: true }); } catch { return undefined; }
  const generationNames = (names: string[]): number[] => names.flatMap((name) => {
    const match = /^owner-(\d+)\.json$/.exec(name);
    return match ? [Number(match[1])] : [];
  });
  const names = await readdir(lock);
  const generation = Math.max(0, ...generationNames(names));
  const current = join(lock, generation ? `owner-${generation}.json` : "owner.json");
  try {
    const owner = JSON.parse(await readFile(current, "utf8")) as { pid?: number; token?: string };
    const released = generation && typeof owner.token === "string" && names.includes(`released-${generation}-${owner.token}`);
    if (!released && (typeof owner.pid !== "number" || processAlive(owner.pid))) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // An interrupted exclusive write may leave an empty owner file. A fresh
      // file may still be initializing and cannot be taken over yet.
      try { if (Date.now() - (await stat(current)).mtimeMs < 60_000) return undefined; }
      catch { return undefined; }
    }
  }
  const next = generation + 1;
  const token = randomUUID();
  try { await writeFile(join(lock, `owner-${next}.json`), JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 }); }
  catch { return undefined; }
  const claimedNames = await readdir(lock);
  // A delayed contender may recreate a pruned older generation. It must not
  // enter maintenance when a newer exclusive claim already exists.
  if (Math.max(...generationNames(claimedNames)) !== next) return undefined;
  await Promise.all(claimedNames.filter((name) => {
    const match = /^(?:owner|released)-(\d+)(?:\.json|-[a-f0-9-]+)$/.exec(name);
    return match && Number(match[1]) < next - 1;
  }).map((name) => rm(join(lock, name), { force: true }).catch(() => undefined)));
  return async () => {
    await writeFile(join(lock, `released-${next}-${token}`), "", { flag: "wx", mode: 0o600 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  };
}

/** One shared budget, with ordinary archives removed before error archives. */
export async function maintainDiagnosticArchives(directory: string, settings: DiagnosticRetentionOptions): Promise<void> {
  const release = await acquireMaintenanceLock(directory);
  if (!release) return;
  try {
    const protectedFiles = new Set<string>();
    for (const file of listDiagnosticLogFiles(directory)) {
      if (file.compressed || (file.pid !== undefined && processAlive(file.pid)) || (!file.archived && file.pid === undefined)) continue;
      try { await compressDiagnosticArchive(file.path); }
      catch { protectedFiles.add(file.path); }
    }
    const files = listDiagnosticLogFiles(directory);
    let total = files.reduce((bytes, file) => bytes + file.bytes, 0);
    const eligible = files.filter((file) => file.compressed || (file.archived && !processAlive(file.pid)))
      .filter((file) => !protectedFiles.has(file.path))
      .sort((left, right) => Number(left.errors) - Number(right.errors) || left.mtimeMs - right.mtimeMs);
    for (const file of eligible) {
      const retention = file.errors ? settings.errorRetentionDays : settings.retentionDays;
      if (Date.now() - file.mtimeMs <= retention * DAY_MS && total <= settings.maxTotalBytes) continue;
      try { await rm(file.path); total -= file.bytes; } catch { /* Another process may have removed it. */ }
    }
    // Incomplete gzip temporaries from a dead writer do not contain the only
    // copy: the immutable JSONL is retained until the final rename succeeds.
    for (const name of await readdir(directory)) {
      const match = /\.jsonl(?:\.1)?\.gz\.(\d+)-[a-f0-9-]+\.tmp$/.exec(name);
      if (match && !processAlive(Number(match[1]))) await rm(join(directory, name), { force: true });
    }
  } finally { await release(); }
}
