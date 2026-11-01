import type { DiagnosticLevel, DiagnosticLogEntry, DiagnosticProcess } from "@coilcoil/runtime-protocol";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  compressDiagnosticArchive, DEFAULT_ERROR_RETENTION_DAYS, DEFAULT_MAX_BYTES, DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_RETENTION_DAYS, listDiagnosticLogFiles, maintainDiagnosticArchives, positiveSetting, readDiagnosticLogFile,
  type DiagnosticRetentionOptions,
} from "./archive.js";
import { errorInfo, redact, redactText } from "./redact.js";
export { DEFAULT_MAX_BYTES } from "./archive.js";

const LEVEL_ORDER: Record<DiagnosticLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_ENTRY_BYTES = 96 * 1024;
const MAX_TAIL_FILES = 64;
const MAX_TAIL_READ_BYTES = 64 * 1024 * 1024;
const PROCESSES = new Set(["main", "renderer", "runtime", "memory"]);

export function levelFromEnvironment(value: string | undefined): DiagnosticLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

export interface DiagnosticLogOptions {
  directory: string;
  process: DiagnosticProcess;
  level?: DiagnosticLevel;
  maxBytes?: number;
  /** Combined budget including live streams. Live segments are never deleted. */
  maxTotalBytes?: number;
  retentionDays?: number;
  errorRetentionDays?: number;
  echo?: boolean;
}

interface StreamFile { path: string; bytes: number; }

/** Synchronous append for crash evidence; immutable segments compress asynchronously. */
export class DiagnosticLog {
  private readonly directory: string;
  private readonly process: DiagnosticProcess;
  private readonly maxBytes: number;
  private readonly retention: DiagnosticRetentionOptions;
  private readonly echo: boolean;
  private readonly stream: StreamFile;
  private readonly errors: StreamFile;
  private level: DiagnosticLevel;
  private disabled = false;
  private closed = false;
  private reportedArchiveFailure = false;
  private archiveSequence = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: DiagnosticLogOptions) {
    this.directory = options.directory;
    this.process = options.process;
    this.level = options.level ?? "info";
    this.maxBytes = positiveSetting(options.maxBytes ?? process.env.COILCOIL_LOG_MAX_BYTES, DEFAULT_MAX_BYTES);
    this.retention = {
      maxTotalBytes: positiveSetting(options.maxTotalBytes ?? process.env.COILCOIL_LOG_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES),
      retentionDays: positiveSetting(options.retentionDays ?? process.env.COILCOIL_LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
      errorRetentionDays: positiveSetting(options.errorRetentionDays ?? process.env.COILCOIL_LOG_ERROR_RETENTION_DAYS, DEFAULT_ERROR_RETENTION_DAYS),
    };
    this.echo = options.echo ?? false;
    const id = `${options.process}-${process.pid}-${Date.now()}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.stream = { path: join(options.directory, `${id}.jsonl`), bytes: 0 };
    this.errors = { path: join(options.directory, `${id}.errors.jsonl`), bytes: 0 };
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const existing = listDiagnosticLogFiles(this.directory);
      if (existing.some((file) => file.archived || (file.pid !== undefined && file.pid !== process.pid))) {
        this.pending = maintainDiagnosticArchives(this.directory, this.retention).catch(() => undefined);
      }
    } catch { this.disabled = true; }
  }

  get filePath(): string { return this.stream.path; }
  get errorsFilePath(): string { return this.errors.path; }
  setLevel(level: DiagnosticLevel): void { this.level = level; }
  enabled(level: DiagnosticLevel): boolean {
    return !this.disabled && !this.closed && LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  /** IPC entries pass the same redaction and bounds as local entries. */
  writeEntries(entries: readonly DiagnosticLogEntry[]): void {
    for (const entry of entries) {
      if (!entry || !this.enabled(entry.level) || !PROCESSES.has(entry.process)) continue;
      try {
        this.write({ ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(), level: entry.level, process: entry.process,
          scope: redactText(String(entry.scope), 200), event: redactText(String(entry.event), 200),
          ...(entry.runtimeId ? { runtimeId: redactText(String(entry.runtimeId)) } : {}),
          ...(entry.sessionPath ? { sessionPath: redactText(String(entry.sessionPath)) } : {}),
          ...(entry.data ? { data: redact(entry.data) } : {}), ...(entry.error ? { error: errorInfo(entry.error) } : {}) });
      } catch { /* A malformed IPC entry must not prevent later error entries. */ }
    }
  }

  log(level: DiagnosticLevel, scope: string, event: string, data?: Record<string, unknown>,
    context?: { runtimeId?: string; sessionPath?: string; error?: unknown }): void {
    if (!this.enabled(level)) return;
    try {
      this.write({ ts: Date.now(), level, process: this.process,
        scope: redactText(scope, 200), event: redactText(event, 200),
        ...(context?.runtimeId ? { runtimeId: redactText(context.runtimeId) } : {}),
        ...(context?.sessionPath ? { sessionPath: redactText(context.sessionPath) } : {}),
        ...(data ? { data: redact(data) } : {}), ...(context?.error !== undefined ? { error: errorInfo(context.error) } : {}) });
    } catch { /* Diagnostics must never interrupt the operation being diagnosed. */ }
  }

  debug(scope: string, event: string, data?: Record<string, unknown>, context?: { runtimeId?: string; sessionPath?: string }): void {
    this.log("debug", scope, event, data, context);
  }
  info(scope: string, event: string, data?: Record<string, unknown>, context?: { runtimeId?: string; sessionPath?: string }): void {
    this.log("info", scope, event, data, context);
  }
  warn(scope: string, event: string, data?: Record<string, unknown>, context?: { runtimeId?: string; sessionPath?: string }): void {
    this.log("warn", scope, event, data, context);
  }
  error(scope: string, event: string, error: unknown, data?: Record<string, unknown>, context?: { runtimeId?: string; sessionPath?: string }): void {
    this.log("error", scope, event, data, { ...context, error });
  }

  /**
   * Latest timestamps within a bounded window: live writers first, then recent
   * archives (at most 64 files / 64 MiB decoded). Source clocks can differ, so
   * filesystem mtime orders candidates but is never treated as a timestamp bound.
   */
  tail(limit = 200): DiagnosticLogEntry[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const count = Math.min(Math.floor(limit), 10_000);
    const parsed: DiagnosticLogEntry[] = [];
    const files = listDiagnosticLogFiles(this.directory).filter((file) => file.process === this.process && !file.errors);
    const compressedSources = new Set(files.filter((file) => file.compressed).map((file) => file.path.slice(0, -3)));
    const candidates = files.filter((file) => !compressedSources.has(file.path))
      .sort((left, right) => Number(left.archived) - Number(right.archived) || right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
      .slice(0, MAX_TAIL_FILES);
    const keepRecent = (): void => { parsed.sort((left, right) => right.ts - left.ts); parsed.splice(count); };
    let remainingBytes = MAX_TAIL_READ_BYTES;
    for (const file of candidates) {
      if (remainingBytes <= 0) break;
      const allowance = Math.min(remainingBytes, Math.max(32 * 1024 * 1024, this.maxBytes + MAX_ENTRY_BYTES));
      try {
        const content = readDiagnosticLogFile(file.path, allowance);
        remainingBytes -= Buffer.byteLength(content);
        for (const line of content.split("\n").reverse()) {
          try {
            const entry = JSON.parse(line) as DiagnosticLogEntry;
            if (Number.isFinite(entry.ts)) parsed.push(entry);
          } catch { /* Torn final lines are recoverable. */ }
          if (parsed.length >= count * 2) keepRecent();
        }
      } catch (error) {
        // A failed inflate may already have consumed its entire allowance.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") remainingBytes -= allowance;
      }
      keepRecent();
    }
    return parsed.reverse();
  }

  /** Appends are already on disk; await every pending compression and retention pass. */
  async flush(): Promise<void> {
    let pending: Promise<void>;
    do { pending = this.pending; await pending; } while (pending !== this.pending);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      try { this.rotate(this.stream); this.rotate(this.errors); } catch { /* The raw live file remains readable. */ }
      this.closed = true;
    }
    await this.flush();
  }

  private write(entry: DiagnosticLogEntry): void {
    let line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line) > MAX_ENTRY_BYTES) {
      entry.data = { omitted: "metadata exceeded entry limit", metadataBytes: Buffer.byteLength(JSON.stringify(entry.data ?? {})) };
      line = `${JSON.stringify(entry)}\n`;
    }
    // An error is never sampled. Its mirror has the longer retention policy.
    if (entry.level === "error") this.append(this.errors, line);
    this.append(this.stream, line);
    if (this.echo) console.error(`[${entry.process}/${entry.scope}] ${entry.event}${entry.error ? ` ${entry.error.message}` : ""}`);
  }

  private append(stream: StreamFile, line: string): void {
    try {
      if (stream.bytes > 0 && stream.bytes + Buffer.byteLength(line) > this.maxBytes) this.rotate(stream);
      appendFileSync(stream.path, line, { mode: 0o600 });
      stream.bytes += Buffer.byteLength(line);
    } catch { this.disabled = true; }
  }

  private rotate(stream: StreamFile): void {
    if (!stream.bytes) return;
    const sequence = (++this.archiveSequence).toString(16).padStart(8, "0");
    const archive = stream.path.replace(/\.jsonl$/, `.archive-${Date.now()}-${sequence}${randomUUID().replaceAll("-", "").slice(0, 12)}.jsonl`);
    renameSync(stream.path, archive);
    stream.bytes = 0;
    this.pending = this.pending.then(async () => {
      try { await compressDiagnosticArchive(archive); }
      catch (error) {
        if (!this.reportedArchiveFailure && !this.closed) {
          this.reportedArchiveFailure = true;
          this.error("diagnostics", "archive_compression_failed", error, { file: archive });
        }
      }
      await maintainDiagnosticArchives(this.directory, this.retention);
    }).catch(() => undefined);
  }
}
