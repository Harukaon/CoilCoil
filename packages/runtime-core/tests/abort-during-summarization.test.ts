import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent, RuntimeSummaryEvent } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";
import { ToolRunIds } from "../src/tool-run-ids.js";

interface RuntimeInternals {
  active?: Record<string, any>;
  promptStarting: boolean;
  handleSessionEvent(event: unknown): void;
}

function runningSummary(kind: "compaction" | "branch_summary"): RuntimeSummaryEvent {
  return { id: `${kind}-1`, kind, status: "running", timestamp: Date.now(), active: true, reason: "threshold" };
}

function createAbortHarness(root: string) {
  const events: RuntimeEvent[] = [];
  const calls: string[] = [];
  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    onEvent: (event) => events.push(event),
  });
  const internals = runtime as unknown as RuntimeInternals;
  const session = {
    isStreaming: false,
    messages: [],
    // Pi resolves this only once the session is idle, which a running
    // summarization delays; a promise that never settles stands in for that.
    abort: () => { calls.push("abort"); return new Promise<void>(() => undefined); },
    abortCompaction: () => { calls.push("abortCompaction"); },
    clearQueue: () => ({ steering: [] as string[], followUp: [] as string[] }),
    abortBranchSummary: () => { calls.push("abortBranchSummary"); },
  };
  internals.active = {
    cwd: root,
    session: session as unknown as AgentSession,
    unsubscribe: () => undefined,
    tools: new Map(),
    subagents: new Map(),
    terminals: new Map(),
    plan: [],
    project: { cwd: root, files: [], changes: [], terminals: [], plan: [], refreshedAt: 0 },
    messageIds: new WeakMap(),
    messageRevision: 0,
    pendingUserPrompts: [],
    promptQueue: [],
    promptDrainInProgress: false,
    nextTimelineOrder: 0,
    toolRunIds: new ToolRunIds(),
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: { on: () => undefined } as never,
  };
  return { runtime, internals, events, calls, session };
}

test("stopping cancels the compaction that is holding the turn open", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-abort-compaction-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = createAbortHarness(root);
  harness.session.isStreaming = true;
  harness.internals.active!.summaryActivity = runningSummary("compaction");

  const result = await harness.runtime.abort();

  assert.equal(result.aborted, true);
  // Pi's own abort waits for the session to go idle, and a running compaction
  // holds it there: cancelling the summary is what lets the stop land at all.
  assert.deepEqual(harness.calls, ["abortCompaction", "abort"]);
});

test("stopping a branch summary cancels that summary, not compaction", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-abort-branch-summary-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = createAbortHarness(root);
  harness.internals.active!.summaryActivity = runningSummary("branch_summary");

  const result = await harness.runtime.abort();

  assert.equal(result.aborted, true);
  assert.deepEqual(harness.calls, ["abortBranchSummary"]);
});

test("a finished summary is not cancelled again by a later stop", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-abort-settled-summary-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = createAbortHarness(root);
  harness.internals.active!.summaryActivity = { ...runningSummary("compaction"), status: "succeeded" };

  const result = await harness.runtime.abort();

  assert.equal(result.aborted, false);
  assert.deepEqual(harness.calls, []);
});

test("a compaction Pi starts after the stop is cancelled instead of waited out", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-abort-late-compaction-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = createAbortHarness(root);
  harness.session.isStreaming = true;
  await harness.runtime.abort();
  assert.deepEqual(harness.calls, ["abort"], "nothing is summarizing when the stop is taken");

  // Stopping during a tool call leaves the turn that called it as the last
  // assistant message, so Pi's threshold check runs and starts a summary for
  // the turn the user just stopped — after the stop was delivered.
  harness.internals.handleSessionEvent({ type: "compaction_start", reason: "threshold" });
  // Pi creates the controller right after announcing the summary, so the
  // cancel lands on the next tick rather than during the event.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(harness.calls, ["abort", "abortCompaction"]);
});

test("a compaction started by a turn nobody stopped is left alone", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-compaction-untouched-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = createAbortHarness(root);
  harness.session.isStreaming = true;

  harness.internals.handleSessionEvent({ type: "compaction_start", reason: "threshold" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(harness.calls, []);
});

test("a stop pressed while the prompt is still being prepared lands on the run it was aimed at", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-abort-before-run-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = createAbortHarness(root);
  // Pi compacts before it sends a prompt: no run exists yet, so `isStreaming`
  // reads false and there is nothing for `AgentSession.abort()` to abort.
  harness.internals.promptStarting = true;
  harness.internals.active!.summaryActivity = runningSummary("compaction");

  const result = await harness.runtime.abort();
  assert.equal(result.aborted, true);
  // The press is answered right away, even though nothing can carry it yet.
  assert.equal(result.aborting, true);
  assert.deepEqual(harness.calls, ["abortCompaction"]);
  assert.equal(harness.internals.active!.abortOnStart, true);
  assert.equal(harness.internals.active!.aborting, true);

  // The cancelled summary lets Pi send that prompt; the remembered stop has to
  // reach the run before it says anything to the model.
  harness.internals.handleSessionEvent({ type: "agent_start" });
  assert.deepEqual(harness.calls, ["abortCompaction", "abort"]);
  assert.equal(harness.internals.active!.abortOnStart, false);
  assert.equal(harness.internals.active!.aborting, true);

  // Only that run is stopped: the next one starts unaborted.
  harness.internals.handleSessionEvent({ type: "agent_start" });
  assert.deepEqual(harness.calls, ["abortCompaction", "abort"]);
});
