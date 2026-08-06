import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "suocode-runtime-smoke-"));
const projectDir = join(temporaryRoot, "project");
const live = process.argv.includes("--live");
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, "README.md"), "# Runtime smoke project\n", "utf8");
const largeDirectory = join(projectDir, "aaa-large");
mkdirSync(largeDirectory);
for (let index = 0; index < 1_205; index += 1) {
  writeFileSync(join(largeDirectory, `entry-${String(index).padStart(4, "0")}.txt`), "x", "utf8");
}
writeFileSync(join(projectDir, "zz-root.txt"), "root sibling\n", "utf8");

const child = fork(join(root, "apps/desktop/out/main/runtime.js"), [], {
  env: {
    ...process.env,
    SUOCODE_AGENT_DIR: join(temporaryRoot, "agent"),
    SUOCODE_SESSION_DIR: join(temporaryRoot, "sessions"),
    SUOCODE_LEGACY_AGENT_DIR: live ? join(homedir(), ".pi", "agent") : join(temporaryRoot, "no-legacy"),
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});

const pending = new Map();
const events = [];
let nextId = 0;
let runtimeError;

child.stderr.on("data", (chunk) => {
  runtimeError = `${runtimeError || ""}${chunk}`;
});
child.on("message", (message) => {
  if (message && typeof message === "object" && "event" in message) {
    events.push(message.event);
    return;
  }
  const callback = pending.get(message?.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.ok) callback.resolve(message.result);
  else callback.reject(new Error(message.error || "Runtime command failed"));
});

function request(command) {
  const id = `smoke-${++nextId}`;
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    child.send({ id, command });
  });
}

function waitForEvent(predicate, timeoutMs = 180_000) {
  return new Promise((resolveEvent, rejectEvent) => {
    let cursor = events.length;
    const timer = setInterval(() => {
      while (cursor < events.length) {
        const event = events[cursor++];
        if (predicate(event)) {
          clearInterval(timer);
          clearTimeout(timeout);
          resolveEvent(event);
          return;
        }
      }
    }, 25);
    const timeout = setTimeout(() => {
      clearInterval(timer);
      rejectEvent(new Error(`Timed out waiting for runtime event. ${runtimeError || ""}`));
    }, timeoutMs);
  });
}

try {
  const bootstrap = await request({ type: "bootstrap" });
  if (!bootstrap?.configuration?.models) throw new Error("Bootstrap did not return model configuration.");
  const initialMcp = await request({ type: "get_mcp_configuration", cwd: projectDir });
  if (!initialMcp?.configPath?.startsWith(temporaryRoot) || initialMcp.servers.some((server) => server.name === "smoke-server")) {
    throw new Error("MCP configuration was not isolated inside the SuoCode runtime.");
  }
  const savedMcp = await request({
    type: "save_mcp_server",
    cwd: projectDir,
    server: {
      name: "smoke-server",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      env: { SUOCODE_MCP_SMOKE: "1" },
      headers: {},
      lifecycle: "lazy",
      directTools: false,
    },
  });
  const smokeMcp = savedMcp.servers.find((server) => server.name === "smoke-server");
  if (!smokeMcp || smokeMcp.command !== process.execPath || smokeMcp.env.SUOCODE_MCP_SMOKE !== "1") {
    throw new Error("The Pi MCP adapter configuration bridge did not persist a stdio server.");
  }
  const removedMcp = await request({ type: "remove_mcp_server", cwd: projectDir, name: "smoke-server" });
  if (removedMcp.servers.some((server) => server.name === "smoke-server")) {
    throw new Error("The Pi MCP adapter configuration bridge did not remove a SuoCode-owned server.");
  }
  const snapshot = await request({ type: "create_session", cwd: projectDir });
  if (!snapshot?.project?.files?.some((entry) => entry.name === "README.md")) throw new Error("Project files were not projected.");
  if (!Array.isArray(snapshot.subagents)) throw new Error("Subagent activity was not included in the session snapshot.");
  let invalidSubagentStopRejected = false;
  try {
    await request({ type: "stop_subagent", id: "missing-smoke-subagent", background: true });
  } catch (error) {
    invalidSubagentStopRejected = !String(error).includes("超时");
  }
  if (!invalidSubagentStopRejected) {
    throw new Error("The bundled pi-subagents RPC bridge did not reject an unknown background run.");
  }
  if (!snapshot.project.files.some((entry) => entry.name === "zz-root.txt")) {
    throw new Error("A large nested directory starved later root files from the project tree.");
  }
  const largeNode = snapshot.project.files.find((entry) => entry.name === "aaa-large");
  if (!largeNode || largeNode.children !== undefined) {
    throw new Error("Project folders were traversed before the user expanded them.");
  }
  const lazyChildren = await request({ type: "list_directory", path: largeNode.path });
  if (lazyChildren.length !== 1_205 || lazyChildren.some((entry) => entry.children !== undefined)) {
    throw new Error("Lazy directory loading did not return exactly one directory level.");
  }
  const file = await request({ type: "read_file", path: "README.md" });
  if (!file.content.includes("Runtime smoke project")) throw new Error("Project file reading failed.");

  if (!live) {
    const timestamp = new Date().toISOString();
    mkdirSync(dirname(snapshot.session.path), { recursive: true });
    const subagentToolId = "subagent-smoke-tool";
    const sessionEntries = [
      { type: "session", version: 3, id: snapshot.session.id, timestamp, cwd: snapshot.session.cwd },
      {
        type: "message",
        id: "subagent-call-entry",
        parentId: null,
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: subagentToolId, name: "subagent", arguments: { agent: "scout", task: "验证扩展投影" } }],
          api: "openai-responses",
          provider: "smoke",
          model: "smoke",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
      },
      {
        type: "message",
        id: "subagent-result-entry",
        parentId: "subagent-call-entry",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: subagentToolId,
          toolName: "subagent",
          content: [{ type: "text", text: "子 Agent 已完成" }],
          details: {
            mode: "single",
            runId: "subagent-smoke-run",
            results: [{
              agent: "scout",
              task: "验证扩展投影",
              exitCode: 0,
              model: "smoke-child-model",
              usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: 0, turns: 2 },
              messages: [{ role: "assistant", content: [{ type: "thinking", text: "检查结构化事件" }, { type: "text", text: "扩展投影完成" }] }],
              toolCalls: [{ text: "读取测试文件", expandedText: "read /tmp/subagent-smoke" }],
              finalOutput: "扩展投影完成",
              transcriptPath: "/tmp/subagent-smoke.jsonl",
              sessionFile: "/tmp/subagent-smoke-session.jsonl",
            }],
          },
          isError: false,
          timestamp: Date.now(),
        },
      },
    ];
    writeFileSync(snapshot.session.path, `${sessionEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    const persistedSessions = await request({ type: "list_sessions", cwd: projectDir });
    if (!persistedSessions.some((session) => session.path === snapshot.session.path)) throw new Error("The session archive fixture was not discoverable.");
    const afterArchive = await request({ type: "archive_session", cwd: projectDir, sessionPath: snapshot.session.path });
    if (afterArchive.some((session) => session.path === snapshot.session.path)) throw new Error("Archived sessions were not hidden from the default list.");
    const archivedSessions = await request({ type: "list_archived_sessions", cwd: projectDir });
    if (!archivedSessions.some((session) => session.path === snapshot.session.path && session.archivedAt)) throw new Error("Archived sessions were not listed with archive metadata.");
    const afterRestore = await request({ type: "restore_session", cwd: projectDir, sessionPath: snapshot.session.path });
    if (!afterRestore.some((session) => session.path === snapshot.session.path)) throw new Error("Restored sessions did not return to the default list.");
    const restoredFixture = await request({ type: "open_session", cwd: projectDir, sessionPath: snapshot.session.path });
    const restoredSubagent = restoredFixture.subagents.find((activity) => activity.runId === "subagent-smoke-run");
    if (
      !restoredSubagent
      || restoredSubagent.parentToolId !== subagentToolId
      || restoredSubagent.model !== "smoke-child-model"
      || restoredSubagent.messages?.[0]?.thinking !== "检查结构化事件"
      || restoredSubagent.toolCalls?.[0]?.expandedText !== "read /tmp/subagent-smoke"
      || restoredSubagent.finalOutput !== "扩展投影完成"
    ) {
      throw new Error("The pi-subagents structured result was not restored through the SuoCode projection bridge.");
    }
  }

  if (live) {
    const configuration = bootstrap.configuration;
    if (!configuration.provider || !configuration.modelId) throw new Error("Live smoke test has no default model.");
    if (!configuration.configuredProviders.includes(configuration.provider)) {
      throw new Error(`Live smoke test has no credential for ${configuration.provider}.`);
    }
    const liveModel = configuration.models.find((model) => model.provider === configuration.provider && model.id === "gpt-5.6-luna" && model.configured)
      ?? configuration.models.find((model) => model.provider === configuration.provider && model.id === configuration.modelId)
      ?? configuration.models.find((model) => model.configured);
    if (!liveModel) throw new Error("Live smoke test has no configured model.");
    await request({
      type: "configure_model",
      provider: liveModel.provider,
      modelId: liveModel.id,
      thinkingLevel: "low",
    });
    const settled = waitForEvent((event) => event.type === "run_state" && event.running === false);
    await request({
      type: "prompt",
      text: "Use the write tool to create runtime-proof.txt containing exactly SUOCODE_RUNTIME_OK followed by a newline. Then reply with a brief confirmation.",
    });
    await settled;
    const proofPath = join(projectDir, "runtime-proof.txt");
    if (!existsSync(proofPath) || readFileSync(proofPath, "utf8").trim() !== "SUOCODE_RUNTIME_OK") {
      console.error(JSON.stringify({
        runtimeError,
        events: events.filter((event) => !["runtime_ready", "configuration_updated", "session_snapshot", "project_updated"].includes(event.type)).slice(-30).map((event) => ({
          type: event.type,
          running: event.running,
          message: event.message?.text || event.message,
          tool: event.tool ? { name: event.tool.name, status: event.tool.status, label: event.tool.label, output: event.tool.output } : undefined,
        })),
      }, null, 2));
      throw new Error("The live agent did not create the expected proof file.");
    }
    const writeToolEvent = events.find((event) => event.type === "tool_finished" && event.tool.name === "write");
    if (!writeToolEvent) {
      throw new Error("The write tool lifecycle was not projected.");
    }
    if (!writeToolEvent.tool.label || writeToolEvent.tool.label === "写入 runtime-proof.txt") {
      throw new Error(`The workflow purpose was not projected into the tool label: ${writeToolEvent.tool.label || "<empty>"}`);
    }
    const metricsEvent = events.findLast((event) => event.type === "metrics_updated");
    if (!metricsEvent?.responseMetrics || metricsEvent.responseMetrics.outputTokens <= 0) {
      throw new Error("The workflow response metrics were not projected.");
    }
    if (
      typeof metricsEvent.responseMetrics.inputTokens !== "number"
      || typeof metricsEvent.responseMetrics.cacheReadTokens !== "number"
      || typeof metricsEvent.responseMetrics.cacheWriteTokens !== "number"
    ) {
      throw new Error("Per-request input and cache token fields were not projected.");
    }
    const restored = await request({ type: "open_session", cwd: projectDir, sessionPath: snapshot.session.path });
    const restoredWriteTool = restored.tools.find((tool) => tool.name === "write");
    if (!restoredWriteTool || restoredWriteTool.label !== writeToolEvent.tool.label) {
      throw new Error(
        `The workflow purpose was not restored from session audit entries: ${restoredWriteTool?.label || "<missing>"}`,
      );
    }
    if (!restored.responseMetrics || restored.responseMetrics.timestamp !== metricsEvent.responseMetrics.timestamp) {
      throw new Error("The workflow response metrics were not restored from the session.");
    }
    if (!Array.isArray(restored.responseMetricsHistory) || restored.responseMetricsHistory.length < 1) {
      throw new Error("The response performance history was not restored from the session.");
    }
    if (!restored.contextUsage?.contextWindow || restored.tokenUsage.output <= 0) {
      throw new Error("Context and token usage were not included in the restored session snapshot.");
    }
    const rewindTarget = restored.messages.find((message) => message.role === "user");
    if (!rewindTarget?.entryId) throw new Error("Historical user messages did not expose a Pi session entry ID.");
    const rewindToken = `SUOCODE_REWIND_OK_${Date.now()}`;
    const rewindEventStart = events.length;
    const rewindSettled = waitForEvent((event) => event.type === "run_state" && event.running === false);
    await request({ type: "rewind_prompt", entryId: rewindTarget.entryId, text: `Reply exactly ${rewindToken}.` });
    const immediateRewindSnapshot = events.slice(rewindEventStart).find((event) => event.type === "session_snapshot");
    if (!immediateRewindSnapshot) {
      throw new Error("Rewinding did not publish the cleaned Pi branch before starting the replacement request.");
    }
    if (immediateRewindSnapshot.snapshot.messages.some((message) => message.role === "assistant")) {
      throw new Error("The immediate rewind snapshot still contained assistant messages from the abandoned branch.");
    }
    await rewindSettled;
    const rewound = await request({ type: "open_session", cwd: projectDir, sessionPath: snapshot.session.path });
    if (!rewound.messages.some((message) => message.role === "user" && message.text.includes(rewindToken))) {
      throw new Error("Rewinding and resubmitting did not move the active Pi branch to the edited message.");
    }
    if ((rewound.responseMetricsHistory?.length ?? 0) < 2) {
      throw new Error("Performance history did not retain both model requests.");
    }
  }

  process.stdout.write(`SuoCode runtime smoke passed${live ? " (live model + tool execution)" : ""}.\n`);
} finally {
  if (child.connected) child.disconnect();
  child.kill("SIGTERM");
  rmSync(temporaryRoot, { recursive: true, force: true });
}
