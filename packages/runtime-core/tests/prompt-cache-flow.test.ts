import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession } from "@earendil-works/pi-coding-agent";
import readCacheExtension from "@coilcoil/workflow/extensions/read-cache.js";
import runtimeBridgeExtension from "@coilcoil/workflow/extensions/runtime-bridge.js";
import { CACHE_LEDGER_ENTRY } from "@coilcoil/workflow/extensions/cache/ledger.js";
import { installSessionRequestPolicy, sessionCacheLedger } from "../src/session-request-policy.js";
import { shutdownAgentSession } from "../src/runtime-state.js";

interface Payload {
  diagnostics?: { previous_message_id: string | null };
  tools: unknown;
  system: unknown;
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
}
const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "cache_control").map(([key, item]) => [key, strip(item)])) : value;

test("actual tool loops pin confirmed prefixes, deduplicate Read, invalidate after compaction and restore the ledger on resume", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "coil-cache-flow-"));
  const project = join(root, "project"), agentDir = join(root, "agent");
  mkdirSync(project);
  mkdirSync(agentDir);
  const file = "file text that must remain accessible to the model\n".repeat(70);
  writeFileSync(join(project, "a.txt"), file);
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "offline-cache-flow-key" } }));
  const models = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  const model = models.getModel("anthropic", "claude-sonnet-5-5")!;
  const bodies: Payload[] = [];
  const sessions = new Set<AgentSession>();
  let phase: "read_twice" | "summary" | "read_again" | "resume" = "read_twice";
  let reads = 0;
  t.after(async () => {
    for (const session of sessions) await shutdownAgentSession(session);
    rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const tool = phase === "read_twice" ? reads++ < 2 : phase === "read_again" ? reads++ < 1 : false;
    const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    const index = bodies.length;
    return new Response(
      event("message_start", { type: "message_start", message: { id: `msg_${index}`, type: "message", role: "assistant", model: model.id, content: [],
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: index === 1 ? 0 : 10_000,
          cache_creation_input_tokens: index === 1 ? 10_000 : 100,
          cache_creation: { ephemeral_5m_input_tokens: index === 1 ? 10_000 : 100, ephemeral_1h_input_tokens: 0 } } } })
      + event("content_block_start", { type: "content_block_start", index: 0,
        content_block: tool ? { type: "tool_use", id: `read_${index}`, name: "read", input: {} } : { type: "text", text: "" } })
      + event("content_block_delta", { type: "content_block_delta", index: 0,
        delta: tool ? { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } : { type: "text_delta", text: "completed summary" } })
      + event("content_block_stop", { type: "content_block_stop", index: 0 })
      + event("message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } })
      + event("message_stop", { type: "message_stop" }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const create = async (manager = SessionManager.create(project, join(root, "sessions"))) => {
    const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 4096 } });
    const loader = new DefaultResourceLoader({ cwd: project, agentDir, eventBus: createEventBus(), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [readCacheExtension, runtimeBridgeExtension] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: project, agentDir, modelRuntime: models, model,
      sessionManager: manager, settingsManager: settings, resourceLoader: loader, thinkingLevel: "medium" });
    installSessionRequestPolicy(session, models);
    sessions.add(session);
    await session.bindExtensions({});
    return session;
  };
  const session = await create();
  await session.prompt("Read a.txt twice");
  assert.equal(bodies.length, 3);
  assert.match(JSON.stringify(bodies[1].messages), /file text that must remain accessible/);
  assert.match(JSON.stringify(bodies[2].messages), /File unchanged for this range/);
  assert.deepEqual(strip(bodies[2].system), strip(bodies[0].system));
  assert.deepEqual(strip(bodies[2].tools), strip(bodies[0].tools));
  assert.equal(bodies[1].diagnostics?.previous_message_id, "msg_1");
  assert.equal(sessionCacheLedger(session)?.recent.at(-1)?.parentPinned, true);
  assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === CACHE_LEDGER_ENTRY));
  phase = "summary";
  await session.compact();
  const before = bodies.length;
  phase = "read_again";
  reads = 0;
  await session.prompt("Read a.txt after compaction");
  const result = JSON.stringify(bodies[before + 1].messages);
  assert.match(result, /file text that must remain accessible/);
  assert.doesNotMatch(result, /File unchanged for this range/, "an old dedup reference must not survive removed history");
  const path = session.sessionFile!;
  const requests = sessionCacheLedger(session)!.requests;
  await shutdownAgentSession(session);
  sessions.delete(session);
  phase = "resume";
  const reopened = await create(SessionManager.open(path));
  assert.equal(sessionCacheLedger(reopened)!.requests, requests);
  assert.ok(sessionCacheLedger(reopened)!.recent.length > 1, "resume stitches compact checkpoints back into recent history");
  await reopened.prompt("Continue after reopening");
  assert.equal(sessionCacheLedger(reopened)!.requests, requests + 1);
  assert.deepEqual(strip(bodies.at(-1)!.system), strip(bodies[0].system));
});
