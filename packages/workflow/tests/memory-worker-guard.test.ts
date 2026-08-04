import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import memoryWorkerGuard from "../extensions/memory-worker-guard.ts";
import { buildMemoryCountCommand } from "../extensions/project-memory.ts";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hao-pi-memory-guard-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createGuardHarness(t: test.TestContext) {
  const root = await temporaryDirectory(t);
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const detailsDir = join(memoryRoot, "A");
  const memoryFile = join(detailsDir, "MEMORY.md");
  const sessionFile = join(root, "main-session.jsonl");
  const detailFile = join(detailsDir, "server.md");
  const lockFile = join(detailsDir, ".worker.lock");
  await mkdir(detailsDir, { recursive: true });
  await writeFile(memoryFile, "索引：server.md\n服务端口 8443", "utf8");
  await writeFile(detailFile, "部署详情", "utf8");
  await writeFile(sessionFile, "session", "utf8");

  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
  };
  memoryWorkerGuard(pi as any, {
    env: {
      PI_MEMORY_WORKER_SESSION_FILE: sessionFile,
      PI_MEMORY_WORKER_MAIN_FILE: memoryFile,
      PI_MEMORY_WORKER_DETAILS_DIR: detailsDir,
      PI_MEMORY_WORKER_LOCK_FILE: lockFile,
    },
  });
  const call = handlers.get("tool_call")![0];
  const context = { cwd: detailsDir };
  return {
    root,
    memoryRoot,
    detailsDir,
    memoryFile,
    sessionFile,
    detailFile,
    lockFile,
    handlers,
    call,
    context,
  };
}

async function pathMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function event(
  toolName: string,
  input: Record<string, unknown>,
  id = "call-1",
) {
  return { type: "tool_call", toolName, toolCallId: id, input };
}

test("guard permits the named session, project Markdown tree, and memory count command", async (t) => {
  const harness = await createGuardHarness(t);
  const outside = join(harness.root, "project", "src", "secret.ts");
  const nestedDetail = join(harness.detailsDir, "ops", "deploy.md");
  await mkdir(join(harness.root, "project", "src"), { recursive: true });
  await mkdir(join(harness.detailsDir, "ops"), { recursive: true });
  await writeFile(outside, "outside", "utf8");
  await writeFile(nestedDetail, "nested", "utf8");

  assert.equal(
    await harness.call(event("read", { path: harness.sessionFile }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("read", { path: harness.memoryFile }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("read", { path: harness.detailFile }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("grep", { path: harness.detailsDir, pattern: "部署" }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("read", { path: nestedDetail }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("grep", { path: join(harness.detailsDir, "ops"), pattern: "nested" }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("bash", {
      command: buildMemoryCountCommand(harness.memoryFile),
    }), harness.context),
    undefined,
  );

  assert.equal(
    (await harness.call(event("read", { path: outside }), harness.context)).block,
    true,
  );
  assert.equal(
    (await harness.call(event("grep", { pattern: "anything" }), harness.context)).block,
    true,
  );
  assert.equal(
    (await harness.call(event("bash", { command: "pwd" }), harness.context)).block,
    true,
  );
});

test("guard applies only the project-folder boundary and Markdown file type", async (t) => {
  const harness = await createGuardHarness(t);

  assert.equal(
    await harness.call(event("write", {
      path: harness.memoryFile,
      content: "普通记忆正文，不要求索引首行",
    }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("write", {
      path: harness.memoryFile,
      content: "长".repeat(1_100),
    }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("write", {
      path: harness.memoryFile,
      content: "api_key=sk-example123456789012345",
    }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("write", {
      path: join(harness.detailsDir, "nested", "server.md"),
      content: "nested",
    }), harness.context),
    undefined,
  );
  assert.equal(
    (await harness.call(event("write", {
      path: join(harness.detailsDir, "server.txt"),
      content: "text",
    }), harness.context)).block,
    true,
  );
  assert.equal(
    await harness.call(event("write", {
      path: join(harness.detailsDir, "deploy.md"),
      content: "部署详情",
    }), harness.context),
    undefined,
  );
  assert.equal(
    (await harness.call(event("write", {
      path: join(harness.detailsDir, "..", "B", "outside.md"),
      content: "outside",
    }), harness.context)).block,
    true,
  );
});

test("guard leaves edit content and exact-match validation to the existing edit tool", async (t) => {
  const harness = await createGuardHarness(t);

  assert.equal(
    await harness.call(event("edit", {
      path: harness.memoryFile,
      edits: [{ oldText: "服务端口 8443", newText: "服务端口 9443" }],
    }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("edit", {
      path: harness.memoryFile,
      edits: [{
        oldText: "服务端口 8443",
        newText: "api_key=sk-example123456789012345",
      }],
    }), harness.context),
    undefined,
  );
  assert.equal(
    await harness.call(event("edit", {
      path: harness.memoryFile,
      edits: [{ oldText: "服务端口 8443", newText: "长".repeat(1_100) }],
    }), harness.context),
    undefined,
  );

  await writeFile(harness.detailFile, "重复 重复", "utf8");
  assert.equal(
    await harness.call(event("edit", {
      path: harness.detailFile,
      edits: [{ oldText: "重复", newText: "一次" }],
    }), harness.context),
    undefined,
  );
});

test("guard with missing configuration blocks every tool instead of failing open", async () => {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const pi = {
    on(eventName: string, handler: (...args: any[]) => any) {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
    },
  };
  memoryWorkerGuard(pi as any, { env: {} });
  const result = await handlers.get("tool_call")![0](
    event("read", { path: "/tmp/file" }),
    { cwd: "/tmp" },
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /缺少环境变量/);
});

test("guard removes only its current project worker lock on shutdown", async (t) => {
  const harness = await createGuardHarness(t);
  const otherProjectLock = join(harness.memoryRoot, "B", ".worker.lock");
  await mkdir(join(harness.memoryRoot, "B"), { recursive: true });
  await writeFile(harness.lockFile, "A", "utf8");
  await writeFile(otherProjectLock, "B", "utf8");

  await harness.handlers.get("session_shutdown")![0]();

  assert.equal(await pathMissing(harness.lockFile), true);
  assert.equal(await pathMissing(otherProjectLock), false);
});
