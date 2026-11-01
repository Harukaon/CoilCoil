import assert from "node:assert/strict";
import test from "node:test";
import { collectOwnedProcesses, initialRootIdentity, parseProcessTable, scanTerminalProcesses } from "../extensions/terminal/process-cleanup.ts";
import type { ManagedTerminal, ProcessIdentity, ProcessRecord } from "../extensions/terminal/types.ts";

const firstBirth = "Wed Oct 28 08:00:00 2026";
const nextBirth = "Wed Oct 28 08:00:01 2026";
function record(pid: number, ppid: number, overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return { pid, ppid, pgid: pid, tty: "ttys002", state: "S", birth: firstBirth, ...overrides };
}
const table = (...records: ProcessRecord[]) => new Map(records.map((entry) => [entry.pid, entry]));

test("the initial scan waits for the spawn helper to acquire its controlling TTY", () => {
  const startedAt = Date.parse(`${firstBirth} UTC`) + 500;
  assert.equal(initialRootIdentity(record(100, process.pid, { tty: "??" }), 100, startedAt, false), undefined);
  const shell = record(100, process.pid);
  const identity = initialRootIdentity(shell, 100, startedAt, false)!;
  assert.equal(identity.tty, "ttys002");
  assert.equal(collectOwnedProcesses(table(shell, record(200, 100)), 100, identity, new Map()).rootAlive, true);
  assert.equal(initialRootIdentity(shell, 100, startedAt, true), undefined);
});

test("stopping during the initial unknown-TTY sample waits without preserving a false identity conflict", async () => {
  const session = { pid: 100, startedAt: Date.parse(`${firstBirth} UTC`) + 500 } as ManagedTerminal;
  let reads = 0;
  const scan = await scanTerminalProcesses(session, new Set(), async () => {
    reads += 1;
    return reads === 1 ? table(record(100, process.pid, { tty: "??" })) : table(record(100, process.pid), record(200, 100));
  });
  assert.equal(reads, 2);
  assert.equal(scan.rootAlive, true);
  assert.deepEqual(scan.unverifiedPids, []);
  assert.equal(session.processIdentity?.tty, "ttys002");
  assert.equal(session.processDescendants?.get(200)?.birth, firstBirth, "initial descendant identities must survive into cleanup");
});

test("an onExit event arriving before an older ps snapshot is returned is rechecked", async () => {
  const root = record(100, process.pid);
  const session = { pid: 100, startedAt: Date.parse(`${firstBirth} UTC`) + 500, processIdentity: root } as ManagedTerminal;
  let reads = 0;
  const scan = await scanTerminalProcesses(session, new Set(), async () => {
    reads += 1;
    session.endedAt = Date.now();
    return reads === 1 ? table(root) : table();
  });
  assert.equal(reads, 2);
  assert.equal(scan.rootAlive, false);
  assert.deepEqual(scan.unverifiedPids, []);
});

test("initial discovery and Stop share in-flight sampling instead of overwriting each other's identities", async () => {
  const session = { pid: 100, startedAt: Date.parse(`${firstBirth} UTC`) + 500 } as ManagedTerminal;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const reader = async () => { reads += 1; await gate; return table(record(100, process.pid), record(200, 100)); };
  const initialPids = new Set<number>();
  const stopPids = new Set<number>();
  const initial = scanTerminalProcesses(session, initialPids, reader);
  const stopping = scanTerminalProcesses(session, stopPids, reader);
  release();
  const [a, b] = await Promise.all([initial, stopping]);
  assert.equal(reads, 1);
  assert.equal(a, b);
  assert.deepEqual([...initialPids], [200]);
  assert.deepEqual([...stopPids], [200]);
  assert.equal(session.processScanPromise, undefined);
});

test("a terminal's old TTY never claims a new shell after the original shell exits", () => {
  const root = record(100, 50);
  const scan = collectOwnedProcesses(table(record(300, 50, { birth: nextBirth }), record(301, 300, { birth: nextBirth })), 100, root, new Map(), true);
  assert.deepEqual(scan.owned, []);
  assert.equal(scan.rootAlive, false);
  assert.deepEqual(scan.unverifiedPids, [], "unrelated TTY users are not part of this terminal's cleanup report");
});

test("a reused tracked PID cannot claim a replacement process or its descendants", () => {
  const known = new Map<number, ProcessIdentity>([[200, record(200, 100)]]);
  const scan = collectOwnedProcesses(table(record(200, 1, { birth: nextBirth }), record(201, 200, { birth: nextBirth })), 100, record(100, 50), known, true);
  assert.deepEqual(scan.owned, []);
  assert.deepEqual(scan.unverifiedPids, [200]);
});

test("reused root PIDs never become ownership anchors", () => {
  for (const rootExited of [false, true]) {
    const scan = collectOwnedProcesses(table(record(100, 50, { birth: nextBirth }), record(201, 100, { birth: nextBirth })), 100, record(100, 50), new Map(), rootExited);
    assert.deepEqual(scan.owned, []);
    assert.equal(scan.rootAlive, false);
    assert.deepEqual(scan.unverifiedPids, [100]);
  }
  const sameSecondReuse = collectOwnedProcesses(table(record(100, 50), record(201, 100)), 100, record(100, 50), new Map(), true);
  assert.deepEqual(sameSecondReuse.owned, []);
  assert.equal(sameSecondReuse.rootAlive, false, "onExit permanently invalidates the original root even within the birth timestamp's precision");
});

test("confirmed parent chains preserve children in separate process groups without adopting TTY peers", () => {
  const root = record(100, 50);
  const child = record(200, 100);
  const grandchild = record(201, 200, { pgid: 200 });
  const peer = record(300, 50);
  const scan = collectOwnedProcesses(table(grandchild, peer, child, root), 100, root, new Map());
  assert.equal(scan.rootAlive, true);
  assert.deepEqual(scan.owned.map((entry) => entry.pid), [201, 200]);
  assert.deepEqual(scan.unverifiedPids, []);
});

test("a captured descendant retains its identity after reparenting and can seed new children", () => {
  const child = record(200, 100);
  const scan = collectOwnedProcesses(table(record(200, 1), record(201, 200)), 100, record(100, 50), new Map([[200, child]]), true);
  assert.deepEqual(scan.owned.map((entry) => entry.pid).sort(), [200, 201]);
  assert.equal(scan.rootAlive, false);
});

test("a verified live parent chain still owns a child that changed its process group", () => {
  const root = record(100, 50);
  const childBeforeSetpgid = record(200, 100, { pgid: 100 });
  const scan = collectOwnedProcesses(table(root, record(200, 100)), 100, root, new Map([[200, childBeforeSetpgid]]));
  assert.deepEqual(scan.owned.map((entry) => entry.pid), [200]);
  assert.deepEqual(scan.unverifiedPids, []);
});

test("changed process group or TTY with a matching low-resolution birth stamp remains unverified", () => {
  for (const overrides of [{ pgid: 300 }, { tty: "ttys009" }]) {
    const scan = collectOwnedProcesses(table(record(200, 1, overrides)), 100, record(100, 50), new Map([[200, record(200, 100)]]), true);
    assert.deepEqual(scan.owned, []);
    assert.deepEqual(scan.unverifiedPids, [200]);
  }
});

test("process table parsing records birth identity without Darwin sess pointers", () => {
  const parsed = parseProcessTable("  100  50 100 Ss+ ttys002 Wed Oct 28 08:00:00 2026\n");
  assert.deepEqual(parsed.get(100), record(100, 50, { state: "Ss+" }));
  assert.throws(() => parseProcessTable("100 50 100 S ttys002 invalid date"), /创建时间/);
});
