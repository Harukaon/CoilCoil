import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { WriteStream } from "node:fs";
import type { IDisposable, IPty } from "node-pty";

export const MAX_BUFFER_CHARS = 1_000_000;
export const RETAIN_BUFFER_CHARS = 800_000;
export const MAX_SCREEN_EVENTS = 2_000;
export const MAX_SCREEN_CHARS = 200_000;
export const DEFAULT_READ_LIMIT = 30_000;
export const MAX_COMPLETED_SESSIONS = 8;
export const COMPLETED_SESSION_TTL_MS = 30 * 60_000;
export const MAX_WAIT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_BLOCK_UNTIL_MS = 1_000;
export const MAX_FOREGROUND_WAIT_MS = 1_000;
export const DEFAULT_MONITOR_LIFETIME_MS = 5 * 60_000;
export const MAX_MONITOR_LIFETIME_MS = 30 * 60_000;
export const MAX_COMMAND_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFAULT_STALLED_MS = 60_000;
export const DEFAULT_STOP_TIMEOUT_MS = 3_000;
export const CLEANUP_POLL_MS = 100;
export const CLEANUP_VERIFY_MS = 750;

export const terminalParameters = Type.Object(
  {
    action: StringEnum(["start", "read", "await", "send", "stop", "list"] as const),
    id: Type.Optional(Type.String({ description: "Terminal id or unique name" })),
    command: Type.Optional(Type.String({ description: "Command to run for action=start" })),
    outputMode: Type.Optional(StringEnum(["screen", "log"] as const, {
      description: "Output mode for action=start: screen merges TUI redraw frames; log preserves line output",
    })),
    cwd: Type.Optional(Type.String({ description: "Working directory for action=start" })),
    name: Type.Optional(Type.String({ maxLength: 60, description: "Optional memorable name for action=start" })),
    cursor: Type.Optional(Type.Integer({ minimum: 0, description: "Output cursor returned by start/read" })),
    waitFor: Type.Optional(Type.String({ maxLength: 500, description: "Literal output condition; action=await registers a monitor and suspends until it matches or the process exits" })),
    timeoutMs: Type.Optional(Type.Integer({
      minimum: 0,
      maximum: MAX_WAIT_TIMEOUT_MS,
      description: "Short foreground wait for read/start (capped at 1000ms), or process cleanup deadline for stop. Ignored by event-driven await; never a process lifetime timeout",
    })),
    notifyOn: Type.Optional(StringEnum(["exit", "match", "stalled"] as const, {
      description: "For action=start, notify when the process exits, waitFor matches, or output stalls",
    })),
    stalledMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_WAIT_TIMEOUT_MS })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    input: Type.Optional(Type.String({ description: "Text sent to the PTY for action=send" })),
    enter: Type.Optional(Type.Boolean({ description: "Append Enter after input for action=send" })),
    key: Type.Optional(StringEnum([
      "enter", "ctrl-c", "ctrl-d", "tab", "escape", "up", "down", "left", "right",
    ] as const, { description: "Special key sent for action=send" })),
    force: Type.Optional(Type.Boolean({ description: "Immediately kill the process tree" })),
    clearExited: Type.Optional(Type.Boolean({ description: "For action=list, remove completed history" })),
    cols: Type.Optional(Type.Integer({ minimum: 20, maximum: 400 })),
    rows: Type.Optional(Type.Integer({ minimum: 5, maximum: 200 })),
  },
  { additionalProperties: false },
);

export const bashParameters = Type.Object(
  {
    command: Type.String({ description: "Shell command to execute" }),
    cwd: Type.Optional(Type.String({ description: "Working directory, relative to the project or absolute" })),
    is_background: Type.Optional(Type.Boolean({
      description: "Return immediately and keep the command running in a managed background terminal",
    })),
    block_until_ms: Type.Optional(Type.Integer({
      minimum: 0,
      maximum: MAX_FOREGROUND_WAIT_MS,
      default: DEFAULT_BLOCK_UNTIL_MS,
      description: "Optional short foreground window, at most 1000ms; longer commands continue in the background and notify on exit",
    })),
    timeout_ms: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: MAX_COMMAND_TIMEOUT_MS,
      description: "Optional hard process lifetime; unlike block_until_ms, reaching it stops the process",
    })),
    timeout: Type.Optional(Type.Number({
      exclusiveMinimum: 0,
      maximum: MAX_COMMAND_TIMEOUT_MS / 1_000,
      description: "Legacy hard process timeout in seconds; prefer timeout_ms",
    })),
    notify_on_output: Type.Optional(Type.String({
      maxLength: 500,
      description: "Regular expression that triggers an asynchronous notification when new output matches",
    })),
    output_mode: Type.Optional(StringEnum(["screen", "log"] as const, {
      description: "screen coalesces redraws; log preserves emitted lines",
    })),
    name: Type.Optional(Type.String({ maxLength: 60, description: "Optional memorable background shell name" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  },
  { additionalProperties: false },
);

export type TerminalParameters = Static<typeof terminalParameters>;
export type BashParameters = Static<typeof bashParameters>;
export const monitorParameters = Type.Object({
  action: Type.Optional(StringEnum(["start", "wait", "stop", "list"] as const, {
    description: "start creates a monitor (default); wait suspends for existing monitors; stop cancels one; list inspects monitors",
  })),
  command: Type.Optional(Type.String({ minLength: 1, description: "Background watcher command for start; print only actionable changes, one event per line. Mutually exclusive with terminalId" })),
  terminalId: Type.Optional(Type.String({ description: "Observe an existing managed terminal without starting a new command" })),
  description: Type.Optional(Type.String({ maxLength: 200, description: "What result or change this monitor is waiting for" })),
  event: Type.Optional(StringEnum(["exit", "output", "match"] as const, {
    description: "Defaults to exit for an existing terminal, output for a new watcher command; match uses literal waitFor",
  })),
  waitFor: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Literal output condition for event=match; process exit also reports a result" })),
  repeat: Type.Optional(Type.Boolean({ description: "Report multiple output/match events; defaults to true for output and false otherwise" })),
  suspend: Type.Optional(Type.Boolean({ description: "Default true: end this agent loop and resume automatically on an event. Set false only to continue independent work" })),
  id: Type.Optional(Type.String({ description: "Monitor id for stop, or one monitor to wait for" })),
  ids: Type.Optional(Type.Array(Type.String(), { maxItems: 32, description: "Monitors for wait; any one event resumes the agent. Omit to wait for all currently active monitors" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for a new watcher command" })),
  lifetime_ms: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_MONITOR_LIFETIME_MS, description: "Optional watcher-process safety lifetime, default 5 minutes. This does not block the agent and applies only to command monitors" })),
}, { additionalProperties: false });
export type MonitorParameters = Static<typeof monitorParameters>;
export type TerminalStatus = "running" | "exited" | "failed" | "stopped" | "cleanup_failed";
export type WaitOutcome = "matched" | "output" | "exit" | "timeout" | "aborted";
export type CleanupSignal = "SIGINT" | "SIGTERM" | "SIGKILL";
export type TerminalNotifyOn = "exit" | "match" | "regex" | "stalled" | "output";

export interface CleanupReport {
  forceRequested: boolean;
  gracefulAttempted: boolean;
  gracefulSucceeded: boolean;
  escalatedToSigkill: boolean;
  signal?: CleanupSignal;
  descendantsFound: number;
  targetedPids: number[];
  terminatedPids: number[];
  sigkillPids: number[];
  residualPids: number[];
  verified: boolean;
  enumerationError?: string;
  unverifiedPids?: number[];
}

export interface ProcessIdentity {
  pid: number;
  pgid: number;
  tty: string;
  birth: string;
}

export interface ProcessRecord extends ProcessIdentity {
  ppid: number;
  state: string;
}

export interface ProcessScan {
  table: Map<number, ProcessRecord>;
  owned: ProcessRecord[];
  rootAlive: boolean;
  unverifiedPids: number[];
}

export interface TerminalNotification {
  mode: TerminalNotifyOn;
  cursor: number;
  pattern?: string;
  regex?: RegExp;
  stalledMs?: number;
  fired: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface TerminalNotificationEvent {
  mode: TerminalNotifyOn;
  pattern?: string;
}

export interface ScreenEvent {
  revision: number;
  text: string;
  kind: "line" | "frame";
}

export interface ScreenState {
  line: string;
  cursor: number;
  ansiRemainder: string;
  revision: number;
  events: ScreenEvent[];
  frameEvent?: ScreenEvent;
}

export interface ManagedTerminal {
  id: string;
  ownerToolCallId: string;
  name: string;
  command: string;
  cwd: string;
  pid: number;
  pty: IPty;
  status: TerminalStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: number;
  stopRequested: boolean;
  timeoutRequested?: boolean;
  background: boolean;
  processIdentity?: ProcessIdentity;
  processDescendants?: Map<number, ProcessIdentity>;
  processScanPromise?: Promise<ProcessScan>;
  tty?: string;
  cleanup?: CleanupReport;
  cleanupPromise?: Promise<CleanupReport>;
  hardTimeoutTimer?: ReturnType<typeof setTimeout>;
  outputMode: "screen" | "log";
  outputPath: string;
  stderrPath?: string;
  outputStream?: WriteStream;
  buffer: string;
  bufferStart: number;
  outputEnd: number;
  defaultCursor: number;
  screen: ScreenState;
  lastOutputAt: number;
  notifications: TerminalNotification[];
  notifyEvent?: (event: TerminalNotificationEvent) => void;
  listeners: Set<() => void>;
  dataDisposable?: IDisposable;
  exitDisposable?: IDisposable;
}

export interface ReadSnapshot {
  output: string;
  cursor: number;
  startCursor: number;
  bufferStart: number;
  outputEnd: number;
  truncatedBeforeCursor: boolean;
  hasMore: boolean;
}

export const KEY_SEQUENCES: Record<NonNullable<TerminalParameters["key"]>, string> = {
  enter: "\r",
  "ctrl-c": "\u0003",
  "ctrl-d": "\u0004",
  tab: "\t",
  escape: "\u001b",
  up: "\u001b[A",
  down: "\u001b[B",
  left: "\u001b[D",
  right: "\u001b[C",
};

export interface StartRequest {
  ownerToolCallId: string;
  command: string;
  cwd?: string;
  name?: string;
  outputMode: "screen" | "log";
  initialBackground: boolean;
  waitFor?: string;
  waitTimeoutMs: number;
  waitForExitOnly: boolean;
  hardTimeoutMs?: number;
  notifyOn?: "exit" | "match" | "stalled";
  notifyOutputRegex?: string;
  stalledMs?: number;
  limit?: number;
  cols?: number;
  rows?: number;
  autoNotifyExit: boolean;
  captureStderr?: boolean;
  onUpdate?: (result: {
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  }) => void;
}

export interface StartResult {
  session: ManagedTerminal;
  wait: WaitOutcome;
  poppedOutIntoBackground: boolean;
  output: string;
  cursor: number;
  hasMore: boolean;
}
