import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import terminalExtension from "@coilcoil/workflow/extensions/terminal.js";
import { shutdownAgentSession } from "../src/runtime-state.js";

test("real session abort stops a shell that already returned a background result", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "coil-stop-shell-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "offline-test" } }));
  const models = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  const model = models.getModel("anthropic", "claude-sonnet-5-5")!;
  let requests = 0;
  let streaming!: () => void;
  const continuing = new Promise<void>((resolve) => { streaming = resolve; });
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    if (++requests > 1) {
      streaming();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Stopped", "AbortError"));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response(
      event("message_start", { type: "message_start", message: { id: "msg_shell", type: "message", role: "assistant", model: model.id,
        content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
      + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "shell", name: "bash", input: {} } })
      + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "sleep 30", block_until_ms: 1 }) } })
      + event("content_block_stop", { type: "content_block_stop", index: 0 })
      + event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } })
      + event("message_stop", { type: "message_stop" }), { headers: { "content-type": "text/event-stream" } });
  });
  const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [terminalExtension] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: models, model,
    settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) });
  t.after(async () => {
    await shutdownAgentSession(session);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  let shell: { pid: number; popped_out_into_background: boolean } | undefined;
  session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "bash") shell = event.result.details;
  });
  await session.bindExtensions({});
  const pending = session.prompt("Run the local test command");
  await continuing;
  assert.equal(shell?.popped_out_into_background, true);
  process.kill(shell!.pid, 0);
  await session.abort();
  await pending;
  assert.throws(() => process.kill(shell!.pid, 0), { code: "ESRCH" });
  const entries = session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "coilcoil-terminal-run");
  assert.ok(entries.some((entry) => entry.type === "custom" && (entry.data as { status?: string }).status === "stopped"));
  assert.equal(requests, 2, "stopping must not generate a notification that starts another model request");
});
