import type { TerminalNotifyOn, TerminalStatus } from "./types.ts";

/** How long a burst of terminal events is collected before one message is sent. */
export const NOTICE_COALESCE_MS = 120;
/**
 * How long held events wait for the Agent to settle before they steer into the
 * running turn instead.
 *
 * A run that never settles is possible — a prompt rejected before the agent loop
 * emits no `agent_settled` — so events must not be able to wait forever.
 */
export const NOTICE_MAX_HOLD_MS = 60_000;
/**
 * How long a sent wake-up is trusted to produce a run when `agent_start` has not
 * arrived yet. It only bridges the gap between the message and the run.
 */
export const NOTICE_WAKE_GRACE_MS = 3_000;
/** Output kept for a single event, and the total kept when several are batched. */
export const NOTICE_TAIL_MAX = 4_000;
export const NOTICE_TAIL_BUDGET = 8_000;
export const NOTICE_TAIL_MIN = 400;
/** Headlines carried by one message; anything older collapses into a count. */
export const MAX_BATCH_NOTICES = 30;

export interface TerminalNoticeEvent {
  terminalId: string;
  mode: TerminalNotifyOn;
  status: TerminalStatus;
  /** One-line reason, without the `Terminal <id>：` prefix. */
  reason: string;
  /** Tail of the output at the moment the event fired. */
  output: string;
  at: number;
}

export interface NoticePayload {
  content: string;
  details: Record<string, unknown>;
}

export type NoticeDelivery = "steer" | "followUp";

export interface NoticeDispatcherOptions {
  send(payload: NoticePayload, delivery: NoticeDelivery): void;
  coalesceMs?: number;
  maxHoldMs?: number;
  wakeGraceMs?: number;
  now?: () => number;
}

export interface NoticeDispatcher {
  /** Record an event. Nothing is sent before the coalescing window closes. */
  enqueue(event: TerminalNoticeEvent): void;
  /**
   * Drop this terminal's held events because a tool call just returned its
   * state to the Agent. The tool result already carries what the event says.
   */
  markObserved(terminalId: string): void;
  setAgentRunning(running: boolean): void;
  /** Send whatever is held right now; used by shutdown and by tests. */
  flush(): void;
  pendingCount(): number;
  dispose(): void;
}

function clampTail(output: string, budget: number): string {
  const trimmed = output.trim();
  if (trimmed.length <= budget) return trimmed;
  return `…${trimmed.slice(-budget)}`;
}

function tailBudgetFor(count: number): number {
  if (count <= 1) return NOTICE_TAIL_MAX;
  return Math.max(NOTICE_TAIL_MIN, Math.floor(NOTICE_TAIL_BUDGET / count));
}

/**
 * Render held events as one message.
 *
 * A single event keeps the exact shape it has always had — one headline plus the
 * tail of its output — so a batch is the only new shape the UI has to read.
 */
export function formatNotices(events: TerminalNoticeEvent[], omitted = 0): NoticePayload {
  const budget = tailBudgetFor(events.length);
  const notices = events.map((event) => ({
    terminalId: event.terminalId,
    mode: event.mode,
    status: event.status,
    reason: event.reason,
    output: clampTail(event.output, budget),
  }));
  const blocks = notices.map((notice) => (
    `Terminal ${notice.terminalId}：${notice.reason}${notice.output ? `\n${notice.output}` : ""}`
  ));
  const single = notices.length === 1 && omitted === 0;
  const header = single ? "" : `${notices.length + omitted} 个终端有新的事件：\n\n`;
  const footer = omitted > 0
    ? `\n\n另有 ${omitted} 个更早的终端事件已省略，用 terminal list 查看。`
    : "";
  const first = notices[0];
  return {
    content: `${header}${blocks.join("\n\n")}${footer}`,
    details: single && first
      ? { terminalId: first.terminalId, mode: first.mode, status: first.status, notices }
      : { count: notices.length + omitted, omitted, notices },
  };
}

/**
 * Collects terminal events and hands them to the Agent as few times as possible.
 *
 * Every delivery costs a full LLM turn, because Pi drains queued messages one at
 * a time, so this layer enforces three rules:
 *
 * - events inside one window become one message, however many terminals fired;
 * - an event a tool call already reported is dropped instead of sent;
 * - while a run is active nothing is sent, since the run itself is reading these
 *   terminals; the batch waits for `agent_settled` and wakes exactly one turn.
 */
export function createNoticeDispatcher(options: NoticeDispatcherOptions): NoticeDispatcher {
  const coalesceMs = options.coalesceMs ?? NOTICE_COALESCE_MS;
  const maxHoldMs = options.maxHoldMs ?? NOTICE_MAX_HOLD_MS;
  const wakeGraceMs = options.wakeGraceMs ?? NOTICE_WAKE_GRACE_MS;
  const now = options.now ?? (() => Date.now());

  let pending: TerminalNoticeEvent[] = [];
  let omitted = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let agentRunning = false;
  let wakeSentAt: number | undefined;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  /** True while the Agent is expected to look at these terminals on its own. */
  const busy = (): boolean => (
    agentRunning || (wakeSentAt !== undefined && now() - wakeSentAt < wakeGraceMs)
  );

  const send = (): void => {
    clearTimer();
    if (pending.length === 0) return;
    const events = pending;
    const skipped = omitted;
    pending = [];
    omitted = 0;
    const delivery: NoticeDelivery = busy() ? "steer" : "followUp";
    if (delivery === "followUp") wakeSentAt = now();
    options.send(formatNotices(events, skipped), delivery);
  };

  const schedule = (): void => {
    if (disposed || pending.length === 0 || timer !== undefined) return;
    const oldest = pending[0];
    if (!busy()) {
      timer = setTimeout(send, coalesceMs);
      return;
    }
    const held = now() - (oldest?.at ?? now());
    if (held >= maxHoldMs) {
      send();
      return;
    }
    // Re-check while the run owns these terminals; settling clears the timer
    // sooner. The wake grace is the longest a stale wake-up can hide an idle
    // Agent, so it also bounds how coarse this re-check may become.
    const delay = Math.min(maxHoldMs - held, Math.max(coalesceMs, wakeGraceMs));
    timer = setTimeout(() => {
      timer = undefined;
      schedule();
    }, delay);
  };

  return {
    enqueue(event) {
      if (disposed) return;
      const index = pending.findIndex((held) => (
        held.terminalId === event.terminalId && held.mode === event.mode
      ));
      if (index >= 0) pending[index] = event;
      else pending.push(event);
      while (pending.length > MAX_BATCH_NOTICES) {
        pending.shift();
        omitted += 1;
      }
      schedule();
    },
    markObserved(terminalId) {
      const kept = pending.filter((held) => held.terminalId !== terminalId);
      if (kept.length === pending.length) return;
      pending = kept;
      if (pending.length === 0 && omitted === 0) clearTimer();
    },
    setAgentRunning(running) {
      agentRunning = running;
      // The run either began or finished, so nothing is owed to a sent wake-up.
      wakeSentAt = undefined;
      if (disposed) return;
      clearTimer();
      schedule();
    },
    flush() {
      if (disposed) return;
      send();
    },
    pendingCount() {
      return pending.length;
    },
    dispose() {
      disposed = true;
      clearTimer();
      pending = [];
      omitted = 0;
    },
  };
}
