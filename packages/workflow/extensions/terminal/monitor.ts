import type { BackgroundWaitState } from "../background-wait.ts";
import { isRunning, outputSince, snapshotOutput } from "./output.ts";
import type { ManagedTerminal, TerminalStatus } from "./types.ts";

export const MONITOR_COALESCE_MS = 200;
export const MAX_ACTIVE_MONITORS = 32;
export const MAX_COMPLETED_MONITORS = 64;
export const MONITOR_OUTPUT_LIMIT = 8_000;
export const MAX_MONITOR_EVENTS = 30;

export interface TerminalMonitorEvent {
  monitorId: string;
  terminalId: string;
  mode: "exit" | "output" | "match";
  status: TerminalStatus;
  reason: string;
  output: string;
  at: number;
}

export interface MonitorSnapshot {
  id: string;
  terminalId: string;
  description: string;
  mode: "exit" | "output" | "match";
  persistent: boolean;
  status: "watching" | "completed" | "stopped";
  lastEvent?: TerminalMonitorEvent;
}

export interface TerminalMonitorOptions {
  description?: string;
  mode: MonitorSnapshot["mode"];
  pattern?: string;
  persistent?: boolean;
  cursor?: number;
}

export interface TerminalMonitorRegistry {
  start(session: ManagedTerminal, options: TerminalMonitorOptions): MonitorSnapshot;
  list(): MonitorSnapshot[];
  get(id: string): MonitorSnapshot;
  /** Wait for any selected monitor; results already captured return immediately. */
  wait(ids?: readonly string[]): { waiting: boolean; monitors: MonitorSnapshot[] };
  /** Called before notification delivery, never merely when output is captured. */
  releaseWait(terminalIds: readonly string[]): void;
  /** Consume specific monitor results without acknowledging a newer subscription on the same terminal. */
  acknowledge(monitorIds: readonly string[]): void;
  cancel(id: string): MonitorSnapshot;
  cancelAll(): void;
  dispose(): void;
}

interface MonitorState {
  snapshot: MonitorSnapshot;
  session?: ManagedTerminal;
  pattern?: string;
  cursor: number;
  pendingOutput: string;
  lineTail: string;
  matchTail: string;
  frameText: string;
  pendingEvent: boolean;
  eventSequence: number;
  observedSequence: number;
  listener: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Watches existing terminal events. Process lifetime and ownership stay with the terminal manager. */
export function createTerminalMonitorRegistry(options: {
  onEvent(event: TerminalMonitorEvent): void;
  onWaitingChange(state: BackgroundWaitState): void;
  coalesceMs?: number;
}): TerminalMonitorRegistry {
  const coalesceMs = options.coalesceMs ?? MONITOR_COALESCE_MS;
  if (!Number.isFinite(coalesceMs) || coalesceMs < 0) throw new Error("Monitor coalescing interval must be non-negative");
  const monitors = new Map<string, MonitorState>();
  let waiting = new Set<string>();
  let nextId = 1;
  let disposed = false;

  const snapshot = (monitor: MonitorState): MonitorSnapshot => ({
    ...monitor.snapshot,
    lastEvent: monitor.snapshot.lastEvent ? { ...monitor.snapshot.lastEvent } : undefined,
  });
  const lookup = (id: string): MonitorState => {
    const monitor = monitors.get(id);
    if (!monitor) throw new Error(`Monitor not found: ${id}`);
    return monitor;
  };
  const checkActive = (): void => {
    if (disposed) throw new Error("Monitor registry is closed");
  };
  const setWaiting = (next: Set<string>): void => {
    if (next.size === waiting.size && [...next].every((id) => waiting.has(id))) return;
    waiting = next;
    if (!disposed) options.onWaitingChange({ waiting: waiting.size > 0, monitorIds: [...waiting] });
  };
  const detach = (monitor: MonitorState): void => {
    if (monitor.timer !== undefined) clearTimeout(monitor.timer);
    monitor.timer = undefined;
    monitor.session?.listeners.delete(monitor.listener);
    monitor.session = undefined;
    monitor.frameText = "";
    monitor.matchTail = "";
    monitor.lineTail = "";
    monitor.pendingOutput = "";
  };
  const prune = (): void => {
    const completed = [...monitors.values()].filter((monitor) => monitor.snapshot.status !== "watching");
    let excess = completed.length - MAX_COMPLETED_MONITORS;
    for (const monitor of completed) {
      if (excess <= 0) break;
      if (waiting.has(monitor.snapshot.id)) continue;
      monitors.delete(monitor.snapshot.id);
      excess -= 1;
    }
  };
  const acknowledge = (ids: readonly string[]): void => {
    let unblocks = false;
    for (const id of ids) {
      const monitor = monitors.get(id);
      if (!monitor) continue;
      monitor.observedSequence = monitor.eventSequence;
      unblocks ||= waiting.has(id);
    }
    if (unblocks) setWaiting(new Set());
    prune();
  };
  const publish = (monitor: MonitorState, mode: TerminalMonitorEvent["mode"], ended: boolean): void => {
    if (disposed || monitor.snapshot.status !== "watching") return;
    if (monitor.timer !== undefined) clearTimeout(monitor.timer);
    monitor.timer = undefined;
    const session = monitor.session!;
    const eventLimitReached = !ended && monitor.snapshot.persistent && monitor.eventSequence + 1 >= MAX_MONITOR_EVENTS;
    const reason = eventLimitReached
      ? `监控 ${monitor.snapshot.id}：${monitor.snapshot.description}；事件过多（${MAX_MONITOR_EVENTS} 次），监控已停止`
      : mode === "exit"
      ? `监控 ${monitor.snapshot.id}：${monitor.snapshot.description}；进程已结束（${session.status}）`
      : mode === "match"
        ? `监控 ${monitor.snapshot.id}：${monitor.snapshot.description}；匹配到 ${monitor.pattern}`
        : `监控 ${monitor.snapshot.id}：${monitor.snapshot.description}；收到新输出`;
    const output = (monitor.pendingOutput + (ended ? monitor.lineTail : "")).trim()
      || (ended ? snapshotOutput(session, Math.max(0, session.outputEnd - MONITOR_OUTPUT_LIMIT), MONITOR_OUTPUT_LIMIT).output : "");
    const event: TerminalMonitorEvent = {
      monitorId: monitor.snapshot.id,
      terminalId: session.id,
      mode,
      status: session.status,
      reason,
      output: output.slice(-MONITOR_OUTPUT_LIMIT),
      at: Date.now(),
    };
    monitor.pendingOutput = "";
    if (ended || eventLimitReached) monitor.lineTail = "";
    monitor.pendingEvent = false;
    monitor.eventSequence += 1;
    monitor.snapshot.lastEvent = event;
    if (ended || eventLimitReached || !monitor.snapshot.persistent) {
      monitor.snapshot.status = eventLimitReached ? "stopped" : "completed";
      detach(monitor);
    }
    // Waiting is released only by the owner when this event is delivered.
    options.onEvent({ ...event });
    prune();
  };
  const consumeText = (monitor: MonitorState, chunk: string): void => {
    if (!chunk) return;
    if (monitor.snapshot.mode === "output") {
      const combined = monitor.lineTail + chunk;
      const boundary = combined.lastIndexOf("\n");
      if (boundary >= 0) {
        const lines = combined.slice(0, boundary + 1);
        monitor.pendingOutput = (monitor.pendingOutput + lines).slice(-MONITOR_OUTPUT_LIMIT);
        monitor.pendingEvent ||= lines.trim().length > 0;
        monitor.lineTail = combined.slice(boundary + 1).slice(-MONITOR_OUTPUT_LIMIT);
      } else monitor.lineTail = combined.slice(-MONITOR_OUTPUT_LIMIT);
    } else monitor.pendingOutput = (monitor.pendingOutput + chunk).slice(-MONITOR_OUTPUT_LIMIT);
    if (monitor.snapshot.mode === "match") {
      const pattern = monitor.pattern!;
      const combined = monitor.matchTail + chunk;
      if (combined.includes(pattern)) monitor.pendingEvent = true;
      monitor.matchTail = combined.slice(-Math.max(0, pattern.length - 1));
      if (pattern.length === 1) monitor.matchTail = "";
    }
  };
  const consume = (monitor: MonitorState): void => {
    if (disposed || monitor.snapshot.status !== "watching") return;
    const session = monitor.session!;
    if (session.outputMode === "screen") {
      for (const event of session.screen.events) {
        if (event.revision <= monitor.cursor) continue;
        const appended = event.text.startsWith(monitor.frameText);
        if (!appended) {
          // A rewritten frame is a new screen value, not a continuation of the
          // previous value. Retain committed lines, but discard partial input.
          monitor.matchTail = "";
          monitor.lineTail = "";
        }
        consumeText(monitor, (appended ? event.text.slice(monitor.frameText.length) : event.text)
          + (event.kind === "line" ? "\n" : ""));
        monitor.frameText = event.kind === "line" ? "" : event.text;
      }
    } else consumeText(monitor, outputSince(session, monitor.cursor));
    monitor.cursor = session.outputEnd;
    if (!isRunning(session)) {
      const mode = !monitor.snapshot.persistent && monitor.pendingEvent ? monitor.snapshot.mode : "exit";
      publish(monitor, mode, true);
    } else if (monitor.pendingEvent && monitor.timer === undefined) {
      monitor.timer = setTimeout(() => {
        monitor.timer = undefined;
        publish(monitor, monitor.snapshot.mode, false);
      }, coalesceMs);
      monitor.timer.unref?.();
    }
  };

  return {
    start(session, config) {
      checkActive();
      if (config.mode === "match" && !config.pattern?.trim()) throw new Error("Match monitor requires a non-empty literal pattern");
      if (config.mode !== "match" && config.pattern !== undefined) throw new Error("A monitor pattern requires mode=match");
      if (config.pattern && config.pattern.length > 500) throw new Error("Monitor literal pattern must be at most 500 characters");
      const cursor = config.cursor ?? session.outputEnd;
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > session.outputEnd) throw new Error("Monitor cursor is outside the terminal output");
      const active = [...monitors.values()].filter((monitor) => monitor.snapshot.status === "watching");
      const existing = active.find((monitor) => monitor.snapshot.terminalId === session.id);
      if (existing) throw new Error(`Terminal ${session.id} already has monitor ${existing.snapshot.id}`);
      if (active.length >= MAX_ACTIVE_MONITORS) throw new Error(`At most ${MAX_ACTIVE_MONITORS} terminal monitors may run at once`);
      const monitor: MonitorState = {
        snapshot: {
          id: `monitor-${nextId++}`,
          terminalId: session.id,
          description: (config.description?.trim() || session.name || session.id).slice(0, 500),
          mode: config.mode,
          persistent: config.persistent ?? false,
          status: "watching",
        },
        session,
        pattern: config.pattern,
        cursor,
        pendingOutput: "",
        lineTail: "",
        matchTail: "",
        frameText: session.outputMode === "screen" && session.screen.frameEvent
          && session.screen.frameEvent.revision <= cursor ? session.screen.frameEvent.text : "",
        pendingEvent: false,
        eventSequence: 0,
        observedSequence: 0,
        listener: () => consume(monitor),
      };
      monitors.set(monitor.snapshot.id, monitor);
      session.listeners.add(monitor.listener);
      consume(monitor);
      prune();
      return snapshot(monitor);
    },
    list() {
      return [...monitors.values()].map(snapshot);
    },
    get(id) {
      return snapshot(lookup(id));
    },
    wait(ids) {
      checkActive();
      const selected = ids === undefined
        ? [...monitors.values()].filter((monitor) => monitor.snapshot.status === "watching" || monitor.eventSequence > monitor.observedSequence)
        : [...new Set(ids)].map(lookup);
      const ready = selected.filter((monitor) => monitor.eventSequence > monitor.observedSequence);
      for (const monitor of ready) monitor.observedSequence = monitor.eventSequence;
      const next = ready.length > 0 ? [] : selected.filter((monitor) => monitor.snapshot.status === "watching");
      setWaiting(new Set(next.map((monitor) => monitor.snapshot.id)));
      return { waiting: waiting.size > 0, monitors: selected.map(snapshot) };
    },
    releaseWait(terminalIds) {
      const targets = new Set(terminalIds);
      acknowledge([...monitors.values()].filter((monitor) => targets.has(monitor.snapshot.terminalId)).map((monitor) => monitor.snapshot.id));
    },
    acknowledge,
    cancel(id) {
      const monitor = lookup(id);
      detach(monitor);
      if (monitor.snapshot.status === "watching") monitor.snapshot.status = "stopped";
      monitor.pendingOutput = "";
      monitor.lineTail = "";
      monitor.observedSequence = monitor.eventSequence;
      setWaiting(new Set([...waiting].filter((item) => item !== id)));
      prune();
      return snapshot(monitor);
    },
    cancelAll() {
      for (const monitor of monitors.values()) {
        detach(monitor);
        if (monitor.snapshot.status === "watching") monitor.snapshot.status = "stopped";
        monitor.pendingOutput = "";
        monitor.lineTail = "";
        monitor.observedSequence = monitor.eventSequence;
      }
      setWaiting(new Set());
      prune();
    },
    dispose() {
      disposed = true;
      for (const monitor of monitors.values()) detach(monitor);
      monitors.clear();
      waiting.clear();
    },
  };
}
