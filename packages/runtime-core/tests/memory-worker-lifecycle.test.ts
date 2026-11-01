import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";
import type { ActiveSession } from "../src/runtime-state.js";
import { projectMemoryStatusByCwd } from "../src/runtime-constants.js";

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the memory worker");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const scenario of ["reload-success", "reload-failure", "switch-success"] as const) {
  test(`runtime memory inspection reaches its terminal state after ${scenario}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "coil-memory-lifecycle-"));
    const cwd = join(root, "project"), agentDir = join(root, "agent"), workflowDir = join(root, "workflow");
    for (const directory of [cwd, agentDir, workflowDir]) mkdirSync(directory);
    const envKeys = ["PI_CODING_AGENT_DIR", "PI_PROJECT_MEMORY_DIR", "PI_MEMORY_WORKER_ENTRY", "PI_MEMORY_WORKER_BIN", "PI_MEMORY_WORKER"];
    const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    delete process.env.PI_MEMORY_WORKER_BIN;
    delete process.env.PI_MEMORY_WORKER;
    process.env.PI_PROJECT_MEMORY_DIR = join(root, "memory");
    const workerEntry = join(root, "worker.cjs");
    const readyFile = join(root, "worker-ready"), releaseFile = join(root, "worker-release");
    writeFileSync(workerEntry, `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
      setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
        const code = Number(fs.readFileSync(${JSON.stringify(releaseFile)}, 'utf8'));
        if (code === 0) fs.writeFileSync(process.env.PI_MEMORY_WORKER_MAIN_FILE, 'memory persisted after extension retirement');
        process.exit(code);
      }, 10);
    `);
    writeFileSync(join(workflowDir, "package.json"), JSON.stringify({ pi: { extensions: [
      fileURLToPath(new URL("../../workflow/extensions/default-tools.ts", import.meta.url)),
      fileURLToPath(new URL("../../workflow/extensions/terminal.ts", import.meta.url)),
      fileURLToPath(new URL("../../workflow/extensions/mcp-tools.ts", import.meta.url)),
      fileURLToPath(new URL("../../workflow/extensions/project-memory.ts", import.meta.url)),
      fileURLToPath(new URL("../../workflow/extensions/runtime-bridge.ts", import.meta.url)),
    ] } }));
    writeFileSync(join(agentDir, "memory-settings.json"), JSON.stringify({ version: 1, autoSummarize: false }));
    const authPath = join(agentDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "offline-test" } }));
    const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    const events: RuntimeEvent[] = [];
    const failures: unknown[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { failures.push(args); });
    const runtime = new CoilCoilRuntime({ agentDir, sessionDir: join(root, "sessions"), workflowDir,
      checkpoints: false, modelRuntime, onEvent: (event) => events.push(event) });
    // This lifecycle test uses no MCP servers or OAuth loopback listeners.
    const internal = runtime as unknown as { active: ActiveSession; mcpManager(): unknown };
    t.mock.method(internal, "mcpManager", () => ({ directTools: async () => [], status: async () => ({ servers: [] }) }));
    process.env.PI_MEMORY_WORKER_ENTRY = workerEntry;
    t.after(async () => {
      writeFileSync(releaseFile, "1");
      await runtime.dispose();
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      projectMemoryStatusByCwd.delete(realpathSync(cwd));
      if (existsSync(readyFile)) {
        try { process.kill(Number(readFileSync(readyFile, "utf8")), "SIGKILL"); } catch { /* Already exited. */ }
      }
      rmSync(root, { recursive: true, force: true });
    });
    const selection = { provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "off" as const };
    await runtime.createSession(cwd, selection);
    const first = internal.active;
    const model = first.session.model!;
    first.session.sessionManager.appendMessage({ role: "user", content: "Remember a stable project fact", timestamp: Date.now() });
    first.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Understood" }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    first.session.agent.state.messages = first.session.sessionManager.buildSessionContext().messages;
    const processedSession = realpathSync(first.session.sessionFile!);
    await runtime.runMemoryNow();
    await waitFor(() => existsSync(readyFile));
    const running = (await runtime.getRuntimeInspection()).memory!;
    assert.equal(running.state, "running");
    const lockFile = join(running.projectMemoryDir!, ".worker.lock");
    assert.equal(existsSync(lockFile), true);

    if (scenario === "switch-success") await runtime.createSession(cwd, selection);
    else await first.session.reload();
    assert.equal((await runtime.getRuntimeInspection()).memory?.state, "running", "startup idle must preserve an active worker");
    const current = internal.active;
    if (scenario === "switch-success") {
      assert.notEqual(current, first);
      // Any attempt to inspect the retired session now fails the test.
      t.mock.method(first.session, "getAllTools", () => { throw new Error("retired session was inspected"); });
    }
    events.length = 0;
    const succeeded = scenario !== "reload-failure";
    writeFileSync(releaseFile, succeeded ? "0" : "1");
    await waitFor(async () => (await runtime.getRuntimeInspection()).memory?.state === (succeeded ? "succeeded" : "failed") && !existsSync(lockFile));
    const terminal = (await runtime.getRuntimeInspection()).memory!;
    assert.equal(terminal.attemptId, running.attemptId);
    assert.ok(terminal.completedAt);
    assert.ok(events.some((event) => event.type === "runtime_inspection_updated" && event.inspection.memory?.state === terminal.state));
    assert.ok(events.some((event) => event.type === "runtime_notice" && event.level === (succeeded ? "success" : "error")));
    assert.deepEqual(failures, []);
    if (succeeded) {
      assert.equal(readFileSync(terminal.memoryFile!, "utf8"), "memory persisted after extension retirement");
      assert.ok(terminal.processedSessions.includes(processedSession));
      const persisted = JSON.parse(readFileSync(join(terminal.projectMemoryDir!, ".coilcoil-memory-state.json"), "utf8"));
      assert.ok(persisted.processedSessions.includes(processedSession));
    } else {
      assert.deepEqual(terminal.processedSessions, []);
      assert.match(terminal.error ?? "", /1/);
      // A failed background task must release both runtime state and the file lease.
      rmSync(releaseFile);
      rmSync(readyFile);
      await runtime.runMemoryNow();
      await waitFor(() => existsSync(readyFile));
      assert.equal((await runtime.getRuntimeInspection()).memory?.state, "running");
      writeFileSync(releaseFile, "1");
      await waitFor(async () => (await runtime.getRuntimeInspection()).memory?.state === "failed" && !existsSync(lockFile));
    }
  });
}
