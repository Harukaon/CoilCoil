import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CoilCoilRuntime } from "../src/index.js";
import type { ActiveSession } from "../src/runtime-state.js";
import { configureSessionTools } from "../src/session-tools.js";

function stripCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCache);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "cache_control").map(([key, item]) => [key, stripCache(item)]));
  return value;
}

test("a pre-monitor conversation upgrades its tools on reopen while preserving saved history and system prompt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "coil-legacy-tools-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), workflowDir = join(root, "workflow");
  for (const path of [cwd, agentDir, workflowDir]) mkdirSync(path);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const legacyBrowser = ["browser_open", "browser_navigate", "browser_click", "browser_type", "browser_tabs", "mcp__coilcoil_browser__take_snapshot"];
  const legacyExtension = join(root, "legacy-browser.ts");
  writeFileSync(legacyExtension, `export default (pi) => { for (const name of ${JSON.stringify(legacyBrowser)}) pi.registerTool({ name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) }); };`);
  const extensions = ["default-tools", "terminal", "browser-act", "mcp-tools", "runtime-bridge"].map((name) =>
    fileURLToPath(new URL(`../../workflow/extensions/${name}.ts`, import.meta.url)));
  writeFileSync(join(workflowDir, "package.json"), JSON.stringify({ pi: { extensions: [...extensions, legacyExtension] } }));
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "offline-test" } }));
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
  const runtime = new CoilCoilRuntime({ agentDir, sessionDir: join(root, "sessions"), workflowDir,
    checkpoints: false, modelRuntime });
  const internal = runtime as unknown as { active: ActiveSession; mcpManager(): unknown };
  t.mock.method(internal, "mcpManager", () => ({ directTools: async () => [], status: async () => ({ servers: [] }) }));
  const requests: Array<{ system: unknown; tools: unknown; messages: unknown[] }> = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response(
      event("message_start", { type: "message_start", message: { id: `msg_${requests.length}`, role: "assistant", model: "claude-sonnet-5-5", content: [],
        usage: { input_tokens: 10, output_tokens: 0 } } })
      + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
      + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "offline reply" } })
      + event("content_block_stop", { type: "content_block_stop", index: 0 })
      + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } })
      + event("message_stop", { type: "message_stop" }), { headers: { "content-type": "text/event-stream" } });
  });
  t.after(async () => {
    await runtime.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  const selection = { provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "off" as const };
  await runtime.createSession(cwd, selection);
  assert.ok(internal.active.session.getActiveToolNames().includes("monitor"));
  internal.active.titleAttempted = true;
  const legacy = [...new Set([...internal.active.session.getActiveToolNames().filter((name) => name !== "monitor" && name !== "browser"), ...legacyBrowser])];
  internal.active.session.setActiveToolsByName(legacy);
  await internal.active.session.prompt("a conversation started before monitor existed");
  const first = requests.at(-1)!;
  const path = internal.active.session.sessionFile!;
  writeFileSync(join(workflowDir, "package.json"), JSON.stringify({ pi: { extensions } }));

  await runtime.openSession(cwd, path);
  internal.active.titleAttempted = true;
  assert.ok(internal.active.session.getToolDefinition("monitor"), "capability must still be installed");
  assert.deepEqual(internal.active.session.getActiveToolNames(), [...legacy.filter((name) => !legacyBrowser.includes(name)), "monitor", "browser"], "version upgrades must enable monitor and consolidate old browser declarations");
  await internal.active.session.prompt("continue the saved conversation");
  const resumed = requests.at(-1)!;
  assert.deepEqual(stripCache(resumed.system), stripCache(first.system));
  assert.ok(JSON.stringify(resumed.tools).includes('"name":"monitor"'));
  assert.ok(!JSON.stringify(first.tools).includes('"name":"monitor"'));
  assert.deepEqual((resumed.tools as Array<{ name: string }>).filter((tool) => tool.name.includes("browser")).map((tool) => tool.name), ["browser"]);
  assert.deepEqual(stripCache(resumed.messages.slice(0, first.messages.length)), stripCache(first.messages));
  assert.equal(requests.length, 2, "only the two explicit user turns request a model");

  await runtime.createSession(cwd, selection);
  assert.ok(internal.active.session.getActiveToolNames().includes("monitor"));
});

test("a missing monitor implementation remains a hard workflow error", async () => {
  let disposed = false;
  const session = {
    getActiveToolNames: () => ["read", "bash", "edit", "write", "grep", "ls", "terminal", "mcp"],
    setActiveToolsByName: () => undefined,
    getToolDefinition: () => undefined,
    abortCompaction: () => undefined,
    abortBranchSummary: () => undefined,
    abort: async () => undefined,
    extensionRunner: { hasHandlers: () => false },
    dispose: () => { disposed = true; },
  } as unknown as Parameters<typeof configureSessionTools>[0];
  await assert.rejects(configureSessionTools(session, (model) => model), /did not register required tools: monitor/);
  assert.equal(disposed, true);
});
