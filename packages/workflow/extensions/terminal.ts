import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { IDisposable, IPty } from "node-pty";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import {
  redactSecrets,
  resolveSecretEnvironment,
  type SecretEnvironmentInput,
} from "./secret-store.ts";

const MAX_BUFFER_CHARS = 1_000_000;
const RETAIN_BUFFER_CHARS = 800_000;
const MAX_SCREEN_EVENTS = 2_000;
const MAX_SCREEN_CHARS = 200_000;
const DEFAULT_READ_LIMIT = 30_000;
const MAX_COMPLETED_SESSIONS = 8;
const COMPLETED_SESSION_TTL_MS = 30 * 60_000;
const MAX_WAIT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_STALLED_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const CLEANUP_POLL_MS = 100;
const CLEANUP_VERIFY_MS = 750;
const execFileAsync = promisify(execFile);

const terminalParameters = Type.Object(
  {
    action: StringEnum(["start", "read", "await", "send", "stop", "list"] as const),
    id: Type.Optional(
      Type.String({ description: "Terminal id or unique name" }),
    ),
    command: Type.Optional(
      Type.String({ description: "Command to run for action=start" }),
    ),
    outputMode: Type.Optional(
      StringEnum(["screen", "log"] as const, {
        description:
          "Output mode for action=start: screen merges TUI redraw frames; log preserves line output",
      }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Working directory for action=start" }),
    ),
    name: Type.Optional(
      Type.String({
        maxLength: 60,
        description: "Optional memorable name for action=start",
      }),
    ),
    cursor: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Output cursor returned by start/read",
      }),
    ),
    waitFor: Type.Optional(
      Type.String({
        maxLength: 500,
        description: "Wait until this literal text appears in new output",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_WAIT_TIMEOUT_MS,
        description: "Maximum wait time for read/start/await/stop (up to 30 minutes)",
      }),
    ),
    notifyOn: Type.Optional(
      StringEnum(["exit", "match", "stalled"] as const, {
        description:
          "For action=start, send an asynchronous agent event when the process exits, waitFor matches, or output stalls",
      }),
    ),
    stalledMs: Type.Optional(
      Type.Integer({
        minimum: 1_000,
        maximum: MAX_WAIT_TIMEOUT_MS,
        description: "Silence duration for notifyOn=stalled (default 60000)",
      }),
    ),
    secretEnv: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description:
          "For action=start, map environment variable names to pre-registered secret handles; secret values never enter the model",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100_000,
        description: "Maximum output characters returned by read/start",
      }),
    ),
    input: Type.Optional(
      Type.String({ description: "Text sent to the PTY for action=send" }),
    ),
    enter: Type.Optional(
      Type.Boolean({ description: "Append Enter after input for action=send" }),
    ),
    key: Type.Optional(
      StringEnum(
        [
          "enter",
          "ctrl-c",
          "ctrl-d",
          "tab",
          "escape",
          "up",
          "down",
          "left",
          "right",
        ] as const,
        { description: "Special key sent for action=send" },
      ),
    ),
    force: Type.Optional(
      Type.Boolean({ description: "Immediately kill the process tree" }),
    ),
    clearExited: Type.Optional(
      Type.Boolean({
        description: "For action=list, remove completed session history",
      }),
    ),
    cols: Type.Optional(Type.Integer({ minimum: 20, maximum: 400 })),
    rows: Type.Optional(Type.Integer({ minimum: 5, maximum: 200 })),
  },
  { additionalProperties: false },
);

type TerminalParameters = Static<typeof terminalParameters>;
type TerminalStatus =
  | "running"
  | "exited"
  | "failed"
  | "stopped"
  | "cleanup_failed";
type WaitOutcome = "matched" | "output" | "exit" | "timeout" | "aborted";

type CleanupSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

interface CleanupReport {
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
}

interface ProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  sessionId: number;
  state: string;
  tty: string;
}

interface ProcessScan {
  table: Map<number, ProcessRecord>;
  owned: ProcessRecord[];
  rootAlive: boolean;
}

interface ManagedTerminal {
  id: string;
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
  processSessionId?: number;
  tty?: string;
  cleanup?: CleanupReport;
  cleanupPromise?: Promise<CleanupReport>;
  outputMode: "screen" | "log";
  secretValues: string[];
  secretHandles: string[];
  redactionCarry: string;
  buffer: string;
  bufferStart: number;
  outputEnd: number;
  defaultCursor: number;
  screen: ScreenState;
  lastOutputAt: number;
  notification?: TerminalNotification;
  notifyEvent?: (event: TerminalNotificationEvent) => void;
  listeners: Set<() => void>;
  dataDisposable?: IDisposable;
  exitDisposable?: IDisposable;
}

type TerminalNotifyOn = "exit" | "match" | "stalled";

interface TerminalNotification {
  mode: TerminalNotifyOn;
  cursor: number;
  pattern?: string;
  stalledMs?: number;
  fired: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface TerminalNotificationEvent {
  mode: TerminalNotifyOn;
  pattern?: string;
}

interface ScreenEvent {
  revision: number;
  text: string;
  kind: "line" | "frame";
}

interface ScreenState {
  line: string;
  cursor: number;
  ansiRemainder: string;
  revision: number;
  events: ScreenEvent[];
  frameEvent?: ScreenEvent;
}

interface ReadSnapshot {
  output: string;
  cursor: number;
  startCursor: number;
  bufferStart: number;
  outputEnd: number;
  truncatedBeforeCursor: boolean;
  hasMore: boolean;
}

const KEY_SEQUENCES: Record<NonNullable<TerminalParameters["key"]>, string> = {
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

let ptyModulePromise: Promise<typeof import("node-pty")> | undefined;

function isRunning(session: ManagedTerminal): boolean {
  return session.status === "running";
}

function cleanTerminalOutput(data: string): string {
  return stripVTControlCharacters(data)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0008/g, "");
}

function createScreenState(): ScreenState {
  return {
    line: "",
    cursor: 0,
    ansiRemainder: "",
    revision: 0,
    events: [],
  };
}

function screenEventCharacters(state: ScreenState): number {
  return state.events.reduce((total, event) => total + event.text.length, 0);
}

function trimScreenEvents(state: ScreenState): void {
  while (
    state.events.length > MAX_SCREEN_EVENTS ||
    (screenEventCharacters(state) > MAX_SCREEN_CHARS &&
      state.events.length > 1)
  ) {
    const removed = state.events.shift();
    if (removed === state.frameEvent) state.frameEvent = undefined;
  }

  const onlyEvent = state.events[0];
  if (
    state.events.length === 1 &&
    onlyEvent &&
    onlyEvent.text.length > MAX_SCREEN_CHARS
  ) {
    onlyEvent.text = onlyEvent.text.slice(-MAX_SCREEN_CHARS);
  }
}

function updateScreenFrame(session: ManagedTerminal): void {
  const state = session.screen;
  const text = state.line.replace(/[ \t]+$/g, "");
  if (state.frameEvent?.text === text) return;

  state.revision += 1;
  if (state.frameEvent) {
    state.frameEvent.text = text;
    state.frameEvent.revision = state.revision;
  } else {
    state.frameEvent = { revision: state.revision, text, kind: "frame" };
    state.events.push(state.frameEvent);
  }
  session.outputEnd = state.revision;
  trimScreenEvents(state);
}

function commitScreenLine(session: ManagedTerminal): void {
  const state = session.screen;
  if (state.frameEvent) {
    const index = state.events.indexOf(state.frameEvent);
    if (index >= 0) state.events.splice(index, 1);
    state.frameEvent = undefined;
  }

  state.revision += 1;
  state.events.push({
    revision: state.revision,
    text: state.line.replace(/[ \t]+$/g, ""),
    kind: "line",
  });
  state.line = "";
  state.cursor = 0;
  session.outputEnd = state.revision;
  trimScreenEvents(state);
}

function writeScreenCharacter(state: ScreenState, character: string): void {
  if (state.cursor > state.line.length) {
    state.line += " ".repeat(state.cursor - state.line.length);
  }
  if (state.cursor === state.line.length) {
    state.line += character;
  } else {
    state.line =
      state.line.slice(0, state.cursor) +
      character +
      state.line.slice(state.cursor + character.length);
  }
  state.cursor += character.length;
}

function numberParam(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function handleCsiSequence(state: ScreenState, sequence: string): void {
  const final = sequence.at(-1);
  if (!final) return;
  const body = sequence.slice(2, -1).replace(/^\?/, "");
  const first = numberParam(body.split(";")[0], 1);

  switch (final) {
    case "K":
      if (first === 2 || first === 3) {
        state.line = "";
        state.cursor = 0;
      } else if (first === 1) {
        state.line = " ".repeat(Math.min(state.cursor, state.line.length)) + state.line.slice(state.cursor);
      } else {
        state.line = state.line.slice(0, state.cursor);
      }
      return;
    case "G":
    case "`":
      state.cursor = Math.max(0, first - 1);
      return;
    case "C":
    case "a":
      state.cursor += Math.max(1, first);
      return;
    case "D":
      state.cursor = Math.max(0, state.cursor - Math.max(1, first));
      return;
    case "A":
      // Rich-style multi-line redraws are represented as a fresh frame. The
      // one-line coalescer intentionally keeps the latest stable frame.
      state.line = "";
      state.cursor = 0;
      return;
    case "J":
      if (first === 2 || first === 3) {
        state.line = "";
        state.cursor = 0;
      }
      return;
    default:
      // SGR, cursor visibility, and unsupported terminal modes do not affect
      // the textual snapshot.
      return;
  }
}

function consumeScreenOutput(session: ManagedTerminal, rawData: string): void {
  const state = session.screen;
  const data = state.ansiRemainder + rawData;
  state.ansiRemainder = "";
  let changed = false;
  let committed = false;

  for (let index = 0; index < data.length;) {
    const character = data[index];

    if (character === "\u001b") {
      if (index + 1 >= data.length) {
        state.ansiRemainder = data.slice(index);
        break;
      }

      const next = data[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < data.length) {
          const code = data.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) break;
          end += 1;
        }
        if (end >= data.length) {
          state.ansiRemainder = data.slice(index);
          break;
        }
        handleCsiSequence(state, data.slice(index, end + 1));
        changed = true;
        index = end + 1;
        continue;
      }

      if (next === "]") {
        let end = index + 2;
        let terminated = false;
        while (end < data.length) {
          if (data[end] === "\u0007") {
            end += 1;
            terminated = true;
            break;
          }
          if (data[end] === "\u001b" && data[end + 1] === "\\") {
            end += 2;
            terminated = true;
            break;
          }
          end += 1;
        }
        if (!terminated) {
          state.ansiRemainder = data.slice(index);
          break;
        }
        index = end;
        continue;
      }

      index += 2;
      continue;
    }

    if (character === "\r") {
      state.cursor = 0;
      changed = true;
      index += 1;
      continue;
    }
    if (character === "\n" || character === "\f" || character === "\v") {
      commitScreenLine(session);
      committed = true;
      changed = false;
      index += 1;
      continue;
    }
    if (character === "\b") {
      state.cursor = Math.max(0, state.cursor - 1);
      changed = true;
      index += 1;
      continue;
    }
    if (character === "\t") {
      const spaces = 8 - (state.cursor % 8);
      writeScreenCharacter(state, " ".repeat(spaces));
      changed = true;
      index += 1;
      continue;
    }
    if (character < " ") {
      index += 1;
      continue;
    }

    writeScreenCharacter(state, character);
    changed = true;
    index += 1;
  }

  if (changed || state.frameEvent) updateScreenFrame(session);
  if (changed || committed || state.frameEvent) {
    session.lastOutputAt = Date.now();
    scheduleStalledNotification(session);
    notifyListeners(session);
  }
}

function flushScreenOutput(session: ManagedTerminal): void {
  const state = session.screen;
  if (state.ansiRemainder) state.ansiRemainder = "";
  if (state.line.length > 0 || state.frameEvent) commitScreenLine(session);
}

function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;

  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("node-pty");
    const packageRoot = resolve(dirname(entry), "..");
    const candidates = [
      resolve(
        packageRoot,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper",
      ),
      resolve(packageRoot, "build", "Release", "spawn-helper"),
    ];

    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const mode = statSync(candidate).mode;
      if ((mode & 0o100) === 0) chmodSync(candidate, mode | 0o755);
    }
  } catch {
    // node-pty will provide the actionable load/spawn error below.
  }
}

async function loadPty(): Promise<typeof import("node-pty")> {
  ensureSpawnHelperExecutable();
  ptyModulePromise ??= import("node-pty");
  return ptyModulePromise;
}

function notifyListeners(session: ManagedTerminal): void {
  for (const listener of [...session.listeners]) listener();
  checkNotification(session);
}

function redactTerminalChunk(session: ManagedTerminal, rawData: string): string {
  if (session.secretValues.length === 0) return rawData;

  const combined = session.redactionCarry + rawData;
  const secrets = session.secretValues
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let output = "";
  let index = 0;

  while (index < combined.length) {
    const matched = secrets.find((secret) => combined.startsWith(secret, index));
    if (matched) {
      output += "[REDACTED]";
      index += matched.length;
      continue;
    }

    const remaining = combined.slice(index);
    const couldCompleteInNextChunk = secrets.some(
      (secret) => remaining.length < secret.length && secret.startsWith(remaining),
    );
    if (couldCompleteInNextChunk) break;

    output += combined[index];
    index += 1;
  }

  session.redactionCarry = combined.slice(index);
  return output;
}

function flushRedaction(session: ManagedTerminal): string {
  if (!session.redactionCarry) return "";
  const pending = redactSecrets(session.redactionCarry, session.secretValues);
  session.redactionCarry = "";
  return pending;
}

function appendLogOutput(session: ManagedTerminal, rawData: string): void {
  const data = cleanTerminalOutput(rawData);
  if (!data) return;

  session.buffer += data;
  session.outputEnd += data.length;

  if (session.buffer.length > MAX_BUFFER_CHARS) {
    const trimCount = session.buffer.length - RETAIN_BUFFER_CHARS;
    session.buffer = session.buffer.slice(trimCount);
    session.bufferStart += trimCount;
  }

  session.lastOutputAt = Date.now();
  scheduleStalledNotification(session);
  notifyListeners(session);
}

function appendOutput(session: ManagedTerminal, rawData: string): void {
  const redacted = redactTerminalChunk(session, rawData);
  if (!redacted) return;
  if (session.outputMode === "screen") {
    consumeScreenOutput(session, redacted);
    return;
  }
  appendLogOutput(session, redacted);
}

function screenOutputSince(session: ManagedTerminal, requestedCursor: number): string {
  return session.screen.events
    .filter((event) => event.revision > requestedCursor)
    .map((event) => event.text)
    .join("\n");
}

function snapshotOutput(
  session: ManagedTerminal,
  requestedCursor: number,
  limit: number,
): ReadSnapshot {
  if (session.outputMode === "screen") {
    const firstEvent = session.screen.events[0];
    const truncatedBeforeCursor =
      firstEvent !== undefined && requestedCursor < firstEvent.revision - 1;
    let output = screenOutputSince(session, requestedCursor);
    let truncated = truncatedBeforeCursor;
    if (output.length > limit) {
      output = output.slice(-limit);
      truncated = true;
    }
    return {
      output,
      cursor: session.screen.revision,
      startCursor: requestedCursor,
      bufferStart: firstEvent?.revision ?? session.screen.revision,
      outputEnd: session.screen.revision,
      truncatedBeforeCursor: truncated,
      hasMore: false,
    };
  }

  const truncatedBeforeCursor = requestedCursor < session.bufferStart;
  const startCursor = Math.max(
    session.bufferStart,
    Math.min(requestedCursor, session.outputEnd),
  );
  const startIndex = startCursor - session.bufferStart;
  const available = session.buffer.slice(startIndex);
  const output = available.slice(0, limit);
  const cursor = startCursor + output.length;

  return {
    output,
    cursor,
    startCursor,
    bufferStart: session.bufferStart,
    outputEnd: session.outputEnd,
    truncatedBeforeCursor,
    hasMore: cursor < session.outputEnd,
  };
}

function outputSince(session: ManagedTerminal, requestedCursor: number): string {
  if (session.outputMode === "screen") {
    return screenOutputSince(session, requestedCursor);
  }

  const startCursor = Math.max(
    session.bufferStart,
    Math.min(requestedCursor, session.outputEnd),
  );
  return session.buffer.slice(startCursor - session.bufferStart);
}

function clearNotificationTimer(session: ManagedTerminal): void {
  const timer = session.notification?.timer;
  if (timer) clearTimeout(timer);
  if (session.notification) session.notification.timer = undefined;
}

function fireNotification(
  session: ManagedTerminal,
  event: TerminalNotificationEvent,
): void {
  const notification = session.notification;
  if (!notification || notification.fired) return;
  notification.fired = true;
  clearNotificationTimer(session);
  session.notifyEvent?.(event);
}

function checkNotification(session: ManagedTerminal): void {
  const notification = session.notification;
  if (!notification || notification.fired) return;

  if (!isRunning(session) && notification.mode === "stalled") {
    notification.fired = true;
    clearNotificationTimer(session);
    return;
  }

  if (notification.mode === "exit" && !isRunning(session)) {
    fireNotification(session, { mode: "exit" });
    return;
  }

  if (
    notification.mode === "match" &&
    notification.pattern &&
    outputSince(session, notification.cursor).includes(notification.pattern)
  ) {
    fireNotification(session, {
      mode: "match",
      pattern: notification.pattern,
    });
  }
}

function scheduleStalledNotification(session: ManagedTerminal): void {
  const notification = session.notification;
  if (!notification || notification.mode !== "stalled" || notification.fired) {
    return;
  }

  clearNotificationTimer(session);
  const stalledMs = notification.stalledMs ?? DEFAULT_STALLED_MS;
  notification.timer = setTimeout(() => {
    if (isRunning(session) && Date.now() - session.lastOutputAt >= stalledMs) {
      fireNotification(session, { mode: "stalled" });
    } else if (!notification.fired) {
      scheduleStalledNotification(session);
    }
  }, stalledMs);
}

async function waitForTerminalExit(
  session: ManagedTerminal,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<WaitOutcome> {
  if (!isRunning(session)) return "exit";
  if (timeoutMs <= 0) return "timeout";

  return new Promise<WaitOutcome>((resolveWait) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      session.listeners.delete(onChange);
      signal?.removeEventListener("abort", onAbort);
      resolveWait(outcome);
    };
    const onChange = (): void => {
      if (!isRunning(session)) finish("exit");
    };
    const onAbort = (): void => finish("aborted");

    timer = setTimeout(() => finish("timeout"), timeoutMs);
    session.listeners.add(onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    onChange();
  });
}

async function waitForTerminal(
  session: ManagedTerminal,
  cursor: number,
  waitFor: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<WaitOutcome> {
  const check = (): WaitOutcome | undefined => {
    const output = outputSince(session, cursor);
    if (waitFor && output.includes(waitFor)) return "matched";
    if (!waitFor && output.length > 0) return "output";
    if (!isRunning(session)) return "exit";
    if (signal?.aborted) return "aborted";
    return undefined;
  };

  const immediate = check();
  if (immediate) return immediate;
  if (timeoutMs <= 0) return "timeout";

  return new Promise<WaitOutcome>((resolveWait) => {
    let settled = false;

    const finish = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.listeners.delete(onChange);
      signal?.removeEventListener("abort", onAbort);
      resolveWait(outcome);
    };

    const onChange = (): void => {
      const outcome = check();
      if (outcome) finish(outcome);
    };
    const onAbort = (): void => finish("aborted");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    session.listeners.add(onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    onChange();
  });
}

async function waitForExit(
  session: ManagedTerminal,
  timeoutMs: number,
): Promise<boolean> {
  if (!isRunning(session)) return true;
  const outcome = await waitForTerminal(
    session,
    session.outputEnd,
    "\u0000__never_matches__",
    timeoutMs,
    undefined,
  );
  return outcome === "exit";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processIsAlive(record: ProcessRecord | undefined): boolean {
  return record !== undefined && !record.state.includes("Z");
}

async function readProcessTable(): Promise<Map<number, ProcessRecord>> {
  if (process.platform === "win32") return new Map();

  const sessionKeyword = process.platform === "darwin" ? "sess" : "sid";
  const selection = process.platform === "darwin" ? "-axo" : "-eo";
  const { stdout } = await execFileAsync(
    "/bin/ps",
    [selection, `pid=,ppid=,pgid=,${sessionKeyword}=,stat=,tty=`],
    {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const table = new Map<number, ProcessRecord>();
  for (const line of String(stdout).split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/,
    );
    if (!match) continue;

    const [, pid, ppid, pgid, sessionId, state, tty] = match;
    const record: ProcessRecord = {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      sessionId: Number(sessionId),
      state,
      tty,
    };
    table.set(record.pid, record);
  }

  return table;
}

function processDepth(
  record: ProcessRecord,
  table: Map<number, ProcessRecord>,
  rootPid: number,
): number {
  let depth = 0;
  let current = record;
  const seen = new Set<number>();

  while (
    current.pid !== rootPid &&
    current.ppid > 1 &&
    !seen.has(current.pid)
  ) {
    seen.add(current.pid);
    depth++;
    const parent = table.get(current.ppid);
    if (!parent) break;
    current = parent;
  }

  return depth;
}

function collectOwnedProcesses(
  table: Map<number, ProcessRecord>,
  rootPid: number,
  trackedPids: Set<number>,
  processSessionId: number | undefined,
  tty: string | undefined,
): ProcessRecord[] {
  const ownedPids = new Set<number>();
  const hasUsableSessionId =
    processSessionId !== undefined && processSessionId > 1;
  const hasUsableTty = tty !== undefined && tty !== "?" && tty !== "??";

  for (const record of table.values()) {
    if (
      record.pid !== rootPid &&
      ((hasUsableSessionId && record.sessionId === processSessionId) ||
        (hasUsableTty && record.tty === tty))
    ) {
      ownedPids.add(record.pid);
    }
  }

  for (const pid of trackedPids) {
    if (pid !== rootPid && table.has(pid)) ownedPids.add(pid);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const record of table.values()) {
      if (
        record.pid === rootPid ||
        record.pid <= 1 ||
        record.pid === process.pid ||
        ownedPids.has(record.pid)
      ) {
        continue;
      }

      if (record.ppid === rootPid || ownedPids.has(record.ppid)) {
        ownedPids.add(record.pid);
        changed = true;
      }
    }
  }

  return [...ownedPids]
    .map((pid) => table.get(pid))
    .filter((record): record is ProcessRecord => processIsAlive(record))
    .sort(
      (a, b) =>
        processDepth(b, table, rootPid) - processDepth(a, table, rootPid),
    );
}

async function scanTerminalProcesses(
  session: ManagedTerminal,
  trackedPids: Set<number>,
): Promise<ProcessScan> {
  const table = await readProcessTable();
  const rootRecord = table.get(session.pid);
  if (rootRecord) {
    if (rootRecord.sessionId > 1) {
      session.processSessionId = rootRecord.sessionId;
    }
    if (rootRecord.tty !== "?" && rootRecord.tty !== "??") {
      session.tty = rootRecord.tty;
    }
  }
  const owned = collectOwnedProcesses(
    table,
    session.pid,
    trackedPids,
    session.processSessionId,
    session.tty,
  );
  for (const record of owned) trackedPids.add(record.pid);

  return {
    table,
    owned,
    rootAlive: processIsAlive(table.get(session.pid)),
  };
}

function sendProcessSignal(pid: number, signal: CleanupSignal): boolean {
  if (pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function sendRootSignal(
  session: ManagedTerminal,
  signal: "SIGTERM" | "SIGKILL",
): boolean {
  if (sendProcessSignal(session.pid, signal)) return true;
  try {
    session.pty.kill(signal);
    return true;
  } catch {
    return false;
  }
}

function unixFallbackReport(
  force: boolean,
  error: unknown,
): CleanupReport {
  return {
    forceRequested: force,
    gracefulAttempted: !force,
    gracefulSucceeded: false,
    escalatedToSigkill: force,
    signal: force ? "SIGKILL" : undefined,
    descendantsFound: 0,
    targetedPids: [],
    terminatedPids: [],
    sigkillPids: [],
    residualPids: [],
    verified: false,
    enumerationError: error instanceof Error ? error.message : String(error),
  };
}

async function cleanupUnixTerminal(
  session: ManagedTerminal,
  force: boolean,
  timeoutMs: number,
): Promise<CleanupReport> {
  const trackedPids = new Set<number>();
  const targetedPids = new Set<number>();
  const termSignaledPids = new Set<number>();
  const sigkillTargetPids = new Set<number>();
  const startedAt = Date.now();
  let signalUsed: CleanupSignal | undefined;
  let latestScan: ProcessScan;

  const scanAndTrack = async (): Promise<ProcessScan> => {
    const scan = await scanTerminalProcesses(session, trackedPids);
    for (const record of scan.owned) targetedPids.add(record.pid);
    if (scan.rootAlive) targetedPids.add(session.pid);
    latestScan = scan;
    return scan;
  };

  try {
    latestScan = await scanAndTrack();
  } catch (error) {
    const report = unixFallbackReport(force, error);
    if (!force) {
      try {
        session.pty.write("\u0003");
        report.signal = "SIGINT";
      } catch {
        // Continue to direct termination.
      }
      await waitForExit(session, Math.min(750, timeoutMs));
      if (isRunning(session)) {
        sendRootSignal(session, "SIGTERM");
        report.signal = "SIGTERM";
        await waitForExit(session, Math.max(0, timeoutMs - 750));
      }
    }
    if (force || isRunning(session)) {
      sendRootSignal(session, "SIGKILL");
      report.escalatedToSigkill = true;
      report.signal = "SIGKILL";
      await waitForExit(session, CLEANUP_VERIFY_MS);
    }
    return report;
  }

  const signalNewDescendants = (scan: ProcessScan, signal: "SIGTERM" | "SIGKILL"): void => {
    for (const record of scan.owned) {
      targetedPids.add(record.pid);
      if (signal === "SIGTERM" && termSignaledPids.has(record.pid)) continue;
      if (sendProcessSignal(record.pid, signal)) {
        if (signal === "SIGTERM") {
          termSignaledPids.add(record.pid);
          if (signalUsed !== "SIGKILL") signalUsed = "SIGTERM";
        } else {
          sigkillTargetPids.add(record.pid);
          signalUsed = "SIGKILL";
        }
      }
    }
  };

  const pollUntil = async (
    deadline: number,
    signalNew: "SIGTERM" | "SIGKILL",
  ): Promise<ProcessScan> => {
    let scan = await scanAndTrack();
    while (true) {
      signalNewDescendants(scan, signalNew);
      if (signalNew === "SIGKILL" && scan.rootAlive) {
        if (sendRootSignal(session, "SIGKILL")) {
          sigkillTargetPids.add(session.pid);
          signalUsed = "SIGKILL";
        }
      }
      if (scan.owned.length === 0 && !scan.rootAlive) return scan;
      if (Date.now() >= deadline) return scan;
      await delay(Math.min(CLEANUP_POLL_MS, deadline - Date.now()));
      scan = await scanAndTrack();
    }
  };

  if (force) {
    signalNewDescendants(latestScan, "SIGKILL");
    if (latestScan.rootAlive && sendRootSignal(session, "SIGKILL")) {
      sigkillTargetPids.add(session.pid);
      signalUsed = "SIGKILL";
    }
  } else {
    signalNewDescendants(latestScan, "SIGTERM");
    try {
      session.pty.write("\u0003");
      signalUsed ??= "SIGINT";
    } catch {
      // The root may have already exited after its children received SIGTERM.
    }

    const interruptDeadline = Math.min(
      startedAt + timeoutMs,
      Date.now() + Math.min(1_000, Math.max(250, Math.floor(timeoutMs / 3))),
    );
    latestScan = await pollUntil(interruptDeadline, "SIGTERM");

    if (latestScan.rootAlive && sendRootSignal(session, "SIGTERM")) {
      if (signalUsed !== "SIGKILL") signalUsed = "SIGTERM";
    }
    latestScan = await pollUntil(startedAt + timeoutMs, "SIGTERM");
  }

  const aliveBeforeKill = new Set<number>([
    ...latestScan.owned.map((record) => record.pid),
    ...(latestScan.rootAlive ? [session.pid] : []),
  ]);
  let escalatedToSigkill = force || aliveBeforeKill.size > 0;

  if (!force && aliveBeforeKill.size > 0) {
    signalNewDescendants(latestScan, "SIGKILL");
    if (latestScan.rootAlive && sendRootSignal(session, "SIGKILL")) {
      sigkillTargetPids.add(session.pid);
      signalUsed = "SIGKILL";
    }
  }

  const verifyDeadline = Date.now() + CLEANUP_VERIFY_MS;
  latestScan = await pollUntil(verifyDeadline, "SIGKILL");
  escalatedToSigkill =
    escalatedToSigkill || sigkillTargetPids.size > 0;
  const residualPids = new Set<number>([
    ...latestScan.owned.map((record) => record.pid),
    ...(latestScan.rootAlive ? [session.pid] : []),
  ]);

  const terminatedPids = [...targetedPids].filter(
    (pid) => !sigkillTargetPids.has(pid) && !residualPids.has(pid),
  );
  const sigkillPids = [...sigkillTargetPids].filter(
    (pid) => !residualPids.has(pid),
  );

  return {
    forceRequested: force,
    gracefulAttempted: !force,
    gracefulSucceeded: !force && !escalatedToSigkill && residualPids.size === 0,
    escalatedToSigkill,
    signal: signalUsed,
    descendantsFound: [...targetedPids].filter((pid) => pid !== session.pid).length,
    targetedPids: [...targetedPids].sort((a, b) => a - b),
    terminatedPids: terminatedPids.sort((a, b) => a - b),
    sigkillPids: sigkillPids.sort((a, b) => a - b),
    residualPids: [...residualPids].sort((a, b) => a - b),
    verified: true,
  };
}

async function cleanupWindowsTerminal(
  session: ManagedTerminal,
  force: boolean,
  timeoutMs: number,
): Promise<CleanupReport> {
  const report: CleanupReport = {
    forceRequested: force,
    gracefulAttempted: !force,
    gracefulSucceeded: false,
    escalatedToSigkill: force,
    signal: force ? "SIGKILL" : "SIGINT",
    descendantsFound: 0,
    targetedPids: [session.pid],
    terminatedPids: [],
    sigkillPids: [],
    residualPids: [],
    verified: false,
  };

  if (!force) {
    try {
      session.pty.write("\u0003");
    } catch {
      // Continue with taskkill.
    }
    if (await waitForExit(session, Math.min(750, timeoutMs))) {
      report.gracefulSucceeded = true;
      report.terminatedPids = [session.pid];
      return report;
    }
  }

  try {
    await execFileAsync("taskkill", ["/PID", String(session.pid), "/T", "/F"], {
      timeout: Math.max(1_000, timeoutMs),
    });
    report.escalatedToSigkill = true;
    report.signal = "SIGKILL";
    report.sigkillPids = [session.pid];
    await waitForExit(session, CLEANUP_VERIFY_MS);
  } catch (error) {
    report.enumerationError = error instanceof Error ? error.message : String(error);
  }
  return report;
}

async function stopTerminal(
  session: ManagedTerminal,
  force: boolean,
  timeoutMs: number,
): Promise<CleanupReport> {
  if (
    session.cleanup?.verified &&
    session.cleanup.residualPids.length === 0
  ) {
    return session.cleanup;
  }
  if (session.cleanupPromise) return session.cleanupPromise;

  session.stopRequested = true;
  const cleanup = process.platform === "win32"
    ? cleanupWindowsTerminal(session, force, timeoutMs)
    : cleanupUnixTerminal(session, force, timeoutMs);
  session.cleanupPromise = cleanup;

  try {
    const report = await cleanup;
    session.cleanup = report;
    await waitForExit(session, CLEANUP_VERIFY_MS);
    if (!report.verified || report.residualPids.length > 0) {
      session.status = "cleanup_failed";
    } else if (isRunning(session)) {
      session.status = "stopped";
      session.endedAt ??= Date.now();
    }
    return report;
  } finally {
    session.cleanupPromise = undefined;
  }
}

function signalName(signal: number | undefined): string | undefined {
  if (!signal) return undefined;
  const known: Record<number, string> = {
    1: "SIGHUP",
    2: "SIGINT",
    3: "SIGQUIT",
    6: "SIGABRT",
    9: "SIGKILL",
    15: "SIGTERM",
  };
  return known[signal] ?? `SIGNAL_${signal}`;
}

function serializeSession(session: ManagedTerminal): Record<string, unknown> {
  const normalizedSignal = signalName(session.signal);
  return {
    id: session.id,
    name: session.name,
    pid: session.pid,
    status: session.status,
    cwd: session.cwd,
    command: session.command,
    startedAt: new Date(session.startedAt).toISOString(),
    endedAt: session.endedAt
      ? new Date(session.endedAt).toISOString()
      : undefined,
    exitCode: normalizedSignal ? null : session.exitCode,
    signal: normalizedSignal,
    rawSignal: session.signal || undefined,
    cleanup: session.cleanup,
    outputMode: session.outputMode,
    secretHandles: session.secretHandles,
    cursor: session.outputEnd,
  };
}

function toolResult(details: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

export default function terminalExtension(pi: ExtensionAPI): void {
  const sessions = new Map<string, ManagedTerminal>();
  let nextId = 1;

  const findSession = (idOrName: string | undefined): ManagedTerminal => {
    if (!idOrName) throw new Error("terminal action requires id");
    const direct = sessions.get(idOrName);
    if (direct) return direct;

    const byName = [...sessions.values()].filter(
      (session) => session.name === idOrName,
    );
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new Error(`Terminal name is ambiguous: ${idOrName}; use its id`);
    }
    throw new Error(`Terminal not found: ${idOrName}`);
  };

  const pruneSessions = (clearExited = false): string[] => {
    const now = Date.now();
    const removed: string[] = [];
    const completed = [...sessions.values()]
      .filter(
        (session) =>
          !isRunning(session) &&
          session.cleanup !== undefined,
      )
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

    for (const [index, session] of completed.entries()) {
      const expired =
        session.endedAt !== undefined &&
        now - session.endedAt >= COMPLETED_SESSION_TTL_MS;
      if (clearExited || expired || index >= MAX_COMPLETED_SESSIONS) {
        clearNotificationTimer(session);
        sessions.delete(session.id);
        removed.push(session.id);
      }
    }

    return removed;
  };

  pi.registerTool({
    name: "terminal",
    label: "Terminal",
    description:
      "Manage persistent PTY sessions for long-running development servers, watchers, interactive prompts, REPLs, and monitoring commands. One tool exposes start, read, await, send, stop, and list actions. Screen mode coalesces TUI redraws; log mode preserves raw line output.",
    promptSnippet:
      "Start and manage persistent interactive terminal sessions for long-running processes",
    promptGuidelines: [
      "Use terminal only for long-running or interactive processes; use bash for finite commands that should complete in one call.",
      "Use terminal action=start once, retain its id/cursor, then use read for incremental output, send for input, and stop when the temporary process is no longer needed.",
      "Use the default screen output mode for spinners/TUI programs; use outputMode=log when every emitted log line must be retained.",
      "Use action=await to wait event-driven for exit or waitFor instead of polling; on action=start, set notifyOn to exit, match, or stalled when work should continue in the background.",
      "For credentials, use only pre-registered secretEnv handles; never put secret values in command, input, or purpose.",
      "Always stop terminal sessions you started before finishing the task unless the user explicitly asks to keep them running.",
    ],
    parameters: terminalParameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action === "list") {
        if (params.clearExited) {
          await Promise.all(
            [...sessions.values()]
              .filter(
                (session) =>
                  !isRunning(session) &&
                  (!session.cleanup?.verified ||
                    session.cleanup.residualPids.length > 0),
              )
              .map((session) =>
                stopTerminal(session, false, DEFAULT_STOP_TIMEOUT_MS),
              ),
          );
        }
        const removed = pruneSessions(params.clearExited ?? false);
        const items = [...sessions.values()].map(serializeSession);
        return toolResult({
          count: items.length,
          running: items.filter((item) => item.status === "running").length,
          completed: items.filter((item) => item.status !== "running").length,
          removed,
          retention: {
            maxCompleted: MAX_COMPLETED_SESSIONS,
            ttlMinutes: COMPLETED_SESSION_TTL_MS / 60_000,
          },
          sessions: items,
        });
      }

      if (params.action === "start") {
        const command = params.command?.trim();
        if (!command) throw new Error("terminal start requires command");

        if (params.notifyOn === "match" && !params.waitFor?.trim()) {
          throw new Error("notifyOn=match requires waitFor");
        }
        if (params.notifyOn === undefined && params.stalledMs !== undefined) {
          throw new Error("stalledMs requires notifyOn=stalled");
        }

        const name = params.name?.trim() || `terminal-${nextId}`;
        if (
          [...sessions.values()].some(
            (session) => session.name === name && isRunning(session),
          )
        ) {
          throw new Error(`A running terminal already uses name: ${name}`);
        }

        const cwd = resolve(ctx.cwd, params.cwd?.trim() || ".");
        let cwdStat;
        try {
          cwdStat = statSync(cwd);
        } catch {
          throw new Error(`Terminal cwd does not exist: ${cwd}`);
        }
        if (!cwdStat.isDirectory()) {
          throw new Error(`Terminal cwd is not a directory: ${cwd}`);
        }

        const resolvedSecrets = await resolveSecretEnvironment(
          params.secretEnv as SecretEnvironmentInput | undefined,
        );
        const pty = await loadPty();
        const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
        const shellArgs = process.platform === "win32"
          ? ["-NoLogo", "-Command", command]
          : ["-lc", command];
        const child = pty.spawn(shell, shellArgs, {
          name: "xterm-256color",
          cols: params.cols ?? 120,
          rows: params.rows ?? 40,
          cwd,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            ...resolvedSecrets.values,
          },
        });

        const id = `term-${nextId++}`;
        const session: ManagedTerminal = {
          id,
          name,
          command,
          cwd,
          pid: child.pid,
          pty: child,
          status: "running",
          startedAt: Date.now(),
          stopRequested: false,
          outputMode: params.outputMode ?? "screen",
          secretValues: Object.values(resolvedSecrets.values),
          secretHandles: resolvedSecrets.handles,
          redactionCarry: "",
          buffer: "",
          bufferStart: 0,
          outputEnd: 0,
          defaultCursor: 0,
          screen: createScreenState(),
          lastOutputAt: Date.now(),
          listeners: new Set(),
        };

        if (params.notifyOn) {
          session.notification = {
            mode: params.notifyOn,
            cursor: session.outputEnd,
            pattern: params.waitFor?.trim() || undefined,
            stalledMs: params.stalledMs ?? DEFAULT_STALLED_MS,
            fired: false,
          };
          session.notifyEvent = (event) => {
            const tail = outputSince(session, Math.max(0, session.outputEnd - 4_000))
              .slice(-4_000)
              .trim();
            const reason = event.mode === "exit"
              ? `进程已退出（${session.status}）`
              : event.mode === "match"
                ? `匹配到：${event.pattern}`
                : `超过 ${session.notification?.stalledMs ?? DEFAULT_STALLED_MS}ms 无新输出`;
            try {
              pi.sendMessage(
                {
                  customType: "terminal-notification",
                  content: `Terminal ${session.id}：${reason}${tail ? `\n${tail}` : ""}`,
                  display: true,
                  details: {
                    terminalId: session.id,
                    mode: event.mode,
                    status: session.status,
                  },
                },
                { triggerTurn: true, deliverAs: "followUp" },
              );
            } catch {
              // A session may shut down while a notification is being emitted.
            }
          };
        }

        sessions.set(id, session);
        scheduleStalledNotification(session);
        session.dataDisposable = child.onData((data) => appendOutput(session, data));
        session.exitDisposable = child.onExit(({ exitCode, signal: exitSignal }) => {
          const pendingRedactedOutput = flushRedaction(session);
          if (pendingRedactedOutput) {
            if (session.outputMode === "screen") {
              consumeScreenOutput(session, pendingRedactedOutput);
            } else {
              appendLogOutput(session, pendingRedactedOutput);
            }
          }
          if (session.outputMode === "screen") flushScreenOutput(session);
          session.exitCode = exitCode;
          session.signal = exitSignal;
          session.endedAt = Date.now();
          session.status = session.cleanup?.residualPids.length
            ? "cleanup_failed"
            : session.stopRequested
              ? "stopped"
              : exitSignal
                ? "failed"
                : exitCode === 0
                  ? "exited"
                  : "failed";
          notifyListeners(session);
          session.dataDisposable?.dispose();
          session.exitDisposable?.dispose();

          if (!session.stopRequested) {
            void stopTerminal(
              session,
              false,
              DEFAULT_STOP_TIMEOUT_MS,
            ).finally(() => pruneSessions());
          } else {
            pruneSessions();
          }
        });

        try {
          await scanTerminalProcesses(session, new Set<number>());
        } catch {
          // Stop will retry process enumeration and report if it is unavailable.
        }

        const cursor = 0;
        const timeoutMs = params.timeoutMs ?? (params.waitFor ? 10_000 : 0);
        const wait = await waitForTerminal(
          session,
          cursor,
          params.waitFor,
          timeoutMs,
          signal,
        );
        const snapshot = snapshotOutput(
          session,
          cursor,
          params.limit ?? DEFAULT_READ_LIMIT,
        );
        session.defaultCursor = snapshot.cursor;
        pruneSessions();

        return toolResult({
          ...serializeSession(session),
          wait,
          output: snapshot.output,
          cursor: snapshot.cursor,
          hasMore: snapshot.hasMore,
        });
      }

      const session = findSession(params.id);

      if (params.action === "read") {
        const cursor = params.cursor ?? session.defaultCursor;
        const timeoutMs = params.timeoutMs ?? (params.waitFor ? 10_000 : 0);
        const wait = await waitForTerminal(
          session,
          cursor,
          params.waitFor,
          timeoutMs,
          signal,
        );
        const snapshot = snapshotOutput(
          session,
          cursor,
          params.limit ?? DEFAULT_READ_LIMIT,
        );
        session.defaultCursor = snapshot.cursor;

        return toolResult({
          ...serializeSession(session),
          wait,
          output: snapshot.output,
          cursor: snapshot.cursor,
          hasMore: snapshot.hasMore,
          truncatedBeforeCursor: snapshot.truncatedBeforeCursor,
          bufferStart: snapshot.bufferStart,
          outputEnd: snapshot.outputEnd,
        });
      }

      if (params.action === "await") {
        const cursor = params.cursor ?? session.defaultCursor;
        const timeoutMs = params.timeoutMs ?? MAX_WAIT_TIMEOUT_MS;
        const wait = params.waitFor
          ? await waitForTerminal(
              session,
              cursor,
              params.waitFor,
              timeoutMs,
              signal,
            )
          : await waitForTerminalExit(session, timeoutMs, signal);
        const snapshot = snapshotOutput(
          session,
          cursor,
          params.limit ?? DEFAULT_READ_LIMIT,
        );
        session.defaultCursor = snapshot.cursor;

        return toolResult({
          ...serializeSession(session),
          wait,
          output: snapshot.output,
          cursor: snapshot.cursor,
          hasMore: snapshot.hasMore,
          truncatedBeforeCursor: snapshot.truncatedBeforeCursor,
          bufferStart: snapshot.bufferStart,
          outputEnd: snapshot.outputEnd,
        });
      }

      if (params.action === "send") {
        if (!isRunning(session)) {
          throw new Error(`Terminal ${session.id} is not running`);
        }

        let data = params.input ?? "";
        if (params.enter) data += "\r";
        if (params.key) data += KEY_SEQUENCES[params.key];
        if (!data) {
          throw new Error("terminal send requires input, enter, or key");
        }

        session.pty.write(data);
        return toolResult({
          ...serializeSession(session),
          sentCharacters: Array.from(data).length,
          cursor: session.defaultCursor,
        });
      }

      if (params.action === "stop") {
        const cleanup = await stopTerminal(
          session,
          params.force ?? false,
          params.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
        );
        return toolResult({
          ...serializeSession(session),
          cleanup,
        });
      }

      throw new Error(`Unsupported terminal action: ${params.action}`);
    },
  });

  pi.on("session_shutdown", async () => {
    for (const session of sessions.values()) clearNotificationTimer(session);
    await Promise.all(
      [...sessions.values()]
        .filter(
          (session) =>
            !session.cleanup?.verified ||
            session.cleanup.residualPids.length > 0,
        )
        .map((session) =>
          stopTerminal(session, false, DEFAULT_STOP_TIMEOUT_MS),
        ),
    );
  });
}
