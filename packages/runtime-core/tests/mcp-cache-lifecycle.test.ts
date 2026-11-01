import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import mcpExtension, { MCP_MANAGER_CHANNEL, MCP_TOOLS_REFRESH_ENTRY } from "@coilcoil/workflow/extensions/mcp-tools.js";
import bridgeExtension from "@coilcoil/workflow/extensions/runtime-bridge.js";
import { CoilCoilRuntime } from "../src/index.js";
import { shutdownAgentSession } from "../src/runtime-state.js";
import { installSessionRequestPolicy } from "../src/session-request-policy.js";

test("actual requests replay MCP schemas after reload and apply explicit session toggles", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "coil-mcp-cache-lifecycle-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agentDir);
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "offline-test" } }));
  const models = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  const model = models.getModel("anthropic", "claude-sonnet-5-5")!;
  const requests: Array<{ tools: Array<{ name: string; description?: string }>; system: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response(
      event("message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: model.id,
        content: [], usage: { input_tokens: 100, output_tokens: 0 } } })
      + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
      + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } })
      + event("content_block_stop", { type: "content_block_stop", index: 0 })
      + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })
      + event("message_stop", { type: "message_stop" }), { headers: { "content-type": "text/event-stream" } });
  });
  let enabled = true, description = "Original MCP description";
  const manager = {
    directTools: async () => enabled ? [{ server: "probe", tool: { name: "query", description, inputSchema: { type: "object", properties: {} } } }] : [],
    setSessionEnabled: (_name: string, next: boolean) => { enabled = next; },
  };
  const eventBus = createEventBus();
  eventBus.on(MCP_MANAGER_CHANNEL, (value) => { (value as { manager?: unknown }).manager = manager; });
  const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, eventBus, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [mcpExtension, bridgeExtension] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: models, model, settingsManager: settings,
    resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(root, "sessions")) });
  t.after(async () => { await shutdownAgentSession(session); rmSync(root, { recursive: true, force: true }); });
  installSessionRequestPolicy(session, models);
  await session.bindExtensions({});
  await session.prompt("First request");
  assert.equal(requests[0].tools.find((tool) => tool.name === "mcp__probe__query")?.description, description);
  description = "Changed server description";
  await session.reload();
  await session.prompt("Ordinary reload");
  assert.deepEqual(requests[1].tools, requests[0].tools);
  const runtime = Object.create(CoilCoilRuntime.prototype);
  runtime.active = { session, cwd, eventBus, subagents: new Map(), bridgeState: { promptLocked: true } };
  runtime.mcpManager = () => manager;
  runtime.getMcpStatus = async () => ({ servers: [{ name: "probe" }] });
  runtime.refreshAgentMcpConfiguration = async () => {};
  runtime.refreshRuntimeInspectionSources = async () => {};
  runtime.snapshot = async () => ({});
  runtime.runtimeInspection = () => ({});
  runtime.emitEvent = () => {};
  await runtime.setSessionMcpServerEnabled("probe", false);
  await session.prompt("After explicit disable");
  assert.ok(!requests[2].tools.some((tool) => tool.name === "mcp__probe__query"));
  await runtime.setSessionMcpServerEnabled("probe", true);
  await session.prompt("After explicit enable");
  assert.equal(requests[3].tools.find((tool) => tool.name === "mcp__probe__query")?.description, description);
  assert.deepEqual(requests[3].system, requests[0].system);
  assert.equal(session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === MCP_TOOLS_REFRESH_ENTRY).length, 2);
});
