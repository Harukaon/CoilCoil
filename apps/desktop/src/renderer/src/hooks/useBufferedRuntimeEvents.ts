import { useCallback, useEffect, useRef } from "react";
import type { RuntimeEvent } from "@coilcoil/runtime-protocol";
import { diagnostics } from "../diagnostics";

/** One runtime event with the session runtime it came from. */
export interface BufferedRuntimeEvent {
  event: RuntimeEvent;
  runtimeId?: string;
}

/**
 * How long a burst of stream events may accumulate before it is applied.
 *
 * The number is a rendering budget, not a latency target: the timeline re-parses
 * the streaming message's Markdown and re-measures the scroll viewport on every
 * applied batch, so the cost per batch is roughly fixed and the cost per second
 * is what this interval sets. At 60 ms a fast provider costs ~16 renders per
 * second instead of one per token, and text still lands well inside the ~100 ms
 * that reads as instant.
 */
export const RUNTIME_EVENT_FLUSH_MS = 60;

/**
 * When a batch is big enough to mean the Renderer is behind, not just busy.
 *
 * A healthy stream lands a handful of deltas per flush. Hundreds means the
 * events arrived far faster than React could apply them, which is the shape of
 * every symptom that reads as the window ignoring the user — and until now it
 * left no trace at all, because the only evidence was a frame that came late.
 */
const SLOW_BATCH_SIZE = 120;

/** A flush this far past its interval means the task queue was blocked. */
const SLOW_FLUSH_LAG_MS = 500;

function isTextDelta(entry: BufferedRuntimeEvent): entry is BufferedRuntimeEvent & {
  event: Extract<RuntimeEvent, { type: "message_delta" }>;
} {
  return entry.event.type === "message_delta";
}

/**
 * Fold a burst of runtime events into the smallest sequence with the same effect.
 *
 * Only neighbouring deltas of the same message and field merge. Anything else
 * between them — a tool starting, the message finishing, a snapshot — is a point
 * the reducer has to observe in order, so a merge across it would reorder state.
 * The merged entry keeps the newest revision, which is the one the reducer's
 * staleness guard compares against.
 */
export function coalesceRuntimeEvents(events: readonly BufferedRuntimeEvent[]): BufferedRuntimeEvent[] {
  const folded: BufferedRuntimeEvent[] = [];
  for (const entry of events) {
    const previous = folded.at(-1);
    if (
      previous
      && isTextDelta(previous)
      && isTextDelta(entry)
      && previous.runtimeId === entry.runtimeId
      && previous.event.id === entry.event.id
      && previous.event.field === entry.event.field
    ) {
      folded[folded.length - 1] = {
        runtimeId: entry.runtimeId,
        event: {
          ...entry.event,
          delta: `${previous.event.delta}${entry.event.delta}`,
        },
      };
      continue;
    }
    folded.push(entry);
  }
  return folded;
}

/**
 * Apply runtime events in batches instead of one React render per event.
 *
 * The runtime emits a `message_delta` per streamed token, and each one used to
 * arrive in its own task: its own reducer pass, its own Markdown re-parse of the
 * whole growing message, its own synchronous scroll measurement. Past a few
 * dozen turns that is more work than a frame has room for, and the renderer
 * stops keeping up — which is what a stop button that ignores clicks, a sent
 * message that paints late, and a composer still spinning after the reply ended
 * all actually are.
 *
 * Batching fixes the throughput rather than any one symptom: React applies one
 * batch as a single render, so the per-token cost collapses to a per-batch cost.
 * The first event after a quiet stretch is still applied on the next task, so an
 * idle app stays as responsive as it was.
 */
export function useBufferedRuntimeEvents(
  apply: (event: RuntimeEvent, runtimeId?: string) => void,
  flushIntervalMs = RUNTIME_EVENT_FLUSH_MS,
): (event: RuntimeEvent, runtimeId?: string) => void {
  const queue = useRef<BufferedRuntimeEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastFlushAt = useRef(0);
  const scheduledFor = useRef<number | undefined>(undefined);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const flush = useCallback((): void => {
    timer.current = undefined;
    const now = performance.now();
    const lag = scheduledFor.current === undefined ? 0 : now - scheduledFor.current;
    lastFlushAt.current = now;
    scheduledFor.current = undefined;
    const pending = queue.current;
    if (!pending.length) return;
    queue.current = [];
    const folded = coalesceRuntimeEvents(pending);
    if (pending.length >= SLOW_BATCH_SIZE || lag >= SLOW_FLUSH_LAG_MS) {
      diagnostics.warn("event-buffer", "renderer_behind", {
        received: pending.length,
        applied: folded.length,
        lagMs: Math.round(lag),
      });
    }
    const startedAt = performance.now();
    for (const { event, runtimeId } of folded) {
      applyRef.current(event, runtimeId);
    }
    const applyMs = performance.now() - startedAt;
    if (applyMs >= SLOW_FLUSH_LAG_MS) {
      diagnostics.warn("event-buffer", "apply_slow", { applied: folded.length, applyMs: Math.round(applyMs) });
    }
  }, []);

  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  return useCallback((event: RuntimeEvent, runtimeId?: string): void => {
    queue.current.push({ event, runtimeId });
    if (timer.current !== undefined) return;
    // Leading edge: a lone event after a pause waits only for the next task, so
    // only a genuine burst ever pays the interval.
    const elapsed = performance.now() - lastFlushAt.current;
    const wait = Math.max(0, flushIntervalMs - elapsed);
    scheduledFor.current = performance.now() + wait;
    timer.current = setTimeout(flush, wait);
  }, [flush, flushIntervalMs]);
}
