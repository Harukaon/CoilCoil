import type {
  DiagnosticLevel,
  DiagnosticLogEntry,
  DiagnosticProcess,
} from "@coilcoil/runtime-protocol";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { errorInfo, redact } from "./redact.js";

const LEVEL_ORDER: Record<DiagnosticLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Past this the file rolls over. Two files per stream are kept. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function levelFromEnvironment(value: string | undefined): DiagnosticLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

export interface DiagnosticLogOptions {
  /** Directory to write into; created if missing. */
  directory: string;
  /** Which process is writing. Also names the file. */
  process: DiagnosticProcess;
  /** Entries below this level are dropped before any work is done. */
  level?: DiagnosticLevel;
  maxBytes?: number;
  /** Mirror every entry to stderr as well. On by default outside packaged apps. */
  echo?: boolean;
}

/**
 * An append-only JSONL log, one file per process, safe to call from anywhere.
 *
 * Writes are synchronous on purpose. The entries worth having are the last ones
 * before a crash or a hang, and a buffered writer loses exactly those. This is
 * affordable because the log is deliberately not on any hot path: state
 * transitions and errors, never the token stream — see `logStreamBatch` for how
 * high-frequency work is reported instead.
 *
 * Nothing here may throw. A log that breaks the app it is meant to explain is
 * worse than no log, so every failure is swallowed after disabling the writer.
 */
export class DiagnosticLog {
  private readonly directory: string;
  private readonly process: DiagnosticProcess;
  private readonly maxBytes: number;
  private readonly echo: boolean;
  private readonly file: string;
  private level: DiagnosticLevel;
  private disabled = false;
  private bytes = 0;

  constructor(options: DiagnosticLogOptions) {
    this.directory = options.directory;
    this.process = options.process;
    this.level = options.level ?? "info";
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.echo = options.echo ?? false;
    this.file = join(options.directory, `${options.process}.jsonl`);
    try {
      mkdirSync(this.directory, { recursive: true });
      this.bytes = statSync(this.file).size;
    } catch {
      // A missing file is the normal first-run case; anything else surfaces on
      // the first write, which is already guarded.
      this.bytes = 0;
    }
  }

  get filePath(): string {
    return this.file;
  }

  setLevel(level: DiagnosticLevel): void {
    this.level = level;
  }

  enabled(level: DiagnosticLevel): boolean {
    return !this.disabled && LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  /** Write entries produced elsewhere — the Renderer's, relayed through here. */
  writeEntries(entries: readonly DiagnosticLogEntry[]): void {
    if (this.disabled || entries.length === 0) return;
    const lines = entries
      .filter((entry) => LEVEL_ORDER[entry.level] >= LEVEL_ORDER[this.level])
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join("");
    if (lines) this.append(lines);
  }

  log(
    level: DiagnosticLevel,
    scope: string,
    event: string,
    data?: Record<string, unknown>,
    context?: { runtimeId?: string; sessionPath?: string; error?: unknown },
  ): void {
    if (!this.enabled(level)) return;
    const entry: DiagnosticLogEntry = {
      ts: Date.now(),
      level,
      process: this.process,
      scope,
      event,
      ...(context?.runtimeId ? { runtimeId: context.runtimeId } : {}),
      ...(context?.sessionPath ? { sessionPath: context.sessionPath } : {}),
      ...(data ? { data: redact(data) } : {}),
      ...(context?.error !== undefined ? { error: errorInfo(context.error) } : {}),
    };
    this.append(`${JSON.stringify(entry)}\n`);
    if (this.echo) {
      const suffix = entry.error ? ` ${entry.error.message}` : "";
      // eslint-disable-next-line no-console
      console.error(`[${entry.process}/${scope}] ${event}${suffix}`);
    }
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

  /** The most recent entries, oldest first — for a crash report or an export. */
  tail(limit = 200): DiagnosticLogEntry[] {
    const parsed: DiagnosticLogEntry[] = [];
    for (const line of this.readTailLines(limit)) {
      try {
        parsed.push(JSON.parse(line) as DiagnosticLogEntry);
      } catch {
        // A torn last line is expected when the process died mid-write.
      }
    }
    return parsed;
  }

  private readTailLines(limit: number): string[] {
    try {
      const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      return lines.slice(-limit);
    } catch {
      return [];
    }
  }

  private append(lines: string): void {
    try {
      if (this.bytes >= this.maxBytes) this.rotate();
      appendFileSync(this.file, lines);
      this.bytes += Buffer.byteLength(lines);
    } catch {
      // Out of disk, a read-only directory, a revoked permission — none of them
      // are worth taking the app down for, and retrying every entry would only
      // multiply the cost.
      this.disabled = true;
    }
  }

  private rotate(): void {
    const previous = `${this.file}.1`;
    try {
      rmSync(previous, { force: true });
      renameSync(this.file, previous);
    } catch {
      // Losing the rollover is survivable; losing the live file is not, so fall
      // back to truncating by starting the byte count over.
    }
    this.bytes = 0;
  }
}
