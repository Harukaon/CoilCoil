import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PROJECT_MEMORY_MAX_CHARS,
  PROJECT_MEMORY_STATUS_EVENT,
  buildMemoryCountCommand,
  buildMemoryWorkerLaunch,
  buildMemoryWorkerPrompt,
  buildProjectMemoryPrompt,
  countCharacters,
  enforceProjectMemoryLimit,
  ensureProjectMemory,
  isInsidePiDirectory,
  resolveProjectMemoryPaths,
  resolveProjectMemoryStorageRoot,
  resolveProjectRoot,
  resolvePiWorkerInvocation,
  type MemoryWorkerChild,
  type MemoryWorkerLaunch,
} from "../extensions/project-memory.ts";
import projectMemoryExtension from "../extensions/project-memory.ts";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hao-pi-memory-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

class FakeWorker extends EventEmitter implements MemoryWorkerChild {
  pid = 99_999;
  unrefCalled = false;
  killedWith: NodeJS.Signals[] = [];

  unref(): void {
    this.unrefCalled = true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith.push(signal);
    return true;
  }
}

function createHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const emittedEvents: Array<{ channel: string; value: unknown }> = [];
  let registeredTools = 0;
  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerTool() {
      registeredTools++;
    },
    events: {
      on(channel: string, listener: (value: unknown) => void) {
        const listeners = eventHandlers.get(channel) ?? new Set();
        listeners.add(listener);
        eventHandlers.set(channel, listeners);
        return () => listeners.delete(listener);
      },
      emit(channel: string, value: unknown) {
        emittedEvents.push({ channel, value });
        for (const listener of eventHandlers.get(channel) ?? []) listener(value);
      },
    },
  };
  return { pi, handlers, commands, emittedEvents, registeredTools: () => registeredTools };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function pathMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function contextFor(
  cwd: string,
  sessionFile: string,
  notices: string[] = [],
) {
  return {
    cwd,
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    model: { provider: "pierce", id: "gpt-5.6-sol" },
    sessionManager: { getSessionFile: () => sessionFile },
  };
}

test("project scope uses the nearest git root and otherwise keeps the cwd", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = join(root, "A");
  const nested = join(repository, "src", "feature");
  const plain = join(root, "plain", "nested");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(plain, { recursive: true });

  assert.equal(await resolveProjectRoot(nested), await realpath(repository));
  assert.equal(await resolveProjectRoot(plain), await realpath(plain));
});

test("global storage root is Pi agent memory without an extra project layer", () => {
  assert.equal(
    resolveProjectMemoryStorageRoot({ PI_CODING_AGENT_DIR: "/global/.pi/agent" }),
    "/global/.pi/agent/memory",
  );
  assert.equal(
    resolveProjectMemoryStorageRoot({ PI_PROJECT_MEMORY_DIR: "/custom/memory" }),
    "/custom/memory",
  );
});

test("project folder names map directly to sibling folders under global memory", async (t) => {
  const root = await temporaryDirectory(t);
  const projectA = join(root, "A");
  const projectB = join(root, "B");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  const pathsA = await resolveProjectMemoryPaths(projectA, memoryRoot);
  const pathsB = await resolveProjectMemoryPaths(projectB, memoryRoot);
  assert.equal(pathsA.projectMemoryDir, join(memoryRoot, "A"));
  assert.equal(pathsB.projectMemoryDir, join(memoryRoot, "B"));
  assert.equal(pathsA.memoryFile, join(memoryRoot, "A", "MEMORY.md"));
  assert.equal(pathsB.memoryFile, join(memoryRoot, "B", "MEMORY.md"));

  await ensureProjectMemory(pathsA);
  await ensureProjectMemory(pathsB);
  assert.equal(await readFile(pathsA.memoryFile, "utf8"), "");
  assert.equal(await readFile(pathsB.memoryFile, "utf8"), "");
  assert.equal(await pathMissing(join(memoryRoot, "INDEX.md")), true);
  assert.equal(await pathMissing(join(projectA, ".pi")), true);
  assert.equal(await pathMissing(join(projectB, ".pi")), true);
});

test("legacy project-local memory migrates into its global project folder", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "Project");
  const legacyMemoryDir = join(project, ".pi", "memory");
  const memoryRoot = join(root, "global-memory");
  await mkdir(legacyMemoryDir, { recursive: true });
  await writeFile(
    join(project, ".pi", "MEMORY.md"),
    "索引：.pi/memory/server.md\n生产服务使用 server-a",
    "utf8",
  );
  await writeFile(join(legacyMemoryDir, "server.md"), "端口 8443", "utf8");

  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await ensureProjectMemory(paths);

  assert.equal(paths.projectMemoryDir, join(memoryRoot, "Project"));
  assert.match(await readFile(paths.memoryFile, "utf8"), /^索引：server\.md/);
  assert.equal(await readFile(join(paths.projectMemoryDir, "server.md"), "utf8"), "端口 8443");
  assert.equal(await pathMissing(join(project, ".pi", "MEMORY.md")), true);
  assert.equal(await pathMissing(join(legacyMemoryDir, "server.md")), true);
});

test("memory length is a soft constraint and oversized content is not rewritten", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "Project");
  const memoryRoot = join(root, "global-memory");
  await mkdir(project, { recursive: true });
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await ensureProjectMemory(paths);
  const original = `索引：（同目录）\n${"重要配置。".repeat(240)}`;
  await writeFile(paths.memoryFile, original, "utf8");

  const result = await enforceProjectMemoryLimit(paths);
  assert.equal(result.content, original);
  assert.equal(await readFile(paths.memoryFile, "utf8"), original);
  assert.deepEqual(
    (await readdir(paths.projectMemoryDir)).filter((name) => name.endsWith(".md")),
    ["MEMORY.md"],
  );
});

test("system prompt injects current project memory and soft limit guidance", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  await mkdir(project, { recursive: true });
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  const memory = "服".repeat(PROJECT_MEMORY_MAX_CHARS + 80);
  const prompt = buildProjectMemoryPrompt(paths, memory);
  const injected = prompt.match(/<project_memory_data>\n([\s\S]*?)\n<\/project_memory_data>/)?.[1];

  assert.equal(countCharacters(injected ?? ""), PROJECT_MEMORY_MAX_CHARS);
  assert.match(prompt, /可以使用 read、write、edit/);
  assert.match(prompt, /并不要求是索引/);
  assert.match(prompt, /采用软约束/);
  assert.match(prompt, /wc -m/);
  assert.match(prompt, new RegExp(buildMemoryCountCommand(paths.memoryFile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(prompt, /强制只读|硬上限/);
  assert.match(prompt, new RegExp(paths.projectMemoryDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(prompt, /不存在全局记忆索引|不要跨项目搜索记忆/);
  assert.doesNotMatch(prompt, /不得在回答中复述记忆里的凭证/);
  assert.doesNotMatch(prompt, /INDEX\.md/);
});

test("worker prompt contains paths and policy but never embeds session contents", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const sessionFile = join(root, "session.jsonl");
  const sentinel = "SESSION_BODY_MUST_NOT_BE_EMBEDDED";
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, sentinel, "utf8");
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  const prompt = buildMemoryWorkerPrompt(paths, sessionFile);

  assert.match(prompt, new RegExp(sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(prompt, new RegExp(sentinel));
  assert.ok(prompt.indexOf("先读取现有 MEMORY.md") < prompt.indexOf("再读取指定的 session JSONL"));
  assert.match(prompt, /不会有用户|不要向用户提问|无人值守/);
  assert.match(prompt, /严禁读取或修改任何其他文件或目录/);
  assert.match(prompt, /普通记忆正文，也可能是索引/);
  assert.match(prompt, /采用软约束/);
  assert.match(prompt, /wc -m/);
  assert.doesNotMatch(prompt, /第一行以“索引：”开头|最多 4 个/);
});

test("worker launch runs inside the global project memory folder with isolated resources", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const sessionFile = join(root, "session.jsonl");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, "private session body", "utf8");
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await ensureProjectMemory(paths);
  const launch = buildMemoryWorkerLaunch({
    paths,
    sessionFile,
    provider: "pierce",
    model: "gpt-5.6-sol",
  }, {
    env: { PI_MEMORY_WORKER_BIN: "/fake/pi", OPENAI_API_KEY: "not-in-argv" },
    argv: ["node", "test"],
    workerGuardPath: "/guard.ts",
  });
  const joined = launch.args.join(" ");

  assert.equal(launch.command, "/fake/pi");
  assert.equal(launch.cwd, paths.projectMemoryDir);
  assert.match(joined, /--provider pierce/);
  assert.match(joined, /--model gpt-5\.6-sol/);
  assert.match(joined, /--thinking low/);
  assert.ok(launch.args.includes(paths.workerSessionsDir));
  assert.match(joined, /--no-extensions --extension \/guard\.ts/);
  assert.match(joined, /--no-context-files --no-skills --no-prompt-templates/);
  assert.match(joined, /--tools read,write,edit,grep,bash/);
  assert.doesNotMatch(joined, /not-in-argv/);
  assert.equal(launch.env.PI_MEMORY_WORKER, "1");
  assert.equal(launch.env.PI_MEMORY_WORKER_LOCK_FILE, paths.workerLockFile);
});

test("bundled memory workers use the host runtime and internal Pi CLI entry", () => {
  assert.deepEqual(
    resolvePiWorkerInvocation(
      { PI_MEMORY_WORKER_ENTRY: "/Applications/SuoCode.app/Contents/Resources/app.asar/node_modules/pi/dist/cli.js" },
      ["SuoCode", "runtime.js"],
    ),
    {
      command: process.execPath,
      prefixArgs: ["/Applications/SuoCode.app/Contents/Resources/app.asar/node_modules/pi/dist/cli.js"],
    },
  );
});

test("extension injects global project-scoped memory without creating project .pi", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  await mkdir(project, { recursive: true });
  const harness = createHarness();

  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot },
  });
  const context = { cwd: project, hasUI: false, ui: {} };
  await harness.handlers.get("session_start")?.[0]({}, context);
  const result = await harness.handlers.get("before_agent_start")?.[0](
    { systemPrompt: "base" },
    context,
  );

  assert.equal(harness.registeredTools(), 0);
  assert.deepEqual([...harness.commands.keys()], ["memory"]);
  assert.equal(harness.handlers.has("agent_end"), false);
  assert.equal(harness.handlers.has("agent_settled"), true);
  assert.equal(harness.handlers.has("tool_call"), false);
  assert.match(result.systemPrompt, /<project_folder_memory>/);
  assert.equal(await readFile(join(memoryRoot, "A", "MEMORY.md"), "utf8"), "");
  assert.equal(await pathMissing(join(project, ".pi")), true);
});

test("settled sessions are summarized in the background and injected into later prompts", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const sessionFile = join(root, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, '{"type":"message","message":{"role":"user","content":"部署端口是 8443"}}\n', "utf8");
  const launches: MemoryWorkerLaunch[] = [];
  const children: FakeWorker[] = [];
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi" },
    spawnWorker: (launch) => {
      launches.push(launch);
      const child = new FakeWorker();
      children.push(child);
      return child;
    },
  });
  const context = contextFor(project, sessionFile);

  await harness.handlers.get("agent_settled")?.[0]({}, context);
  assert.equal(launches.length, 1);
  assert.match(launches[0].args.join("\n"), new RegExp((await realpath(sessionFile)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await writeFile(paths.memoryFile, "稳定部署端口：8443", "utf8");
  children[0].emit("exit", 0, null);
  await waitFor(() => pathMissing(paths.workerLockFile));

  const injected = await harness.handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, context);
  assert.match(injected.systemPrompt, /稳定部署端口：8443/);
});

test("memory command publishes immediate, completed, and injected runtime status", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const sessionFile = join(root, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, "session", "utf8");
  const child = new FakeWorker();
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi" },
    spawnWorker: () => child,
  });
  const context = contextFor(project, sessionFile);

  await harness.handlers.get("session_start")?.[0]({}, context);
  await harness.commands.get("memory")?.handler("", context);
  const states = () => harness.emittedEvents
    .filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT)
    .map((event) => (event.value as { state: string }).state);
  assert.deepEqual(states().slice(-2), ["idle", "running"]);

  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await writeFile(paths.memoryFile, "可复用的项目记忆", "utf8");
  child.emit("exit", 0, null);
  await waitFor(async () => states().includes("succeeded") && await pathMissing(paths.workerLockFile));
  const completed = harness.emittedEvents
    .filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT)
    .at(-1)?.value as { state: string; contentChars: number; processedSessions: string[] };
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.contentChars, 8);
  assert.deepEqual(completed.processedSessions, [await realpath(sessionFile)]);

  await harness.handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, context);
  const injected = harness.emittedEvents.at(-1)?.value as { injected: boolean; source: string };
  assert.equal(injected.injected, true);
  assert.equal(injected.source, "prompt");
});

test("Pi started inside global .pi memory cannot recursively trigger /memory", async (t) => {
  const root = await temporaryDirectory(t);
  const internal = join(root, ".pi", "agent", "memory", "A");
  await mkdir(internal, { recursive: true });
  const launches: MemoryWorkerLaunch[] = [];
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: join(root, ".pi", "agent", "memory") },
    spawnWorker: (launch) => {
      launches.push(launch);
      return new FakeWorker();
    },
  });
  const notices: string[] = [];
  const context = contextFor(internal, join(root, "session.jsonl"), notices);

  await harness.handlers.get("session_start")?.[0]({}, context);
  const result = await harness.handlers.get("before_agent_start")?.[0](
    { systemPrompt: "base" },
    context,
  );
  await harness.commands.get("memory")?.handler("", context);

  assert.equal(result, undefined);
  assert.equal(launches.length, 0);
  assert.match(notices.join("\n"), /防递归/);
});

test("same project allows only one memory worker at a time", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const sessionFile = join(root, "a-session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, "CURRENT_SESSION_PRIVATE_BODY", "utf8");
  const launches: MemoryWorkerLaunch[] = [];
  const children: FakeWorker[] = [];
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: {
      PI_PROJECT_MEMORY_DIR: memoryRoot,
      PI_MEMORY_WORKER_BIN: "/fake/pi",
    },
    argv: ["node", "test"],
    workerGuardPath: "/guard.ts",
    spawnWorker: (launch) => {
      launches.push(launch);
      const child = new FakeWorker();
      children.push(child);
      return child;
    },
  });
  const notices: string[] = [];
  const context = contextFor(project, sessionFile, notices);

  await harness.commands.get("memory")?.handler("", context);
  await harness.commands.get("memory")?.handler("", context);

  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  assert.equal(launches.length, 1);
  assert.equal(children[0].unrefCalled, true);
  assert.match(notices.join("\n"), /已有记忆整理正在运行/);
  await stat(paths.workerLockFile);

  children[0].emit("exit", 0, null);
  await waitFor(() => pathMissing(paths.workerLockFile));

  await harness.commands.get("memory")?.handler("", context);
  assert.equal(launches.length, 2);
  children[1].emit("exit", 0, null);
  await waitFor(() => pathMissing(paths.workerLockFile));
});

test("different project folders can run memory workers concurrently", async (t) => {
  const root = await temporaryDirectory(t);
  const projectA = join(root, "A");
  const projectB = join(root, "B");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const sessionA = join(root, "a.jsonl");
  const sessionB = join(root, "b.jsonl");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  await writeFile(sessionA, "a", "utf8");
  await writeFile(sessionB, "b", "utf8");
  const launches: MemoryWorkerLaunch[] = [];
  const children: FakeWorker[] = [];
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi" },
    spawnWorker: (launch) => {
      launches.push(launch);
      const child = new FakeWorker();
      children.push(child);
      return child;
    },
  });

  await harness.commands.get("memory")?.handler("", contextFor(projectA, sessionA));
  await harness.commands.get("memory")?.handler("", contextFor(projectB, sessionB));

  assert.equal(launches.length, 2);
  assert.deepEqual(
    new Set(launches.map((launch) => launch.cwd)),
    new Set([join(memoryRoot, "A"), join(memoryRoot, "B")]),
  );
  const pathsA = await resolveProjectMemoryPaths(projectA, memoryRoot);
  const pathsB = await resolveProjectMemoryPaths(projectB, memoryRoot);
  await stat(pathsA.workerLockFile);
  await stat(pathsB.workerLockFile);

  children[0].emit("exit", 0, null);
  children[1].emit("exit", 0, null);
  await waitFor(async () =>
    await pathMissing(pathsA.workerLockFile) && await pathMissing(pathsB.workerLockFile)
  );
});

test("worker completion does not hard-reject or roll back MEMORY.md", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const sessionFile = join(root, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, "session", "utf8");
  const children: FakeWorker[] = [];
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi" },
    spawnWorker: () => {
      const child = new FakeWorker();
      children.push(child);
      return child;
    },
  });
  const notices: string[] = [];
  const context = contextFor(project, sessionFile, notices);

  await harness.commands.get("memory")?.handler("", context);
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  const workerResult = `普通正文 ${"长".repeat(1_200)}`;
  await writeFile(
    paths.memoryFile,
    workerResult,
    "utf8",
  );
  children[0].emit("exit", 0, null);
  await waitFor(() => pathMissing(paths.workerLockFile));

  const memory = await readFile(paths.memoryFile, "utf8");
  assert.equal(memory, workerResult);
  assert.equal(notices.some((notice) => notice.includes("拒绝保存")), false);
});
