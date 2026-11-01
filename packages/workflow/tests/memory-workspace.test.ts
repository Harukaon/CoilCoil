import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveProjectMemoryPaths } from "../extensions/memory-storage.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "coil-memory-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, "a", "project"), b = join(root, "b", "project"), memory = join(root, "memory");
  await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true }); await mkdir(memory);
  return { root, a, b, memory };
}

test("same-named workspaces have distinct memory and worker lock paths; symlinks share the canonical identity", async (t) => {
  const { root, a, b, memory } = await fixture(t);
  const pa = await resolveProjectMemoryPaths(a, memory), pb = await resolveProjectMemoryPaths(b, memory);
  assert.notEqual(pa.projectMemoryDir, pb.projectMemoryDir);
  assert.notEqual(pa.workerLockFile, pb.workerLockFile);
  assert.notEqual(pa.notesDir, pb.notesDir);
  const link = join(root, "alias"); await symlink(a, link);
  assert.equal((await resolveProjectMemoryPaths(link, memory)).projectMemoryDir, pa.projectMemoryDir);
  assert.equal((await resolveProjectMemoryPaths(a, memory)).projectMemoryDir, pa.projectMemoryDir);
});

test("legacy memory stays in place and belongs only to the workspace identified by every recorded session header", async (t) => {
  const { root, a, b, memory } = await fixture(t);
  const legacy = join(memory, "project"); await mkdir(legacy);
  const session = join(root, "old.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", cwd: a })}\n`);
  await writeFile(join(legacy, ".coilcoil-memory-state.json"), JSON.stringify({ version: 1, processedSessions: [session] }));
  await writeFile(join(legacy, "MEMORY.md"), "keep this memory exactly");
  await writeFile(join(legacy, ".worker.lock"), "active-worker-owner");
  const wrong = await resolveProjectMemoryPaths(b, memory);
  assert.equal(wrong.migrationNotice, undefined);
  assert.equal(await readFile(join(legacy, "MEMORY.md"), "utf8"), "keep this memory exactly");
  const [first, second] = await Promise.all([resolveProjectMemoryPaths(a, memory), resolveProjectMemoryPaths(a, memory)]);
  assert.equal(first.projectMemoryDir, second.projectMemoryDir);
  assert.equal(first.projectMemoryDir, legacy, "saved prompts and workers retain their original paths");
  assert.equal(await readFile(first.workerLockFile, "utf8"), "active-worker-owner");
  assert.equal(await readFile(first.memoryFile, "utf8"), "keep this memory exactly");
  assert.equal(first.migrationNotice, undefined);
  assert.equal(JSON.parse(await readFile(join(first.projectMemoryDir, ".coilcoil-workspace.json"), "utf8")).projectRoot, await realpath(a));
  assert.ok((await stat(legacy)).isDirectory());
});

test("ambiguous or missing legacy ownership stays untouched and produces a visible migration notice", async (t) => {
  const { root, a, b, memory } = await fixture(t);
  const legacy = join(memory, "project"); await mkdir(legacy);
  await writeFile(join(legacy, "MEMORY.md"), "unassigned memory");
  const unknown = await resolveProjectMemoryPaths(a, memory);
  assert.equal(unknown.legacyMemoryDir, legacy);
  assert.match(unknown.migrationNotice!, /不会自动注入/);
  const sessions = [join(root, "a.jsonl"), join(root, "b.jsonl")];
  await writeFile(sessions[0], `${JSON.stringify({ type: "session", cwd: a })}\n`);
  await writeFile(sessions[1], `${JSON.stringify({ type: "session", cwd: b })}\n`);
  await writeFile(join(legacy, ".coilcoil-memory-state.json"), JSON.stringify({ processedSessions: sessions }));
  assert.equal((await resolveProjectMemoryPaths(a, memory)).legacyMemoryDir, legacy);
  assert.equal((await resolveProjectMemoryPaths(b, memory)).legacyMemoryDir, legacy);
  assert.equal(await readFile(join(legacy, "MEMORY.md"), "utf8"), "unassigned memory");
});

test("explicit legacy ownership works without session logs, while conflicting current content is never overwritten", async (t) => {
  const { a, memory } = await fixture(t);
  const paths = await resolveProjectMemoryPaths(a, memory);
  await mkdir(paths.projectMemoryDir);
  await writeFile(paths.memoryFile, "new memory");
  const legacy = join(memory, "project"); await mkdir(legacy);
  await writeFile(join(legacy, "MEMORY.md"), "legacy memory");
  await writeFile(join(legacy, ".coilcoil-workspace.json"), JSON.stringify({ version: 1, projectRoot: a, projectName: "project" }));
  const conflict = await resolveProjectMemoryPaths(a, memory);
  assert.match(conflict.migrationNotice!, /同时存在/);
  assert.equal(await readFile(paths.memoryFile, "utf8"), "new memory");
  assert.equal(await readFile(join(legacy, "MEMORY.md"), "utf8"), "legacy memory");
  await rm(paths.projectMemoryDir, { recursive: true });
  const migrated = await resolveProjectMemoryPaths(a, memory);
  assert.equal(migrated.projectMemoryDir, legacy);
  assert.equal(await readFile(migrated.memoryFile, "utf8"), "legacy memory");
  assert.equal(migrated.migrationNotice, undefined);
});
