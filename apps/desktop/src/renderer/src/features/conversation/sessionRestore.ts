import { SESSION_OPEN_SUPERSEDED_ERROR, type SessionSnapshot } from "@coilcoil/runtime-protocol";
import type { BufferedRuntimeEvent } from "../../hooks/useBufferedRuntimeEvents";

interface RestoreWindow {
  path: string;
  runtimeId?: string;
  events: BufferedRuntimeEvent[];
  reject(error: Error): void;
}

/** One bounded navigation window: snapshot first, then only newer stream events. */
export class SessionRestoreController {
  private pending?: RestoreWindow;

  constructor(
    private readonly applyEvent: (entry: BufferedRuntimeEvent) => void,
    private readonly runtimePath: (runtimeId: string) => string | undefined,
    private readonly limits = { timeoutMs: 30_000, maxEvents: 1_024 },
  ) {}

  handle(entry: BufferedRuntimeEvent): void {
    const pending = this.pending;
    const path = entry.event.type === "session_snapshot" ? entry.event.snapshot.session.path
      : entry.runtimeId ? this.runtimePath(entry.runtimeId) : undefined;
    if (!pending || !entry.runtimeId || (entry.runtimeId !== pending.runtimeId && path !== pending.path)) {
      this.applyEvent(entry);
      return;
    }
    if (path === pending.path) pending.runtimeId = entry.runtimeId;
    if (pending.events.length >= this.limits.maxEvents) {
      pending.reject(new Error("会话恢复期间事件过多，请重新打开对话。"));
      return;
    }
    pending.events.push(entry);
  }

  cancel(replay = true): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.reject(new Error(SESSION_OPEN_SUPERSEDED_ERROR));
    // Navigation has not replaced the visible state yet. Finish its queued
    // projections so background activity and unread badges retain their state.
    if (replay) for (const entry of pending.events) this.applyEvent(entry);
  }

  async restore(
    path: string, runtimeId: string | undefined,
    load: () => Promise<SessionSnapshot>, applySnapshot: (snapshot: SessionSnapshot) => void,
  ): Promise<void> {
    this.cancel();
    let reject!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, fail) => { reject = fail; });
    const pending: RestoreWindow = { path, runtimeId, events: [], reject };
    this.pending = pending;
    const timer = setTimeout(() => reject(new Error("会话恢复超时，请重新打开对话。")), this.limits.timeoutMs);
    try {
      const snapshot = await Promise.race([load(), stopped]);
      if (this.pending !== pending) return;
      this.pending = undefined;
      applySnapshot(snapshot);
      const revision = snapshot.messageRevision ?? 0;
      for (const entry of pending.events) {
        if (entry.runtimeId !== snapshot.runtimeId) continue;
        if (entry.event.type === "session_snapshot" && (entry.event.snapshot.messageRevision ?? 0) <= revision) continue;
        if ("revision" in entry.event && entry.event.revision <= revision) continue;
        this.applyEvent(entry);
      }
    } finally {
      clearTimeout(timer);
      pending.events = [];
      if (this.pending === pending) this.pending = undefined;
    }
  }
}
