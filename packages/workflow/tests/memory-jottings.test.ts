import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectMemoryInputs, completeMemoryInputs, installMemoryWritePolicy, memoryIdleCoordinator, pendingMemoryNotes } from "../extensions/memory-jottings.ts";
import { ensureProjectMemory, resolveProjectMemoryPaths } from "../extensions/memory-storage.ts";
import projectMemoryExtension from "../extensions/project-memory.ts";
import memoryWorkerGuard from "../extensions/memory-worker-guard.ts";
import { buildMemoryWorkerLaunch, launchMemoryWorker } from "../extensions/memory-worker.ts";

function harness() {
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const commands = new Map<string, any>();
  const events: any[] = [];
  const pi = {
    on(name: string, callback: (...args: any[]) => any) { handlers.set(name, [...handlers.get(name) ?? [], callback]); },
    registerCommand(name: string, value: unknown) { commands.set(name, value); },
    events: { on: () => () => {}, emit: (_name: string, data: unknown) => events.push(data) },
  };
  return { pi, handlers, commands, events };
}
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "coil-jottings-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const cwd = join(root, "workspace"), memoryRoot = join(root, "memory"), agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const paths = await resolveProjectMemoryPaths(cwd, memoryRoot);
  await ensureProjectMemory(paths);
  return { root, cwd, memoryRoot, agentDir, paths };
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("normal agents can write jottings but cannot overwrite curated, global, sibling or symlinked memory", async (t) => {
  const { root, cwd, paths, memoryRoot } = await setup(t);
  const h = harness();
  installMemoryWritePolicy(h.pi as any, { PI_PROJECT_MEMORY_DIR: memoryRoot });
  const call = (path: string, name = "write") => h.handlers.get("tool_call")![0]({ toolName: name, input: { path } }, { cwd });
  assert.equal(await call(join(paths.notesDir, "candidate.md")), undefined);
  assert.equal(await call(join(root, "project-code.ts")), undefined);
  for (const path of [paths.memoryFile, paths.globalMemoryFile, join(paths.entriesDir, "fact.md"), join(memoryRoot, "sibling", "jottings", "other.md")]) {
    const result = await call(path, "edit");
    assert.equal(result.block, true);
    assert.match(result.reason, /随手记/);
  }
  await symlink(paths.memoryFile, join(paths.notesDir, "escape.md"));
  assert.equal((await call(join(paths.notesDir, "escape.md"))).block, true);
  const outside = join(root, "outside.md"); await writeFile(outside, "outside");
  await symlink(outside, join(paths.notesDir, "external.md"));
  assert.equal((await call(join(paths.notesDir, "external.md"))).block, true);
});

test("dream input batching isolates workspace history and acknowledges only captured note revisions", async (t) => {
  const { root, cwd, paths } = await setup(t);
  const sessionDir = join(root, "sessions"); await mkdir(sessionDir);
  const first = join(sessionDir, "first.jsonl"), second = join(sessionDir, "second.jsonl"), other = join(sessionDir, "other.jsonl");
  await writeFile(first, JSON.stringify({ type: "session", cwd }) + "\nfirst");
  await writeFile(second, JSON.stringify({ type: "session", cwd: await realpath(cwd) }) + "\nsecond");
  await writeFile(other, JSON.stringify({ type: "session", cwd: root }) + "\nother");
  const note = join(paths.notesDir, "candidate.md"); await writeFile(note, "unreviewed fact");
  const batch = await collectMemoryInputs(paths, await realpath(first), sessionDir);
  assert.deepEqual(new Set(batch.sessionFiles), new Set([await realpath(first), await realpath(second)]));
  assert.deepEqual(batch.noteFiles, [note]);
  await writeFile(note, "corrected while worker is running");
  await completeMemoryInputs(paths, batch);
  const next = await collectMemoryInputs(paths, await realpath(first), sessionDir);
  assert.deepEqual(next.sessionFiles, []);
  assert.deepEqual(next.noteFiles, [note], "a concurrent edit must remain pending");
  await completeMemoryInputs(paths, next);
  assert.deepEqual(await pendingMemoryNotes(paths), []);
  assert.equal(await readFile(note, "utf8"), "corrected while worker is running", "curation preserves raw provenance");
});

test("workspace idle scheduling waits for every sibling and coalesces activity into one run", async () => {
  const key = `idle-${Date.now()}-${Math.random()}`;
  const first = memoryIdleCoordinator(key, 20), second = memoryIdleCoordinator(key, 20);
  let runs = 0;
  first.start(); second.start();
  await first.settled(async () => { runs++; });
  await delay(35); assert.equal(runs, 0);
  second.close();
  await delay(5); first.start();
  await delay(35); assert.equal(runs, 0, "a new turn resets inactivity");
  await first.settled(async () => { runs++; });
  await delay(40); assert.equal(runs, 1);
  await delay(40); assert.equal(runs, 1, "there is no recurring provider polling");
  first.cancel(); second.cancel();
});

test("notes-only manual curation uses the globally selected model and isolated input permissions", async (t) => {
  const { cwd, agentDir, paths, memoryRoot } = await setup(t);
  const note = join(paths.notesDir, "decision.md"); await writeFile(note, "possible lasting decision");
  await writeFile(join(agentDir, "memory-settings.json"), JSON.stringify({ workerProvider: "claude-second", workerModelId: "selected-model" }));
  const h = harness(); let launch: ReturnType<typeof buildMemoryWorkerLaunch> | undefined;
  const child = new EventEmitter() as any; child.unref = () => {};
  projectMemoryExtension(h.pi as any, { env: { PI_CODING_AGENT_DIR: agentDir, PI_PROJECT_MEMORY_DIR: memoryRoot }, spawnWorker: (value) => { launch = value; return child; } });
  await h.commands.get("memory").handler("", { cwd, hasUI: false, model: undefined, sessionManager: { getSessionFile: () => undefined } });
  assert.ok(launch);
  assert.equal(launch.args[launch.args.indexOf("--provider") + 1], "claude-second");
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "selected-model");
  assert.deepEqual(JSON.parse(launch.env.PI_MEMORY_WORKER_SESSION_FILES!), []);
  assert.match(launch.args.join(" "), /subscription-extension\.ts/);
  assert.match(launch.args.at(-1)!, /decision\.md/);
  const guard = harness(); memoryWorkerGuard(guard.pi as any, { env: launch.env });
  const check = guard.handlers.get("tool_call")![0];
  assert.equal(await check({ toolName: "read", input: { path: note } }, { cwd }), undefined);
  assert.equal((await check({ toolName: "write", input: { path: note } }, { cwd })).block, true);
  assert.equal(await check({ toolName: "write", input: { path: paths.memoryFile } }, { cwd }), undefined);
  child.emit("exit", 0, null);
  for (let index = 0; index < 30 && !h.events.some((event) => event.state === "succeeded"); index++) await delay(10);
  assert.ok(h.events.some((event) => event.state === "succeeded"));
  assert.deepEqual(await pendingMemoryNotes(paths), []);
});

test("workspace worker lease covers completion bookkeeping, not only the child process", async (t) => {
  const { root, paths } = await setup(t);
  const sessionFile = join(root, "session.jsonl"); await writeFile(sessionFile, "session");
  const child = new EventEmitter() as any; child.unref = () => {};
  const request = { paths, sessionFile, provider: "test", model: "test" };
  let release!: () => void;
  const completion = new Promise<void>((done) => { release = done; });
  assert.equal(await launchMemoryWorker(request, { spawnWorker: () => child }, { onComplete: () => completion }), "started");
  child.emit("exit", 0, null);
  assert.equal(await launchMemoryWorker(request, { spawnWorker: () => { throw new Error("must remain leased"); } }), "busy");
  release();
  await delay(20);
});

test("inactivity drains a finite jotting backlog in batches and stops when no input remains", async (t) => {
  const { cwd, agentDir, paths, memoryRoot } = await setup(t);
  await writeFile(join(agentDir, "memory-settings.json"), JSON.stringify({ autoSummarize: true }));
  for (let index = 0; index < 51; index++) await writeFile(join(paths.notesDir, `note-${index}.md`), `candidate ${index}`);
  const h = harness(); let runs = 0;
  projectMemoryExtension(h.pi as any, {
    env: { PI_CODING_AGENT_DIR: agentDir, PI_PROJECT_MEMORY_DIR: memoryRoot }, idleDelayMs: 10,
    spawnWorker: () => { runs++; const child = new EventEmitter() as any; child.unref = () => {};
      setTimeout(() => child.emit("exit", 0, null), 1); return child; },
  });
  const ctx = { cwd, hasUI: false, model: { provider: "test", id: "test" }, sessionManager: { getSessionFile: () => undefined } };
  await h.handlers.get("session_start")![0]({}, ctx);
  for (let index = 0; index < 100 && (await pendingMemoryNotes(paths)).length; index++) await delay(10);
  assert.equal(runs, 2);
  assert.deepEqual(await pendingMemoryNotes(paths), []);
  await delay(40); assert.equal(runs, 2, "success does not create an unbounded background loop");
  assert.equal(await readFile(paths.memoryFile, "utf8"), "", "raw notes do not promote themselves to long-term memory");
  await h.handlers.get("session_shutdown")![0]({}, ctx);
});

test("cancelling one idle owner leaves its sibling's pending dream intact", async () => {
  const key = `cancel-${Date.now()}-${Math.random()}`;
  const first = memoryIdleCoordinator(key, 10), sibling = memoryIdleCoordinator(key, 10);
  let runs = 0;
  first.start(); sibling.start();
  await first.settled(async () => { runs++; });
  sibling.cancel();
  await delay(30);
  assert.equal(runs, 1);
  first.cancel();
});

test("current-session input also rejects a foreign workspace and ignores directories named jsonl", async (t) => {
  const { root, cwd, paths } = await setup(t);
  const sessions = join(root, "sessions"); await mkdir(sessions);
  await mkdir(join(sessions, "not-a-file.jsonl"));
  const foreign = join(sessions, "foreign.jsonl");
  await writeFile(foreign, JSON.stringify({ type: "session", cwd: root }));
  assert.deepEqual((await collectMemoryInputs(paths, foreign, sessions)).sessionFiles, []);
  const own = join(sessions, "own.jsonl");
  await writeFile(own, JSON.stringify({ type: "session", cwd }));
  assert.deepEqual((await collectMemoryInputs(paths, foreign, sessions)).sessionFiles, [await realpath(own)]);
});

test("activity starting during asynchronous worker setup defers spawn and retains the pending dream", async (t) => {
  const { root, paths } = await setup(t);
  const sessionFile = join(root, "session.jsonl"); await writeFile(sessionFile, "session");
  const first = memoryIdleCoordinator(paths.projectMemoryDir, 10), sibling = memoryIdleCoordinator(paths.projectMemoryDir, 10);
  let spawns = 0;
  const child = new EventEmitter() as any; child.unref = () => {};
  const launch = (canStart: () => boolean) => launchMemoryWorker({ paths, sessionFile, provider: "test", model: "test" },
    { spawnWorker: () => { spawns++; return child; } }, { canStart });
  await first.settled(async (canStart) => {
    const pending = launch(canStart);
    sibling.start();
    // Even a short turn that finishes before setup does must restart the quiet interval.
    sibling.close();
    assert.equal(await pending, "deferred");
    first.enqueue(async (allowed) => { assert.equal(await launch(allowed), "started"); });
  }, true);
  assert.equal(spawns, 0);
  for (let index = 0; index < 30 && !spawns; index++) await delay(10);
  assert.equal(spawns, 1);
  child.emit("exit", 0, null);
  first.cancel(); sibling.cancel();
  await delay(20);
});
