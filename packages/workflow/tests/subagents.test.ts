import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import subagentsExtension, {
  disposeRunsForShutdown,
  resumeCwdForRun,
  resumeToolsForRun,
} from "../extensions/subagents.ts";
import {
  childSessionDirectory,
  readChildMeta,
  scanResumableChildren,
} from "../extensions/subagents/child.ts";
import { loadProfiles, parseProfileFile } from "../extensions/subagents/profiles.ts";
import {
  acquireRunControl,
  clampText,
  createRunId,
  type ChildRun,
  prepareRunForResume,
  runIsLive,
  SubagentRegistry,
} from "../extensions/subagents/registry.ts";
import { SUBAGENT_RPC_REQUEST_CHANNEL, subagentRpcReplyChannel } from "../extensions/subagents/types.ts";
import {
  createSubagentWorktree,
  findGitRepoRoot,
  isWorktreeClean,
  removeSubagentWorktreeIfClean,
  subagentWorktreeBranch,
  subagentWorktreePath,
} from "../extensions/subagents/worktree.ts";

interface Emission {
  channel: string;
  payload: unknown;
}

function createHarness() {
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const busListeners = new Map<string, Array<(payload: unknown) => unknown>>();
  const emissions: Emission[] = [];
  const tools: Array<Record<string, unknown>> = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const current = eventHandlers.get(name) ?? [];
      current.push(handler);
      eventHandlers.set(name, current);
    },
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
    events: {
      on(channel: string, listener: (payload: unknown) => unknown) {
        const current = busListeners.get(channel) ?? [];
        current.push(listener);
        busListeners.set(channel, current);
      },
      emit(channel: string, payload: unknown) {
        emissions.push({ channel, payload });
        for (const listener of busListeners.get(channel) ?? []) void listener(payload);
      },
    },
  };
  subagentsExtension(pi as never);
  const tool = tools.find((entry) => entry.name === "subagent");
  assert.ok(tool, "subagent tool must be registered");
  return {
    handlers: eventHandlers,
    emissions,
    eventHandlers,
    parameters: tool.parameters as { properties?: Record<string, unknown> },
    execute: tool.execute as (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown>; isError?: boolean }>,
    emitRpc: (payload: Record<string, unknown>) => {
      for (const listener of busListeners.get(SUBAGENT_RPC_REQUEST_CHANNEL) ?? []) void listener(payload);
    },
  };
}

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/suocode-subagents-test",
    model: undefined,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionDir: () => "/tmp/suocode-subagents-test/sessions",
      getSessionId: () => "parent-session-test",
      getSessionFile: () => "/tmp/suocode-subagents-test/sessions/parent-session-test.jsonl",
    },
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("subagent tool registers with run/status actions", () => {
  const { execute, parameters } = createHarness();
  assert.equal(typeof execute, "function");
  assert.equal(parameters.properties?.planId, undefined, "plan correlation stays on the private runtime RPC");
});

test("run rejects a missing task", async () => {
  const { execute } = createHarness();
  await assert.rejects(execute("call-1", {}, undefined, undefined, createContext()), /缺少子 Agent 任务描述/);
});

test("run rejects a malformed model override", async () => {
  const { execute } = createHarness();
  await assert.rejects(execute("call-2", { task: "看一下 README", model: "no-slash" }, undefined, undefined, createContext()), /模型格式无效/);
});

test("run rejects an unknown model", async () => {
  const { execute } = createHarness();
  await assert.rejects(execute("call-3", { task: "看一下 README", model: "prov/unknown" }, undefined, undefined, createContext()), /未找到模型/);
});

test("run rejects a model without configured auth", async () => {
  const { execute } = createHarness();
  const ctx = createContext({
    modelRegistry: {
      find: () => ({ provider: "prov", id: "locked" }),
      hasConfiguredAuth: () => false,
    },
  });
  await assert.rejects(execute("call-4", { task: "看一下 README", model: "prov/locked" }, undefined, undefined, ctx), /尚未配置 API Key/);
});

test("status reports an empty registry", async () => {
  const { execute } = createHarness();
  const result = await execute("call-5", { action: "status" }, undefined, undefined, createContext());
  assert.match(result.content[0].text, /还没有派发过子 Agent/);
});

test("status rejects an unknown run id", async () => {
  const { execute } = createHarness();
  await assert.rejects(execute("call-6", { action: "status", runId: "missing" }, undefined, undefined, createContext()), /未找到子 Agent 运行/);
});

test("rpc stop rejects an unknown run", async () => {
  const { emitRpc, emissions } = createHarness();
  emitRpc({ version: 1, requestId: "req-1", method: "stop", params: { id: "missing" }, source: { client: "test" } });
  await settle();
  const reply = emissions.find((entry) => entry.channel === subagentRpcReplyChannel("req-1"));
  assert.ok(reply, "rpc reply must be emitted");
  const payload = reply.payload as { success: boolean; error?: { message?: string } };
  assert.equal(payload.success, false);
  assert.match(payload.error?.message ?? "", /未找到子 Agent 运行/);
});

test("rpc status rejects an unknown run", async () => {
  const { emitRpc, emissions } = createHarness();
  emitRpc({ version: 1, requestId: "req-2", method: "status", params: { id: "missing" }, source: { client: "test" } });
  await settle();
  const reply = emissions.find((entry) => entry.channel === subagentRpcReplyChannel("req-2"));
  assert.ok(reply);
  assert.equal((reply.payload as { success: boolean }).success, false);
});

test("rpc rejects unsupported methods", async () => {
  const { emitRpc, emissions } = createHarness();
  emitRpc({ version: 1, requestId: "req-3", method: "steer", params: { id: "x" } });
  await settle();
  const reply = emissions.find((entry) => entry.channel === subagentRpcReplyChannel("req-3"));
  assert.ok(reply);
  const payload = reply.payload as { success: boolean; error?: { message?: string } };
  assert.equal(payload.success, false);
  assert.match(payload.error?.message ?? "", /不支持/);
});

test("rpc resume rejects an unknown run", async () => {
  const { emitRpc, emissions } = createHarness();
  emitRpc({ version: 1, requestId: "req-4", method: "resume", params: { id: "missing" } });
  await settle();
  const reply = emissions.find((entry) => entry.channel === subagentRpcReplyChannel("req-4"));
  assert.ok(reply);
  const payload = reply.payload as { success: boolean; error?: { message?: string } };
  assert.equal(payload.success, false);
  assert.match(payload.error?.message ?? "", /未找到/);
});

test("stop requires a run id", async () => {
  const { execute } = createHarness();
  await assert.rejects(execute("call-7", { action: "stop" }, undefined, undefined, createContext()), /runId/);
});

test("stop rejects an unknown run", async () => {
  const { execute } = createHarness();
  await assert.rejects(execute("call-8", { action: "stop", runId: "missing" }, undefined, undefined, createContext()), /未找到/);
});

test("resume requires a run id", async () => {
  const { execute } = createHarness();
  await assert.rejects(execute("call-9", { action: "resume" }, undefined, undefined, createContext()), /runId/);
});

test("resume rejects an unknown run", async () => {
  const { execute } = createHarness();
  const ctx = createContext({
    sessionManager: { getSessionDir: () => "/tmp/does-not-exist-suocode-subagents" },
  });
  await assert.rejects(execute("call-10", { action: "resume", runId: "missing" }, undefined, undefined, ctx), /未找到/);
});

test("child meta round-trips through persisted session files", () => {
  const dir = mkdtempSync(join(tmpdir(), "suocode-subagent-scan-"));
  mkdirSync(dir, { recursive: true });
  const meta = {
    runId: "sa-scan-test",
    agent: "worker",
    task: "写点东西",
    tools: ["read", "edit", "write"],
    background: true,
    parentSessionId: "parent-a",
    parentSessionFile: "/tmp/sessions/parent-a.jsonl",
    worktree: true,
    worktreePath: "/tmp/worktrees/sa-scan-test",
    startedAt: Date.now(),
  };
  const sessionFile = join(dir, "2026-08-10T00-00-00-000Z_sa-scan-test.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "sa-scan-test" }),
    JSON.stringify({ type: "custom", customType: "suocode-subagent-meta", data: meta }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");
  writeFileSync(
    join(dir, "legacy-unscoped.jsonl"),
    `${JSON.stringify({ type: "custom", customType: "suocode-subagent-meta", data: { runId: "legacy", agent: "worker", task: "old", background: true, startedAt: 1 } })}\n`,
    "utf8",
  );

  const scanned = scanResumableChildren(dir, { parentSessionId: "parent-a" });
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].meta.runId, "sa-scan-test");
  assert.equal(scanned[0].meta.background, true);
  assert.equal(scanned[0].sessionFile, sessionFile);
  assert.deepEqual(scanned[0].meta.tools, ["read", "edit", "write"]);
  assert.equal(readChildMeta(sessionFile)?.agent, "worker");
  assert.equal(scanResumableChildren(dir, { parentSessionId: "parent-b" }).length, 0, "another parent session must not adopt this child");
  assert.equal(scanResumableChildren(join(dir, "nope")).length, 0);
});

test("child session storage is namespaced by the parent session", () => {
  assert.equal(
    childSessionDirectory("/tmp/sessions", "parent-a"),
    join("/tmp/sessions", "subagents", "parent-a"),
  );
  assert.notEqual(
    childSessionDirectory("/tmp/sessions", "parent-a"),
    childSessionDirectory("/tmp/sessions", "parent-b"),
  );
  assert.throws(() => childSessionDirectory("/tmp/sessions", "../escape"), /父会话标识无效/);
});

test("profile frontmatter parses name, tools, model, and prompt body", () => {
  const profile = parseProfileFile(
    ["---", "name: custom", "description: 测试", "tools: [read, grep]", "model: prov/fast", "worktree: true", "---", "你是一个测试代理。"].join("\n"),
    "project",
  );
  assert.ok(profile);
  assert.equal(profile.name, "custom");
  assert.deepEqual(profile.tools, ["read", "grep"]);
  assert.equal(profile.model, "prov/fast");
  assert.equal(profile.worktree, true);
  assert.equal(profile.systemPrompt, "你是一个测试代理。");
});

test("profile parsing rejects missing names and unknown tools", () => {
  assert.equal(parseProfileFile("---\ndescription: 没有名字\n---\n正文", "project"), undefined);
  assert.equal(parseProfileFile("---\nname: bad\ntools: [read, launch_rocket]\n---\n正文", "project"), undefined);
  assert.equal(parseProfileFile("没有 frontmatter", "project"), undefined);
});

test("profile merge precedence is project > user > builtin", () => {
  const root = mkdtempSync(join(tmpdir(), "suocode-profiles-"));
  const builtinDir = join(root, "builtin");
  const userDir = join(root, "user");
  const projectDir = join(root, "project");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(builtinDir, "a.md"), "---\nname: shared\ndescription: builtin\n---\nBUILTIN", "utf8");
  writeFileSync(join(builtinDir, "only-builtin.md"), "---\nname: only-builtin\n---\nB", "utf8");
  writeFileSync(join(userDir, "a.md"), "---\nname: shared\ndescription: user\n---\nUSER", "utf8");
  writeFileSync(join(projectDir, "a.md"), "---\nname: shared\ndescription: project\n---\nPROJECT", "utf8");

  const merged = loadProfiles({ builtinDir, userDir, projectDir });
  assert.equal(merged.size, 2);
  assert.equal(merged.get("shared")?.description, "project");
  assert.equal(merged.get("shared")?.systemPrompt, "PROJECT");
  assert.equal(merged.get("shared")?.source, "project");
  assert.equal(merged.get("only-builtin")?.source, "builtin");
});

test("builtin presets ship explore, reviewer, and worker", () => {
  const builtinDir = join(import.meta.dirname, "..", "agents");
  const merged = loadProfiles({ builtinDir, userDir: join(builtinDir, "none"), projectDir: join(builtinDir, "none") });
  const explore = merged.get("explore");
  const reviewer = merged.get("reviewer");
  const worker = merged.get("worker");
  assert.ok(explore && reviewer && worker);
  assert.ok(!explore.tools?.includes("edit") && !explore.tools?.includes("write"), "explore must stay read-only");
  assert.ok(worker.tools?.includes("edit") && worker.tools?.includes("write"), "worker must be able to write");
  assert.equal(worker.worktree, true);
  assert.match(explore.systemPrompt ?? "", /只读/);
});

test("status listing exposes the profile catalog after session_start", async () => {
  const { handlers, execute } = createHarness();
  await handlers.get("session_start")?.[0]({}, createContext());
  const result = await execute("call-11", { action: "status" }, undefined, undefined, createContext());
  assert.match(result.content[0].text, /explore/);
  assert.match(result.content[0].text, /reviewer/);
  assert.match(result.content[0].text, /worker/);
});

test("run rejects an unknown profile with the catalog", async () => {
  const { handlers, execute } = createHarness();
  await handlers.get("session_start")?.[0]({}, createContext());
  await assert.rejects(
    execute("call-12", { task: "做点事", agent: "no-such-profile" }, undefined, undefined, createContext()),
    (error: Error) => /未找到子 Agent profile/.test(error.message) && /explore/.test(error.message),
  );
});

function makeRun(overrides: Partial<ChildRun> = {}): ChildRun {
  return {
    runId: "sa-test-run",
    agent: "explore",
    task: "搜索配置",
    background: false,
    status: "running",
    startedAt: Date.now() - 1_000,
    recentTools: [],
    recentOutput: [],
    messages: [],
    toolCalls: [],
    timeline: [],
    toolCount: 0,
    turnCount: 0,
    tokens: 0,
    bashBuffer: "",
    ...overrides,
  };
}

test("subagent activity preserves child messages and tool results in execution order", () => {
  const registry = new SubagentRegistry();
  const run = makeRun();
  registry.add(run);

  registry.recordTimelineMessage(run, { role: "assistant", text: "我先检查项目。", thinking: "分析目录结构" });
  registry.recordTimelineToolStart(run, {
    id: "tool-1",
    tool: "read",
    args: "读取 package.json",
    expandedArgs: '{"path":"package.json"}',
  });
  registry.recordTimelineToolEnd(run, { id: "tool-1", output: "{\"name\":\"demo\"}", failed: false });
  registry.recordTimelineMessage(run, { role: "assistant", text: "已经找到入口。" });

  assert.deepEqual(registry.toActivity(run).timeline, [
    {
      id: "message-sa-test-run-0",
      order: 0,
      kind: "message",
      role: "assistant",
      text: "我先检查项目。",
      thinking: "分析目录结构",
    },
    {
      id: "tool-1",
      order: 1,
      kind: "tool",
      tool: "read",
      args: "读取 package.json",
      expandedArgs: '{"path":"package.json"}',
      output: "{\"name\":\"demo\"}",
      status: "succeeded",
    },
    {
      id: "message-sa-test-run-2",
      order: 2,
      kind: "message",
      role: "assistant",
      text: "已经找到入口。",
      thinking: undefined,
    },
  ]);
});

test("subagent timeline retains reasoning-only turns before a tool call", () => {
  const registry = new SubagentRegistry();
  const run = makeRun();
  registry.recordTimelineMessage(run, { role: "assistant", text: "", thinking: "先定位入口文件" });
  registry.recordTimelineToolStart(run, { id: "tool-reasoning", tool: "grep", args: "搜索 main" });

  assert.deepEqual(registry.toActivity(run).timeline?.map((entry) => entry.kind), ["message", "tool"]);
  const reasoning = registry.toActivity(run).timeline?.[0];
  assert.equal(reasoning?.kind, "message");
  if (reasoning?.kind === "message") assert.equal(reasoning.thinking, "先定位入口文件");
});

test("resume preserves the tool allowlist captured by the original profile", () => {
  const run = makeRun({ tools: ["read", "grep", "ls"] });
  const changedProfile = {
    name: "explore",
    tools: ["read", "edit", "write"],
    source: "project" as const,
  };
  assert.deepEqual(resumeToolsForRun(run, changedProfile), ["read", "grep", "ls"]);
  assert.deepEqual(resumeToolsForRun(makeRun({ tools: undefined }), changedProfile), ["read", "edit", "write"]);
  assert.equal(resumeToolsForRun(makeRun({ tools: undefined }), undefined), undefined, "a missing named profile must fail closed");
  assert.deepEqual(resumeToolsForRun(makeRun({ agent: "default", tools: undefined }), undefined), ["read", "bash", "edit", "write", "grep", "ls"]);
});

test("resume fails closed when an isolated worktree disappeared", () => {
  const missing = join(tmpdir(), `suocode-missing-worktree-${Date.now()}`);
  const isolated = makeRun({ worktreeRequired: true, worktreePath: missing });
  const resolved = resumeCwdForRun(isolated, "/tmp/main-workspace");
  assert.equal(resolved.cwd, undefined);
  assert.match(resolved.error ?? "", /拒绝在主工作区继续运行/);
  assert.deepEqual(resumeCwdForRun(makeRun(), "/tmp/main-workspace"), { cwd: "/tmp/main-workspace" });
});

test("resume updates foreground/background state and control operations are mutually exclusive", () => {
  const run = makeRun({ status: "completed", finishedAt: Date.now(), background: true, error: "old" });
  const releaseResume = acquireRunControl(run, "resume");
  assert.throws(() => acquireRunControl(run, "resume"), /正在恢复/);
  assert.throws(() => acquireRunControl(run, "stop"), /正在恢复/);
  prepareRunForResume(run, false, "resume-tool");
  assert.equal(run.background, false);
  assert.equal(run.parentToolId, "resume-tool");
  assert.equal(run.status, "running");
  assert.equal(run.finishedAt, undefined);
  assert.equal(run.error, undefined);
  releaseResume();
  const releaseStop = acquireRunControl(run, "stop");
  assert.equal(run.controlOperation, "stop");
  releaseStop();
  assert.equal(run.controlOperation, undefined);
});

test("session shutdown awaits each child disposer and clears retained handles", async () => {
  let disposed = 0;
  const first = makeRun({
    dispose: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      disposed += 1;
    },
    session: {} as ChildRun["session"],
  });
  const second = makeRun({
    runId: "sa-shutdown-error",
    dispose: async () => {
      disposed += 1;
      throw new Error("expected disposer failure");
    },
    session: {} as ChildRun["session"],
  });
  await disposeRunsForShutdown([first, second]);
  assert.equal(disposed, 2);
  for (const run of [first, second]) {
    assert.equal(run.stopRequested, true);
    assert.equal(run.session, undefined);
    assert.equal(run.dispose, undefined);
  }
});

test("registry resolves runs by id prefix", () => {
  const registry = new SubagentRegistry();
  const run = makeRun();
  registry.add(run);
  registry.add(makeRun({ runId: "sa-other-run" }));
  assert.equal(registry.get("sa-test")?.runId, "sa-test-run");
  assert.equal(registry.get("sa-"), undefined, "ambiguous prefixes must not resolve");
  assert.equal(registry.get("nope"), undefined);
});

test("registry activity reflects live and terminal states", () => {
  const registry = new SubagentRegistry();
  const live = makeRun({ session: {} as ChildRun["session"] });
  const done = makeRun({ runId: "sa-done", status: "completed", finishedAt: Date.now(), finalOutput: "完成", sessionFile: "/tmp/x.jsonl" });
  registry.add(live);
  registry.add(done);
  const liveActivity = registry.toActivity(live);
  const doneActivity = registry.toActivity(done);
  assert.equal(liveActivity.controlReady, true);
  assert.equal(liveActivity.resumable, undefined);
  assert.equal(runIsLive(live), true);
  assert.equal(doneActivity.resumable, true);
  assert.equal(doneActivity.controlReady, undefined);
  assert.equal(doneActivity.finalOutput, "完成");
  assert.equal(registry.liveCount(), 1);
});

test("registry caps recent output entries", () => {
  const registry = new SubagentRegistry();
  const run = makeRun();
  for (let index = 0; index < 40; index += 1) registry.recordRecentOutput(run, `line ${index}`);
  assert.equal(run.recentOutput.length, 24);
  assert.match(run.recentOutput.at(-1) ?? "", /line 39/);
});

test("createRunId produces unique prefixed ids", () => {
  const ids = new Set(Array.from({ length: 200 }, () => createRunId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^sa-[a-z0-9]+-[a-z0-9]+$/);
});

test("clampText truncates long values", () => {
  assert.equal(clampText("abc", 10), "abc");
  const clamped = clampText("a".repeat(100), 10);
  assert.ok(clamped.startsWith("aaaaaaaaaa"));
  assert.match(clamped, /已截断/);
});

const execFileAsync = promisify(execFile);

async function gitIn(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createTempRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "suocode-worktree-repo-"));
  await gitIn(root, ["init", "-b", "main"]);
  writeFileSync(join(root, "README.md"), "# test\n", "utf8");
  await gitIn(root, ["add", "README.md"]);
  await gitIn(root, ["-c", "user.email=test@suocode", "-c", "user.name=test", "commit", "-m", "init"]);
  return root;
}

test("findGitRepoRoot resolves the repo root and rejects non-repos", async () => {
  const root = await createTempRepo();
  const sub = join(root, "a", "b");
  mkdirSync(sub, { recursive: true });
  assert.equal(await findGitRepoRoot(sub), await gitIn(root, ["rev-parse", "--show-toplevel"]));
  const bare = mkdtempSync(join(tmpdir(), "suocode-worktree-none-"));
  assert.equal(await findGitRepoRoot(bare), undefined);
});

test("worktree lifecycle: create, cleanliness check, removal gated on cleanliness", async () => {
  const root = await createTempRepo();
  const runId = "sa-wt-test";
  const created = await createSubagentWorktree(root, runId);
  assert.equal(created.worktreePath, await subagentWorktreePath(root, runId));
  assert.equal(await gitIn(root, ["status", "--porcelain"]), "", "worktree storage must not dirty the parent repository");
  assert.equal(created.branch, subagentWorktreeBranch(runId));
  assert.ok(existsSync(join(created.worktreePath, "README.md")));
  assert.match(await gitIn(root, ["branch", "--list", created.branch]), /suocode\/subagent\/sa-wt-test/);
  assert.equal(await isWorktreeClean(created.worktreePath), true);

  writeFileSync(join(created.worktreePath, "new.txt"), "dirty\n", "utf8");
  assert.equal(await isWorktreeClean(created.worktreePath), false);
  assert.equal(await gitIn(root, ["status", "--porcelain"]), "", "child changes must stay invisible to the parent status");
  assert.equal(await removeSubagentWorktreeIfClean(root, created.worktreePath), false, "dirty worktree must be kept");
  assert.ok(existsSync(created.worktreePath));

  rmSync(join(created.worktreePath, "new.txt"));
  assert.equal(await isWorktreeClean(created.worktreePath), true);
  assert.equal(await removeSubagentWorktreeIfClean(root, created.worktreePath), true);
  assert.ok(!existsSync(created.worktreePath));
});

test("parallel worktrees yield independent checkouts on separate branches", async () => {
  const root = await createTempRepo();
  const [first, second] = await Promise.all([
    createSubagentWorktree(root, "sa-par-a"),
    createSubagentWorktree(root, "sa-par-b"),
  ]);
  writeFileSync(join(first.worktreePath, "a.txt"), "a\n", "utf8");
  writeFileSync(join(second.worktreePath, "b.txt"), "b\n", "utf8");
  assert.ok(!existsSync(join(first.worktreePath, "b.txt")), "worktrees must not share files");
  assert.ok(!existsSync(join(second.worktreePath, "a.txt")), "worktrees must not share files");
  assert.equal(await gitIn(root, ["status", "--porcelain"]), "", "parallel worktrees must not pollute the parent status");
  assert.equal(await gitIn(first.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "suocode/subagent/sa-par-a");
  assert.equal(await gitIn(second.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "suocode/subagent/sa-par-b");
});

test("subagent worktrees stay hidden when the opened project is itself a linked worktree", async () => {
  const root = await createTempRepo();
  const linkedRoot = join(mkdtempSync(join(tmpdir(), "suocode-linked-parent-")), "project-linked");
  await gitIn(root, ["worktree", "add", "-b", "linked-base", linkedRoot]);
  const child = await createSubagentWorktree(linkedRoot, "sa-linked-child");
  assert.ok(existsSync(join(child.worktreePath, "README.md")));
  assert.equal(await gitIn(linkedRoot, ["status", "--porcelain"]), "");
  assert.equal(await gitIn(root, ["status", "--porcelain"]), "");
  assert.equal(await removeSubagentWorktreeIfClean(linkedRoot, child.worktreePath), true);
});

test("run rejects worktree isolation outside a git repository", async () => {
  const { execute } = createHarness();
  const dir = mkdtempSync(join(tmpdir(), "suocode-no-repo-"));
  await assert.rejects(
    execute("call-wt-1", { task: "写点东西", worktree: true }, undefined, undefined, createContext({ cwd: dir })),
    /不是 git 仓库/,
  );
});

test("worker profile defaults to worktree isolation", async () => {
  const { handlers, execute } = createHarness();
  const dir = mkdtempSync(join(tmpdir(), "suocode-no-repo-worker-"));
  await handlers.get("session_start")?.[0]({}, createContext({ cwd: dir }));
  await assert.rejects(
    execute("call-wt-2", { task: "写点东西", agent: "worker" }, undefined, undefined, createContext({ cwd: dir })),
    /不是 git 仓库/,
  );
});
