import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import * as pty from "node-pty";
import { scanTerminalProcesses, stopTerminal } from "../extensions/terminal/process-cleanup.ts";
import type { ManagedTerminal } from "../extensions/terminal/types.ts";

function ownPty(command = "printf READY; read answer") {
  const child = pty.spawn("/bin/sh", ["-c", command], { name: "xterm", cols: 80, rows: 24, cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" } });
  const session: ManagedTerminal = {
    id: `test-${child.pid}`, ownerToolCallId: "fixture", name: "fixture", command, cwd: tmpdir(), pid: child.pid, pty: child,
    status: "running", startedAt: Date.now(), stopRequested: false, background: false, outputMode: "log", outputPath: "",
    buffer: "", bufferStart: 0, outputEnd: 0, defaultCursor: 0, screen: { line: "", cursor: 0, ansiRemainder: "", revision: 0, events: [] },
    lastOutputAt: Date.now(), notifications: [], listeners: new Set(),
  };
  const ready = new Promise<void>((resolve) => child.onData((data) => {
    session.buffer += data;
    if (session.buffer.includes("READY")) resolve();
  }));
  const exited = new Promise<void>((resolve) => child.onExit(({ exitCode, signal }) => {
    session.exitCode = exitCode;
    session.signal = signal;
    session.endedAt = Date.now();
    session.status = session.stopRequested ? "stopped" : "exited";
    for (const listener of session.listeners) listener();
    resolve();
  }));
  const close = async () => {
    if (session.endedAt === undefined) child.write("done\r");
    await exited;
  };
  return { session, ready, exited, close };
}

test("an exited PTY's cleanup leaves a new shell on the reused TTY alive", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const first = ownPty();
  t.after(first.close);
  await first.ready;
  await scanTerminalProcesses(first.session, new Set());
  assert.ok(first.session.processIdentity?.birth, "initial discovery must persist the original root identity");
  await first.close();
  const second = ownPty();
  t.after(second.close);
  await second.ready;
  await scanTerminalProcesses(second.session, new Set());
  if (second.session.tty !== first.session.tty) t.diagnostic("Another test allocated the released TTY; pure ownership tests also cover exact TTY reuse.");
  const report = await stopTerminal(first.session, true, 100);
  assert.deepEqual(report.targetedPids, []);
  assert.deepEqual(report.residualPids, []);
  assert.equal(report.verified, true);
  assert.equal(second.session.endedAt, undefined, "old cleanup must not stop the new shell");
  const secondScan = await scanTerminalProcesses(second.session, new Set());
  assert.equal(secondScan.rootAlive, true);
});

test("a short command that exits before discovery remains successfully cleaned up", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const command = ownPty("printf done");
  await command.exited;
  assert.equal(command.session.processIdentity, undefined);
  const report = await stopTerminal(command.session, false, 100);
  assert.equal(report.verified, true);
  assert.deepEqual(report.targetedPids, []);
  assert.equal(command.session.status, "exited");
  assert.equal(command.session.exitCode, 0);
});

test("later root verification resolves the initial spawn-helper uncertainty", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const command = ownPty();
  t.after(command.close);
  await command.ready;
  // Simulate the first shared discovery expiring while the helper still has
  // no controlling TTY. All subsequent scans inspect this real test process.
  command.session.processScanPromise = Promise.resolve({
    table: new Map(), owned: [], rootAlive: false, unverifiedPids: [command.session.pid],
  }).finally(() => { command.session.processScanPromise = undefined; });
  const report = await stopTerminal(command.session, false, 500);
  assert.equal(report.verified, true);
  assert.deepEqual(report.unverifiedPids ?? [], []);
  assert.deepEqual(report.residualPids, []);
  assert.equal(command.session.status, "stopped");
});

test("an observed root identity conflict is reported without signalling the replacement", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const replacement = ownPty();
  t.after(replacement.close);
  await replacement.ready;
  await scanTerminalProcesses(replacement.session, new Set());
  const stale: ManagedTerminal = {
    ...replacement.session, status: "exited", endedAt: Date.now() - 1, processDescendants: new Map(),
    processIdentity: { ...replacement.session.processIdentity!, birth: "Wed Oct 28 00:00:00 2020" },
  };
  const report = await stopTerminal(stale, true, 100);
  assert.equal(report.verified, false);
  assert.deepEqual(report.unverifiedPids, [replacement.session.pid]);
  assert.deepEqual(report.targetedPids, []);
  assert.equal(report.escalatedToSigkill, false);
  assert.equal(stale.status, "cleanup_failed");
  assert.equal(replacement.session.endedAt, undefined);
});
