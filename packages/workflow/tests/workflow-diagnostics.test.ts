import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DiagnosticLog } from "@coilcoil/diagnostics";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_DIAGNOSTIC_PUBLISHER_REQUEST, workflowDiagnosticLog } from "../extensions/diagnostic-channel.ts";
import { MEMORY_STATUS_PUBLISHER_REQUEST } from "../extensions/memory-status-channel.ts";
import projectMemoryExtension from "../extensions/project-memory.ts";
import memoryWorkerDiagnostics from "../extensions/memory-worker-diagnostics.ts";
import { ensureProjectMemory, resolveProjectMemoryPaths } from "../extensions/memory-storage.ts";
import { createChildSession } from "../extensions/subagents/child.ts";
import { installRequestDiagnostics } from "../extensions/request-diagnostics.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !condition(); index++) await delay(10);
  assert.ok(condition(), "expected diagnostic was emitted");
}
async function workspace(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "coil-workflow-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), memoryRoot = join(root, "memory");
  await mkdir(cwd); await mkdir(agentDir);
  const log = new DiagnosticLog({ directory: join(root, "logs"), process: "runtime" });
  const paths = await resolveProjectMemoryPaths(cwd, memoryRoot); await ensureProjectMemory(paths);
  const sessionFile = join(root, "session.jsonl");
  const ctx = { cwd, hasUI: false, model: { provider: "test-provider", id: "test-model" },
    sessionManager: { getSessionId: () => "source-session", getSessionFile: () => sessionFile } };
  return { root, cwd, agentDir, memoryRoot, paths, log, ctx, sessionFile };
}
function harness(log: DiagnosticLog) {
  const handlers = new Map<string, ((...args: any[]) => any)[]>(), commands = new Map<string, any>();
  let retired = false;
  const pi = {
    on(name: string, callback: (...args: any[]) => any) { handlers.set(name, [...handlers.get(name) ?? [], callback]); },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    events: {
      on: () => () => {},
      emit(channel: string, value: any) {
        assert.equal(retired, false, "background callbacks must use captured sinks after retirement");
        if (channel === WORKFLOW_DIAGNOSTIC_PUBLISHER_REQUEST) value.log = log;
        if (channel === MEMORY_STATUS_PUBLISHER_REQUEST) value.publish = () => {};
      },
    },
  };
  return { pi, commands, retire: () => { retired = true; },
    emit: async (name: string, event: object, ctx: unknown) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx); } };
}

test("curator diagnostics retain lifecycle, input sizes and associations after extension retirement without note/session bodies", async (t) => {
  const w = await workspace(t), h = harness(w.log);
  const note = "PRIVATE_NOTE_BODY_SENTINEL", transcript = "PRIVATE_SESSION_BODY_SENTINEL";
  await writeFile(join(w.paths.notesDir, "candidate.md"), note);
  const sessionContent = JSON.stringify({ type: "session", cwd: w.cwd }) + "\n" + transcript;
  await writeFile(w.sessionFile, sessionContent);
  await writeFile(join(w.agentDir, "memory-settings.json"), JSON.stringify({ autoSummarize: false,
    workerProvider: "named-account", workerModelId: "chosen-model", generationRules: "PRIVATE_RULES_SENTINEL" }));
  const child = new EventEmitter() as any; child.unref = () => {};
  let launch: any;
  projectMemoryExtension(h.pi as any, { env: { PI_CODING_AGENT_DIR: w.agentDir, PI_PROJECT_MEMORY_DIR: w.memoryRoot },
    spawnWorker: (value) => { launch = value; return child; } });
  await h.commands.get("memory").handler("", w.ctx);
  const started = w.log.tail().find((entry) => entry.event === "started")!;
  assert.equal(started.data?.provider, "named-account");
  assert.equal(started.data?.model, "chosen-model");
  assert.equal(started.data?.inputSessions, 1); assert.equal(started.data?.inputNotes, 1);
  assert.equal(started.data?.inputBytes, Buffer.byteLength(note + sessionContent));
  assert.equal(started.sessionPath, w.sessionFile);
  assert.equal(launch.env.PI_MEMORY_WORKER_ATTEMPT_ID, started.data?.attemptId);
  assert.ok(launch.args.some((arg: string) => arg.endsWith("memory-worker-diagnostics.ts")));
  await h.emit("session_shutdown", {}, w.ctx); h.retire(); child.emit("exit", 0, null);
  await until(() => w.log.tail().some((entry) => entry.event === "completed"));
  const completed = w.log.tail().find((entry) => entry.event === "completed")!;
  assert.equal(completed.data?.attemptId, started.data?.attemptId);
  assert.ok(Number(completed.data?.durationMs) >= 0);
  assert.doesNotMatch(await readFile(w.log.filePath, "utf8"), /PRIVATE_NOTE_BODY|PRIVATE_SESSION_BODY|PRIVATE_RULES/);
});

test("automatic memory scheduling records skipped work and worker failures without retry loops", async (t) => {
  const w = await workspace(t), h = harness(w.log);
  await writeFile(join(w.agentDir, "memory-settings.json"), JSON.stringify({ autoSummarize: true }));
  projectMemoryExtension(h.pi as any, { idleDelayMs: 10, env: { PI_CODING_AGENT_DIR: w.agentDir, PI_PROJECT_MEMORY_DIR: w.memoryRoot },
    spawnWorker: () => { throw new Error("ENOENT: memory worker executable not found"); } });
  await h.emit("session_start", {}, w.ctx);
  await until(() => w.log.tail().some((entry) => entry.event === "skipped" && entry.data?.reason === "no_changed_inputs"));
  assert.ok(w.log.tail().some((entry) => entry.event === "scheduled" && entry.data?.reason === "startup"));
  await writeFile(join(w.paths.notesDir, "candidate.md"), "PRIVATE_CANDIDATE");
  await h.commands.get("memory").handler("", w.ctx);
  const failed = w.log.tail().find((entry) => entry.event === "failed")!;
  assert.equal(failed.data?.reason, "worker_failed"); assert.match(failed.error?.message ?? "", /ENOENT/);
  await delay(40);
  assert.equal(w.log.tail().filter((entry) => entry.event === "failed").length, 1);
  await h.emit("session_shutdown", {}, w.ctx);
});

test("a missing standalone diagnostic sink is resolved once and never touches a retired bus", () => {
  let calls = 0;
  const sink = workflowDiagnosticLog({ emit: () => { calls++; assert.equal(calls, 1); } });
  sink.log("info", "memory", "started"); sink.log("info", "memory", "completed");
  assert.equal(calls, 1);
});

test("request diagnostics record status and retry correlation while leaving payloads and response headers unchanged", async (t) => {
  const w = await workspace(t), h = harness(w.log);
  installRequestDiagnostics(h.pi as any, w.log, { role: "subagent", parentSessionId: "parent" });
  const payload = Object.freeze({ model: "test-model", system: "PRIVATE_SYSTEM_SENTINEL",
    messages: Object.freeze([{ role: "user", content: "PRIVATE_USER_SENTINEL" }]), api_key: "PRIVATE_CREDENTIAL_SENTINEL" });
  const original = JSON.stringify(payload);
  const headers = Object.freeze({ "request-id": "upstream-123", "retry-after": "4", "set-cookie": "PRIVATE_COOKIE_SENTINEL" });
  await h.emit("before_provider_request", { payload }, w.ctx);
  await h.emit("after_provider_response", { status: 429, headers }, w.ctx);
  assert.equal(JSON.stringify(payload), original);
  assert.equal(headers["set-cookie"], "PRIVATE_COOKIE_SENTINEL");
  const [prepared, failed] = w.log.tail();
  assert.equal(prepared.event, "request_prepared"); assert.ok(Number(prepared.data?.requestContentBytes) > 0);
  assert.equal(failed.level, "error"); assert.equal(failed.data?.status, 429);
  assert.equal(failed.data?.requestId, prepared.data?.requestId);
  assert.equal(failed.data?.upstreamRequestId, "upstream-123"); assert.equal(failed.data?.retryAfter, "4");
  assert.doesNotMatch(await readFile(w.log.filePath, "utf8"), /PRIVATE_SYSTEM|PRIVATE_USER|PRIVATE_CREDENTIAL|PRIVATE_COOKIE/);
});

test("isolated memory worker records real agent/tool event metadata through the shared recorder", async (t) => {
  const w = await workspace(t), h = harness(w.log);
  memoryWorkerDiagnostics(h.pi as any, { log: w.log, env: { PI_MEMORY_WORKER_ATTEMPT_ID: "attempt-1",
    PI_MEMORY_WORKER_WORKSPACE: w.cwd, PI_MEMORY_WORKER_SESSION_FILE: w.sessionFile } });
  t.after(() => h.emit("session_shutdown", {}, w.ctx));
  await h.emit("session_start", {}, w.ctx); await h.emit("agent_start", {}, w.ctx); await h.emit("turn_start", {}, w.ctx);
  await h.emit("tool_execution_start", { toolCallId: "read-note", toolName: "read", args: { path: "note.md", content: "PRIVATE_ARGUMENT_SENTINEL" } }, w.ctx);
  await h.emit("tool_execution_end", { toolCallId: "read-note", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "PRIVATE_TOOL_RESULT_SENTINEL" }] } }, w.ctx);
  await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_RESPONSE_SENTINEL" }],
    provider: "test-provider", model: "test-model", stopReason: "stop", usage: { input: 10, cacheRead: 100, output: 5 } } }, w.ctx);
  await h.emit("agent_settled", { aborted: false }, w.ctx);
  const events = w.log.tail();
  assert.ok(events.some((entry) => entry.scope === "tool" && entry.event === "finished" && entry.data?.resultBytes));
  assert.ok(events.some((entry) => entry.scope === "model" && entry.data?.cacheReadTokens === 100));
  assert.ok(events.every((entry) => entry.data?.memoryAttemptId === "attempt-1"));
  assert.doesNotMatch(await readFile(w.log.filePath, "utf8"), /PRIVATE_ARGUMENT|PRIVATE_TOOL_RESULT|PRIVATE_RESPONSE/);
});

test("the headless worker diagnostic extension loads through Pi's real extension loader", async (t) => {
  const w = await workspace(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = w.agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const settingsManager = SettingsManager.create(w.cwd, w.agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({ cwd: w.cwd, agentDir: w.agentDir, settingsManager, noExtensions: true,
    noThemes: true, noSkills: true, noPromptTemplates: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/memory-worker-diagnostics.ts", import.meta.url))] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(w.agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd: w.cwd, agentDir: w.agentDir, settingsManager, resourceLoader: loader,
    modelRuntime, sessionManager: SessionManager.inMemory(w.cwd), model: getBuiltinModels("anthropic")[0] });
  await session.bindExtensions({ onError: (error) => assert.fail(error.error) });
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
});

test("child session routes internal tool requests and results to its parent's diagnostic sink", async (t) => {
  const w = await workspace(t);
  await writeFile(join(w.cwd, "note.txt"), "PRIVATE_CHILD_RESULT_SENTINEL");
  const child = await createChildSession({ cwd: w.cwd, agentDir: w.agentDir, parentSessionDir: join(w.root, "sessions"),
    parentSessionId: "parent-session", tools: ["read"], onEvent: () => {},
    parentEvents: { emit(channel, value: any) { if (channel === WORKFLOW_DIAGNOSTIC_PUBLISHER_REQUEST) value.log = w.log; } } });
  t.after(() => child.dispose());
  const model = getBuiltinModels("anthropic").find((candidate) => candidate.api === "anthropic-messages")!;
  child.session.agent.state.model = model;
  let rounds = 0;
  child.session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const first = rounds++ === 0;
    const message = { role: "assistant", content: first ? [{ type: "toolCall", id: "child-read", name: "read", arguments: { path: join(w.cwd, "note.txt") } }]
      : [{ type: "text", text: "PRIVATE_CHILD_RESPONSE_SENTINEL" }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 10, output: 5, cacheRead: 30, cacheWrite: 0, totalTokens: 45, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: first ? "toolUse" : "stop", timestamp: Date.now() } as any;
    stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end();
    return stream;
  };
  await child.session.agent.prompt("PRIVATE_CHILD_TASK_SENTINEL");
  const finished = w.log.tail().find((entry) => entry.scope === "tool" && entry.event === "finished");
  assert.equal(finished?.data?.parentSessionId, "parent-session");
  assert.equal(finished?.data?.role, "subagent"); assert.equal(finished?.data?.succeeded, true);
  assert.equal(finished?.sessionPath, child.session.sessionFile);
  assert.doesNotMatch(await readFile(w.log.filePath, "utf8"), /PRIVATE_CHILD_RESULT|PRIVATE_CHILD_RESPONSE|PRIVATE_CHILD_TASK/);
});
