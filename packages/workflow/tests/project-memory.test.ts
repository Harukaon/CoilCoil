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
  DEFAULT_MEMORY_SUMMARIZE_EVERY_TURNS,
  MEMORY_ENTRIES_DIRNAME,
  MEMORY_FACTS_MAX,
  MEMORY_INDEX_MARKER,
  PROJECT_MEMORY_MAX_CHARS,
  PROJECT_MEMORY_STATUS_EVENT,
  buildMemoryWorkerLaunch,
  buildMemoryWorkerPrompt,
  buildProjectMemoryPrompt,
  countCharacters,
  enforceProjectMemoryLimit,
  ensureProjectMemory,
  isInsidePiDirectory,
  listMemoryEntryFiles,
  parseMemoryFacts,
  parseMemoryIndex,
  readPersistedMemoryState,
  renderMemoryIndex,
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

/** 写一份记忆设置，避免测试读到开发机上真实的 ~/.pi/agent/memory-settings.json。 */
async function writeMemorySettings(
  agentDir: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "memory-settings.json"), JSON.stringify(settings), "utf8");
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
  const index = await readFile(paths.memoryFile, "utf8");
  assert.match(index, new RegExp(MEMORY_INDEX_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const entries = parseMemoryIndex(index);
  assert.deepEqual(entries.map((entry) => entry.file).sort(), [`${MEMORY_ENTRIES_DIRNAME}/既有记忆.md`, "server.md"]);
  const body = await readFile(join(paths.projectMemoryDir, `${MEMORY_ENTRIES_DIRNAME}/既有记忆.md`), "utf8");
  assert.match(body, /生产服务使用 server-a/);
  assert.equal(await readFile(join(paths.projectMemoryDir, "server.md"), "utf8"), "端口 8443");
  assert.equal(await pathMissing(join(project, ".pi", "MEMORY.md")), true);
  assert.equal(await pathMissing(join(legacyMemoryDir, "server.md")), true);
});

test("oversized memory is moved into a body file instead of being truncated", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "Project");
  const memoryRoot = join(root, "global-memory");
  await mkdir(project, { recursive: true });
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await ensureProjectMemory(paths);
  const original = `索引：（同目录）\n${"重要配置。".repeat(240)}`;
  await writeFile(paths.memoryFile, original, "utf8");

  const result = await enforceProjectMemoryLimit(paths);
  const entries = parseMemoryIndex(result.content);
  assert.equal(entries.length, 1);
  assert.ok(countCharacters(result.content) < countCharacters(original));
  assert.equal(
    (await readFile(join(paths.projectMemoryDir, entries[0].file), "utf8")).trim(),
    original.trim(),
  );
  assert.deepEqual(
    (await readdir(paths.projectMemoryDir)).filter((name) => name.endsWith(".md")),
    ["MEMORY.md"],
  );
  assert.deepEqual(await listMemoryEntryFiles(paths), ["既有记忆.md"]);
});

test("system prompt injects current project memory and soft limit guidance", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  await mkdir(project, { recursive: true });
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  const memory = "服".repeat(PROJECT_MEMORY_MAX_CHARS + 80);
  const prompt = buildProjectMemoryPrompt(paths, memory);
  const injected = prompt.match(/<project_memory_index>\n([\s\S]*?)\n<\/project_memory_index>/)?.[1];

  assert.equal(countCharacters(injected ?? ""), PROJECT_MEMORY_MAX_CHARS);
  assert.match(prompt, /可以使用 read、write、edit/);
  assert.match(prompt, /常驻在你上下文里的只有索引这一层/);
  assert.match(prompt, new RegExp(`${MEMORY_ENTRIES_DIRNAME}/`));
  assert.match(prompt, /是软约束/);
  assert.match(prompt, /\[记忆字数\]/);
  assert.doesNotMatch(prompt, /wc -m/);
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
  assert.ok(prompt.indexOf("先读 MEMORY.md") < prompt.indexOf("再读指定的 session JSONL"));
  assert.match(prompt, /不会有用户|不要向用户提问|无人值守/);
  assert.match(prompt, /严禁读取或修改任何其他文件或目录/);
  assert.match(prompt, /索引\*\*：MEMORY\.md，只有两样东西/);
  assert.match(prompt, /正文一律不要写进 MEMORY\.md/);
  assert.match(prompt, /是软约束/);
  assert.match(prompt, /\[记忆字数\]/);
  assert.doesNotMatch(prompt, /wc -m/);
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
  assert.match(joined, /--tools read,write,edit,grep(?!,)/);
  assert.doesNotMatch(joined, /not-in-argv/);
  assert.equal(launch.env.PI_MEMORY_WORKER, "1");
  assert.equal(launch.env.PI_MEMORY_WORKER_LOCK_FILE, paths.workerLockFile);
});

test("bundled memory workers use the host runtime and internal Pi CLI entry", () => {
  assert.deepEqual(
    resolvePiWorkerInvocation(
      { PI_MEMORY_WORKER_ENTRY: "/Applications/CoilCoil.app/Contents/Resources/app.asar/node_modules/pi/dist/cli.js" },
      ["CoilCoil", "runtime.js"],
    ),
    {
      command: process.execPath,
      prefixArgs: ["/Applications/CoilCoil.app/Contents/Resources/app.asar/node_modules/pi/dist/cli.js"],
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
  const agentDir = join(root, "agent");
  await writeMemorySettings(agentDir, { version: 1, summarizeEveryTurns: 1 });
  const launches: MemoryWorkerLaunch[] = [];
  const children: FakeWorker[] = [];
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi", PI_CODING_AGENT_DIR: agentDir },
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
  const memoryEvents = () => harness.emittedEvents
    .filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT)
    .map((event) => event.value as { state: string; updatedAt: number; processedSessions: string[] });
  const states = () => memoryEvents().map((event) => event.state);
  assert.deepEqual(states().slice(-2), ["idle", "running"]);
  assert.ok(memoryEvents().at(-1)!.updatedAt > memoryEvents().at(-2)!.updatedAt);

  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await writeFile(paths.memoryFile, "可复用的项目记忆", "utf8");
  child.emit("exit", 0, null);
  await waitFor(async () => states().includes("succeeded") && await pathMissing(paths.workerLockFile));
  const completed = harness.emittedEvents
    .filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT)
    .at(-1)?.value as {
      state: string;
      source: string;
      cwd: string;
      updatedAt: number;
      attemptId?: string;
      contentChars: number;
      processedSessions: string[];
    };
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.source, "manual");
  assert.equal(completed.cwd, project);
  assert.ok(completed.updatedAt > 0);
  assert.ok(completed.attemptId);
  assert.equal(completed.contentChars, 8);
  assert.deepEqual(completed.processedSessions, [await realpath(sessionFile)]);
  const completedIndex = memoryEvents().findIndex((event) => event.state === "succeeded");
  const runningIndex = memoryEvents().findIndex((event) => event.state === "running");
  assert.ok(memoryEvents()[completedIndex].updatedAt > memoryEvents()[runningIndex].updatedAt);

  const reopenedHarness = createHarness();
  projectMemoryExtension(reopenedHarness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi" },
  });
  await reopenedHarness.handlers.get("session_start")?.[0]({}, context);
  const reopenedStatus = reopenedHarness.emittedEvents
    .filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT)
    .at(-1)?.value as { processedSessions: string[] };
  assert.deepEqual(reopenedStatus.processedSessions, [await realpath(sessionFile)]);

  await harness.handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, context);
  const injected = harness.emittedEvents.at(-1)?.value as { injected: boolean; source: string };
  assert.equal(injected.injected, true);
  assert.equal(injected.source, "prompt");
});

test("background memory completion never reads a stale extension context", async (t) => {
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

  let stale = false;
  const notices: string[] = [];
  const assertActive = (): void => {
    if (stale) throw new Error("STALE_EXTENSION_CONTEXT_ACCESSED");
  };
  const context = Object.defineProperties({}, {
    cwd: { get: () => { assertActive(); return project; } },
    hasUI: { get: () => { assertActive(); return true; } },
    ui: {
      get: () => {
        assertActive();
        return { notify: (message: string) => notices.push(message) };
      },
    },
    model: {
      get: () => {
        assertActive();
        return { provider: "pierce", id: "gpt-5.6-sol" };
      },
    },
    sessionManager: {
      get: () => {
        assertActive();
        return { getSessionFile: () => sessionFile };
      },
    },
  });

  await harness.commands.get("memory")?.handler("", context);
  stale = true;
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await writeFile(paths.memoryFile, "后台完成后的记忆", "utf8");
  child.emit("exit", 0, null);

  await waitFor(async () => {
    const states = harness.emittedEvents
      .filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT)
      .map((event) => (event.value as { state: string }).state);
    return states.includes("succeeded") && await pathMissing(paths.workerLockFile);
  });
  assert.match(notices.join("\n"), /记忆整理已在后台启动/);
  assert.equal(
    (harness.emittedEvents.filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT).at(-1)?.value as { cwd: string }).cwd,
    project,
  );
});

test("failed workers do not mark their session as successfully processed", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const sessionFile = join(root, "failed-session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, "session", "utf8");
  const child = new FakeWorker();
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi" },
    spawnWorker: () => child,
  });
  const context = contextFor(project, sessionFile);

  await harness.commands.get("memory")?.handler("", context);
  child.emit("exit", 1, null);
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await waitFor(() => pathMissing(paths.workerLockFile));

  const failed = harness.emittedEvents
    .filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT)
    .at(-1)?.value as { state: string; processedSessions: string[] };
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.processedSessions, []);
  assert.equal(await pathMissing(paths.runtimeStateFile), true);
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
  const status = harness.emittedEvents
    .filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT)
    .at(-1)?.value as { state: string; source: string; updatedAt: number; attemptId?: string };
  assert.equal(status.state, "disabled");
  assert.equal(status.source, "manual");
  assert.ok(status.updatedAt > 0);
  assert.ok(status.attemptId);
});

test("manual memory prechecks always publish a terminal runtime status", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  await mkdir(project, { recursive: true });
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, { env: { PI_PROJECT_MEMORY_DIR: memoryRoot } });
  const notices: string[] = [];
  const context = {
    cwd: project,
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    model: undefined,
    sessionManager: { getSessionFile: () => undefined },
  };

  await harness.commands.get("memory")?.handler("", context);

  const status = harness.emittedEvents
    .filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT)
    .at(-1)?.value as {
      state: string;
      source: string;
      cwd: string;
      updatedAt: number;
      attemptId?: string;
      error?: string;
    };
  assert.equal(status.state, "failed");
  assert.equal(status.source, "manual");
  assert.equal(status.cwd, project);
  assert.ok(status.updatedAt > 0);
  assert.ok(status.attemptId);
  assert.match(status.error ?? "", /没有可用于记忆整理的模型/);
  assert.match(notices.join("\n"), /没有可用于记忆整理的模型/);
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

test("background summaries wait for the configured number of turns", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const agentDir = join(root, "agent");
  const sessionFile = join(root, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, "session", "utf8");
  await writeMemorySettings(agentDir, { version: 1 });
  const launches: MemoryWorkerLaunch[] = [];
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi", PI_CODING_AGENT_DIR: agentDir },
    spawnWorker: (launch) => {
      launches.push(launch);
      return new FakeWorker();
    },
  });
  const context = contextFor(project, sessionFile);
  const settle = harness.handlers.get("agent_settled")?.[0];

  for (let turn = 1; turn < DEFAULT_MEMORY_SUMMARIZE_EVERY_TURNS; turn++) await settle?.({}, context);
  assert.equal(DEFAULT_MEMORY_SUMMARIZE_EVERY_TURNS, 30);
  assert.equal(launches.length, 0);

  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  assert.equal(
    (await readPersistedMemoryState(paths)).turnsSinceSummary,
    DEFAULT_MEMORY_SUMMARIZE_EVERY_TURNS - 1,
  );

  await settle?.({}, context);
  assert.equal(launches.length, 1);
  assert.equal((await readPersistedMemoryState(paths)).turnsSinceSummary, 0);
});

test("the turn interval is configurable and manual runs restart the count", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const agentDir = join(root, "agent");
  const sessionFile = join(root, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, "session", "utf8");
  await writeMemorySettings(agentDir, { version: 1, summarizeEveryTurns: 3 });
  const children: FakeWorker[] = [];
  const launches: MemoryWorkerLaunch[] = [];
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi", PI_CODING_AGENT_DIR: agentDir },
    spawnWorker: (launch) => {
      launches.push(launch);
      const child = new FakeWorker();
      children.push(child);
      return child;
    },
  });
  const context = contextFor(project, sessionFile);
  const settle = harness.handlers.get("agent_settled")?.[0];
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);

  await settle?.({}, context);
  await settle?.({}, context);
  assert.equal(launches.length, 0);
  await settle?.({}, context);
  assert.equal(launches.length, 1);
  children[0].emit("exit", 0, null);
  await waitFor(() => pathMissing(paths.workerLockFile));

  await settle?.({}, context);
  await settle?.({}, context);
  await harness.commands.get("memory")?.handler("", context);
  assert.equal(launches.length, 2);
  assert.equal((await readPersistedMemoryState(paths)).turnsSinceSummary, 0);
  children[1].emit("exit", 0, null);
  await waitFor(() => pathMissing(paths.workerLockFile));

  await settle?.({}, context);
  assert.equal(launches.length, 2);
});

test("turning auto summaries off stops the background task entirely", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const agentDir = join(root, "agent");
  const sessionFile = join(root, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, "session", "utf8");
  await writeMemorySettings(agentDir, { version: 1, autoSummarize: false, summarizeEveryTurns: 1 });
  const launches: MemoryWorkerLaunch[] = [];
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi", PI_CODING_AGENT_DIR: agentDir },
    spawnWorker: (launch) => {
      launches.push(launch);
      return new FakeWorker();
    },
  });
  const context = contextFor(project, sessionFile);

  await harness.handlers.get("agent_settled")?.[0]({}, context);
  await harness.handlers.get("agent_settled")?.[0]({}, context);
  assert.equal(launches.length, 0);
});

test("a legacy single-file memory becomes an index plus one body file per section", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  await mkdir(project, { recursive: true });
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await ensureProjectMemory(paths);
  await writeFile(
    paths.memoryFile,
    "## 部署\n生产用 server-a\n端口 8443，回滚要先停 worker\n\n## 用户偏好\n回答要短，不要贴代码\n",
    "utf8",
  );

  await ensureProjectMemory(paths);
  const index = await readFile(paths.memoryFile, "utf8");
  const entries = parseMemoryIndex(index);

  assert.deepEqual(entries.map((entry) => entry.title), ["部署", "用户偏好"]);
  assert.deepEqual(await listMemoryEntryFiles(paths), ["部署.md", "用户偏好.md"]);
  assert.equal(entries[0].summary, "生产用 server-a");
  assert.doesNotMatch(index, /回滚要先停 worker/);
  assert.match(
    await readFile(join(paths.projectMemoryDir, entries[0].file), "utf8"),
    /端口 8443，回滚要先停 worker/,
  );

  // 已经是索引就别再动它：用户可能手工编辑过索引正文。
  const edited = `${index}- [手写条目](memories/手写条目.md)：手工加的\n`;
  await writeFile(paths.memoryFile, edited, "utf8");
  await ensureProjectMemory(paths);
  assert.equal(await readFile(paths.memoryFile, "utf8"), edited);
});

test("only the index is injected while bodies stay listed for on-demand reads", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const agentDir = join(root, "agent");
  await mkdir(project, { recursive: true });
  await writeMemorySettings(agentDir, { version: 1 });
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await ensureProjectMemory(paths);
  await writeFile(
    paths.memoryFile,
    "## 部署\n生产用 server-a\n发布脚本在 ops/deploy.sh，回滚要先停 worker\n",
    "utf8",
  );

  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_CODING_AGENT_DIR: agentDir },
  });
  const context = contextFor(project, join(root, "session.jsonl"));
  const result = await harness.handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, context);

  assert.match(result.systemPrompt, /- \[部署\]/);
  assert.match(result.systemPrompt, /生产用 server-a/);
  assert.match(result.systemPrompt, new RegExp(`${MEMORY_ENTRIES_DIRNAME}/部署\\.md`));
  assert.doesNotMatch(result.systemPrompt, /回滚要先停 worker/);
});

test("每跑完一次记忆整理，就把旧的 worker 会话残骸清掉", async (t) => {
  // 这些残骸从来没人删过：用户机器上攒了约 1900 份、676MB，比他所有真实对话
  // 加起来还多，而真正记住的内容只有 200KB。
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const sessionFile = join(root, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, "session", "utf8");
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  await mkdir(paths.workerSessionsDir, { recursive: true });
  const leftovers = [
    "2026-08-01T00-00-00-000Z_a.jsonl",
    "2026-08-02T00-00-00-000Z_b.jsonl",
    "2026-08-03T00-00-00-000Z_c.jsonl",
    "2026-08-04T00-00-00-000Z_d.jsonl",
    "2026-08-05T00-00-00-000Z_e.jsonl",
    "2026-08-06T00-00-00-000Z_f.jsonl",
  ];
  for (const name of leftovers) await writeFile(join(paths.workerSessionsDir, name), "旧的整理记录", "utf8");

  const child = new FakeWorker();
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi" },
    spawnWorker: () => child,
  });
  await harness.commands.get("memory")?.handler("", contextFor(project, sessionFile));
  child.emit("exit", 0, null);
  await waitFor(() => pathMissing(paths.workerLockFile));

  // 名字以 ISO 时间开头，排序就是按新旧排；只留最近的几份，够解释一次跑坏了。
  assert.deepEqual((await readdir(paths.workerSessionsDir)).sort(), leftovers.slice(-3));
});

test("清理残骸失败不会让这次记忆整理算失败", async (t) => {
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  const memoryRoot = join(root, ".pi", "agent", "memory");
  const sessionFile = join(root, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(sessionFile, "session", "utf8");
  const paths = await resolveProjectMemoryPaths(project, memoryRoot);
  // 目录压根不存在：清理要安静地跳过，而不是把整次整理拖成 failed。
  const child = new FakeWorker();
  const harness = createHarness();
  projectMemoryExtension(harness.pi as any, {
    env: { PI_PROJECT_MEMORY_DIR: memoryRoot, PI_MEMORY_WORKER_BIN: "/fake/pi" },
    spawnWorker: () => { void rm(paths.workerSessionsDir, { recursive: true, force: true }); return child; },
  });
  await harness.commands.get("memory")?.handler("", contextFor(project, sessionFile));
  child.emit("exit", 0, null);
  await waitFor(() => pathMissing(paths.workerLockFile));

  const states = harness.emittedEvents
    .filter((event) => event.channel === PROJECT_MEMORY_STATUS_EVENT)
    .map((event) => (event.value as { state: string }).state);
  assert.equal(states.at(-1), "succeeded");
});

test("索引的说明是「要不要打开这个文件」，正文才写细节", async (t) => {
  // 用户的原话：现在整理出来的记忆「要么太精简，要么没重点」。根子在于两层被
  // 讲混了——索引有字数上限，于是正文也跟着被压成一句话。
  const root = await temporaryDirectory(t);
  const project = join(root, "A");
  await mkdir(project, { recursive: true });
  const paths = await resolveProjectMemoryPaths(project, join(root, ".pi", "agent", "memory"));

  for (const prompt of [
    buildProjectMemoryPrompt(paths, "索引内容"),
    buildMemoryWorkerPrompt(paths, join(root, "session.jsonl")),
  ]) {
    assert.match(prompt, /不限字数/, "正文必须明确说不限字数");
    assert.match(prompt, /不是把正文压缩一遍|不是正文的摘要/, "说明不是摘要");
    assert.match(prompt, new RegExp(`最多 ${MEMORY_FACTS_MAX} 条`), "重要事实要有硬额度");
    assert.match(prompt, /重要事实/);
    assert.match(prompt, /记忆索引/);
  }
});

test("重要事实只认事实那一段里的短句，且有上限", () => {
  const rendered = renderMemoryIndex(
    [{ title: "部署", file: "memories/部署.md", summary: "要动线上部署时读" }],
    ["端口 8443", "数据库在腾讯云 PG"],
  );
  assert.deepEqual(parseMemoryFacts(rendered), ["端口 8443", "数据库在腾讯云 PG"]);
  // 索引行长得也像 bullet，但它属于索引，不该被当成事实数第二遍。
  assert.deepEqual(parseMemoryIndex(rendered).map((entry) => entry.title), ["部署"]);
  assert.equal(parseMemoryFacts(rendered).includes("[部署](memories/部署.md)：要动线上部署时读"), false);

  const flooded = renderMemoryIndex([], Array.from({ length: 20 }, (_, index) => `事实 ${index}`));
  assert.equal(parseMemoryFacts(flooded).length, MEMORY_FACTS_MAX);
});

test("没有重要事实时，索引里不会留一个空的事实段", () => {
  const rendered = renderMemoryIndex([{ title: "A", file: "memories/a.md", summary: "说明" }]);
  assert.doesNotMatch(rendered, /重要事实/);
  assert.deepEqual(parseMemoryFacts(rendered), []);
});
