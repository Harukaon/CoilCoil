import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { acquireMaintenanceLock, compressDiagnosticArchive, listDiagnosticLogFiles, maintainDiagnosticArchives, readDiagnosticLogFile } from "../src/archive.ts";
import { DiagnosticLog } from "../src/log-file.ts";
import { errorInfo, REDACTED } from "../src/redact.ts";

function directory(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "coil-log-archives-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const policy = { maxTotalBytes: 1024 * 1024, retentionDays: 7, errorRetentionDays: 30 };
const entries = (path: string) => readDiagnosticLogFile(path).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("concurrent writers in separate processes keep every record through rotations and close", async (t) => {
  const root = directory(t);
  const module = new URL("../src/log-file.ts", import.meta.url).href;
  const source = `import { DiagnosticLog } from ${JSON.stringify(module)};
    const log = new DiagnosticLog({ directory: process.argv[1], process: 'runtime', maxBytes: 500 });
    for (let i = 0; i < 30; i++) log.info('concurrent', process.argv[2] + '-' + i);
    for (let i = 0; i < 4; i++) log.error('concurrent', process.argv[2] + '-error-' + i, new Error('failure ' + i));
    await log.close();`;
  await Promise.all(["a", "b"].map((id) => promisify(execFile)(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source, root, id], { cwd: process.cwd() })));
  const files = listDiagnosticLogFiles(root);
  assert.ok(files.length > 4);
  assert.ok(files.every((file) => file.compressed));
  const normal = files.filter((file) => !file.errors).flatMap((file) => entries(file.path));
  assert.equal(normal.length, 68);
  assert.equal(new Set(normal.map((entry) => entry.event)).size, 68);
  assert.equal(files.filter((file) => file.errors).flatMap((file) => entries(file.path)).length, 8);
});

test("restart compresses dead writer files and the legacy rollover without deleting their records", async (t) => {
  const root = directory(t);
  const orphan = join(root, "runtime-9999999-1234-aabb.jsonl");
  const legacy = join(root, "main.jsonl.1");
  const line = JSON.stringify({ ts: Date.now(), event: "before_crash" }) + "\n";
  writeFileSync(orphan, line);
  writeFileSync(`${orphan}.gz`, gzipSync(line)); // Crash after gzip rename but before source unlink.
  writeFileSync(legacy, line);
  await maintainDiagnosticArchives(root, policy);
  for (const original of [orphan, legacy]) {
    assert.equal(existsSync(original), false);
    assert.equal(readDiagnosticLogFile(`${original}.gz`), line);
  }
});

test("failed gzip installation preserves the source and removes only its temporary output", async (t) => {
  const root = directory(t);
  const raw = join(root, "runtime-9999999-1234-aabb.archive-1234-aabb.jsonl");
  writeFileSync(raw, "original evidence\n");
  mkdirSync(`${raw}.gz`);
  await assert.rejects(compressDiagnosticArchive(raw));
  assert.equal(readFileSync(raw, "utf8"), "original evidence\n");
  assert.ok(readdirSync(root).every((name) => !name.endsWith(".tmp")));
});

function archive(root: string, error: boolean, ageDays: number, suffix: string): string {
  const path = join(root, `runtime-9999999-1234-aabb${error ? ".errors" : ""}.archive-1234-${suffix}.jsonl.gz`);
  writeFileSync(path, gzipSync(JSON.stringify({ event: suffix, detail: randomBytes(150).toString("hex") }) + "\n"));
  const time = new Date(Date.now() - ageDays * 86_400_000);
  utimesSync(path, time, time);
  return path;
}

test("ordinary archives expire earlier, and a shared budget evicts ordinary records before errors", async (t) => {
  const root = directory(t);
  const ordinary = archive(root, false, 8, "aa");
  const error = archive(root, true, 8, "bb");
  const expiredError = archive(root, true, 31, "cc");
  await maintainDiagnosticArchives(root, policy);
  assert.equal(existsSync(ordinary), false);
  assert.equal(existsSync(error), true);
  assert.equal(existsSync(expiredError), false);
  const recent = archive(root, false, 0, "dd");
  const budget = statSync(error).size + 1;
  await maintainDiagnosticArchives(root, { ...policy, maxTotalBytes: budget });
  assert.equal(existsSync(recent), false);
  assert.equal(existsSync(error), true, "an older error outranks a newer ordinary archive");
  await maintainDiagnosticArchives(root, { ...policy, maxTotalBytes: 1 });
  assert.equal(existsSync(error), false, "errors also obey the finite total budget");
});

test("errors are unsampled and mirrored even when the configured minimum level is error", async (t) => {
  const root = directory(t);
  const log = new DiagnosticLog({ directory: root, process: "memory", level: "error", maxBytes: 500 });
  for (let i = 0; i < 25; i++) {
    log.info("worker", "ignored");
    log.error("worker", `failed_${i}`, new Error("missing required field: url"));
  }
  await log.close();
  const errors = listDiagnosticLogFiles(root).filter((file) => file.errors).flatMap((file) => entries(file.path));
  assert.equal(errors.length, 25);
  assert.equal(new Set(errors.map((entry) => entry.event)).size, 25);
  assert.ok(errors.every((entry) => entry.error.stack.includes("missing required field: url")));
});

test("relayed entries redact credentials and content while preserving diagnostic metadata and error stacks", async (t) => {
  const root = directory(t);
  const log = new DiagnosticLog({ directory: root, process: "main" });
  log.writeEntries([{ ts: Date.now(), level: "error", process: "renderer", scope: "tool", event: "failed",
    data: { requestBody: "private request", messages: [{ content: "private message" }], arguments: { path: "private argument" },
      result: "private result", inputTokens: 1234, outputTokens: 9, source: "/tmp/source.ts",
      paramShape: { type: "object", keys: ["path", "limit"], fields: { arguments: { type: "object", fields: { content: { type: "string", bytes: 30, value: "private shape value" } } } } }, authorization: "Bearer private-credential" },
    error: { message: "missing required field: url; Bearer private-credential", stack: "Error: invalid schema\n    at test (/tmp/source.ts:1:2)" } }]);
  const text = readFileSync(log.filePath, "utf8");
  for (const secret of ["private request", "private message", "private argument", "private result", "private-credential", "private shape value"]) assert.ok(!text.includes(secret));
  const [entry] = entries(log.filePath);
  assert.equal(entry.data.inputTokens, 1234);
  assert.equal(entry.data.outputTokens, 9);
  assert.equal(entry.data.source, "/tmp/source.ts");
  assert.deepEqual(entry.data.paramShape, { type: "object", keys: ["path", "limit"], fields: { arguments: { type: "object", fields: { content: { type: "string", bytes: 30 } } } } });
  assert.match(entry.error.message, /missing required field: url/);
  assert.match(entry.error.stack, /source.ts:1:2/);
  await log.flush();
});

test("error normalization handles cycles, bounded text, leaked credentials and embedded request bodies", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.doesNotThrow(() => errorInfo(cycle));
  const error = new Error("schema error: missing field url; apiKey=sk-live-private-secret");
  error.stack = `${error.message}\nRequest body: {\"messages\":[{\"content\":\"secret conversation\"}]}\n    at adapter (/tmp/provider.ts:12:3)`;
  const safe = errorInfo(error);
  assert.ok(safe.message.includes(REDACTED));
  assert.ok(!safe.stack?.includes("secret conversation"));
  assert.match(safe.stack!, /at adapter/);
  assert.ok(errorInfo(new Error("x".repeat(100_000))).message.length < 8_100);
  assert.match(errorInfo(new Error("wrapper", { cause: new Error("missing tool field: name") })).stack!, /missing tool field: name/);
});

test("fatal process exit waits for pending gzip and retains the final error", async (t) => {
  const root = directory(t);
  const module = new URL("../src/log-file.ts", import.meta.url).href;
  const handlers = new URL("../src/install.ts", import.meta.url).href;
  const source = `import { DiagnosticLog } from ${JSON.stringify(module)};
    import { installProcessErrorHandlers } from ${JSON.stringify(handlers)};
    const log = new DiagnosticLog({ directory: process.argv[1], process: 'runtime', maxBytes: 500 });
    installProcessErrorHandlers(log, { exitOnUncaught: true });
    for (let i = 0; i < 20; i++) log.info('fatal', 'before_' + i);
    queueMicrotask(() => { throw new Error('fatal evidence'); });`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, root], { cwd: process.cwd() }),
    (error: unknown) => (error as { code?: number }).code === 1);
  const files = listDiagnosticLogFiles(root);
  assert.ok(files.some((file) => file.compressed));
  assert.ok(readdirSync(root).every((name) => !name.endsWith(".tmp")));
  const errors = files.filter((file) => file.errors).flatMap((file) => entries(file.path));
  assert.ok(errors.some((entry) => entry.event === "uncaught_exception" && entry.error.message === "fatal evidence"));
});

test("maintenance preserves active streams even when they temporarily exceed the archive budget", async (t) => {
  const root = directory(t);
  const log = new DiagnosticLog({ directory: root, process: "runtime" });
  log.error("active", "must_remain", new Error("active error"));
  await log.flush();
  await maintainDiagnosticArchives(root, { ...policy, maxTotalBytes: 1 });
  assert.equal(entries(log.filePath)[0].event, "must_remain");
  assert.equal(entries(log.errorsFilePath)[0].event, "must_remain");
});

test("tail merges interleaved writers and source timestamps instead of stopping at the first full file", async (t) => {
  const root = directory(t);
  const a = new DiagnosticLog({ directory: root, process: "runtime" });
  const b = new DiagnosticLog({ directory: root, process: "runtime", maxBytes: 400 });
  const row = (event: string, ts: number) => ({ event, ts, level: "info" as const, process: "runtime" as const, scope: "tail" });
  a.writeEntries(Array.from({ length: 10 }, (_, index) => row(`old${index}`, 100 + index)));
  b.writeEntries(Array.from({ length: 5 }, (_, index) => row(`recent${index}`, 200 + index)));
  a.writeEntries([row("newest", 300)]);
  await b.flush();
  assert.deepEqual(a.tail(5).map((entry) => entry.event), ["recent1", "recent2", "recent3", "recent4", "newest"]);
  // Clock-skewed remote entries may precede lower timestamps in the same file.
  a.writeEntries([row("remote-clock", 1000)]);
  a.writeEntries(Array.from({ length: 5 }, (_, index) => row(`later-write${index}`, 400 + index)));
  assert.deepEqual(a.tail(2).map((entry) => entry.event), ["later-write4", "remote-clock"]);
  b.writeEntries([row("archived-clock", 2000)]);
  for (let i = 0; i < 10; i++) b.writeEntries([row(`archive-filler${i}`, 500 + i)]);
  await b.close();
  assert.equal(a.tail(1)[0]?.event, "archived-clock", "mtime cannot exclude a source timestamp in an older archive");
});

test("tail limits archive work even when very old source timestamps are ahead of the host clock", (t) => {
  const root = directory(t);
  const log = new DiagnosticLog({ directory: root, process: "runtime" });
  log.info("tail", "live");
  for (let index = 0; index < 70; index++) {
    const name = join(root, `runtime-9999999-1234-aabb.archive-${1234 + index}-abcd.jsonl.gz`);
    writeFileSync(name, gzipSync(JSON.stringify({ ts: index === 0 ? Date.now() + 1_000_000 : index, event: `archived${index}` }) + "\n"));
    const time = new Date(Date.now() - (100 - index) * 1000);
    utimesSync(name, time, time);
  }
  assert.equal(log.tail(1)[0]?.event, "live", "archive0 is outside the explicit 64-file search window");
});

test("simultaneous stale-lock recovery has one owner, and an old release cannot delete its successor", async (t) => {
  const root = directory(t);
  const lock = join(root, ".archive-maintenance.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner-1.json"), JSON.stringify({ pid: 9999999, token: "dead" }));
  const contenders = await Promise.all([acquireMaintenanceLock(root), acquireMaintenanceLock(root)]);
  const winners = contenders.filter((release) => release !== undefined);
  assert.equal(winners.length, 1);
  const release = winners[0]!;
  await release();
  const successor = await acquireMaintenanceLock(root);
  assert.ok(successor);
  await release();
  assert.equal(await acquireMaintenanceLock(root), undefined, "the successor still owns maintenance");
  await successor();
  for (let index = 0; index < 8; index++) {
    const next = await acquireMaintenanceLock(root);
    assert.ok(next);
    await next();
  }
  assert.ok(readdirSync(lock).length <= 4, "only the current and previous generations remain");
});

test("incomplete owner initialization is protected until stale, then a new generation can recover", async (t) => {
  const root = directory(t);
  const lock = join(root, ".archive-maintenance.lock");
  mkdirSync(lock);
  const owner = join(lock, "owner-1.json");
  writeFileSync(owner, "");
  assert.equal(await acquireMaintenanceLock(root), undefined);
  const stale = new Date(Date.now() - 61_000);
  utimesSync(owner, stale, stale);
  const release = await acquireMaintenanceLock(root);
  assert.ok(release);
  await release();
});
