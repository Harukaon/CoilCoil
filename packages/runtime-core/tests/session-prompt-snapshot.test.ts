import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import projectMemoryExtension from "@coilcoil/workflow/extensions/project-memory.js";
import contextTranscriptExtension, { transcriptPathFor } from "@coilcoil/workflow/extensions/context-transcript.js";
import compactionExtension from "@coilcoil/workflow/extensions/compaction.js";
import runtimeBridgeExtension, { RUNTIME_BRIDGE_STATE_EVENT, type RuntimeBridgeState } from "@coilcoil/workflow/extensions/runtime-bridge.js";
import { shutdownAgentSession } from "../src/runtime-state.js";
import { installSessionRequestPolicy } from "../src/session-request-policy.js";

interface Payload { system: unknown; tools: unknown; messages: Array<Record<string, unknown>> }
function stripCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCache);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "cache_control").map(([key, item]) => [key, stripCache(item)]));
  return value;
}

test("actual requests keep their session prompt through memory edits, reload, compaction and reopen; new sessions load updates", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "coil-prompt-snapshot-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const memoryRoot = join(root, "memory");
  const memoryDir = join(memoryRoot, "project");
  const sessions = new Set<AgentSession>();
  const originalEnv = new Map(["PI_CODING_AGENT_DIR", "PI_MEMORY_WORKER_ENTRY", "PI_PROJECT_MEMORY_DIR"].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_PROJECT_MEMORY_DIR = memoryRoot;
  t.after(async () => {
    for (const session of sessions) await shutdownAgentSession(session);
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(project, "SYSTEM.md"), "original project instructions");
  writeFileSync(join(memoryDir, "MEMORY.md"), "original project memory");
  writeFileSync(join(agentDir, "memory-settings.json"), JSON.stringify({ version: 1, autoSummarize: false }));
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "offline-key" } }));
  const models = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  const model = models.getModel("anthropic", "claude-sonnet-5-5")!;
  const bodies: Payload[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response(
      event("message_start", { type: "message_start", message: { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: model.id, content: [],
        usage: { input_tokens: 100, output_tokens: 0 } } })
      + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
      + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "offline response" } })
      + event("content_block_stop", { type: "content_block_stop", index: 0 })
      + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } })
      + event("message_stop", { type: "message_stop" }), { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  let bridge: RuntimeBridgeState | undefined;
  const create = async (manager = SessionManager.create(project, join(root, "sessions"))) => {
    const bus = createEventBus();
    bus.on(RUNTIME_BRIDGE_STATE_EVENT, (value) => { bridge = value as RuntimeBridgeState; });
    const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } });
    const loader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager: settings, eventBus: bus,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      appendSystemPromptOverride: () => [readFileSync(join(project, "SYSTEM.md"), "utf8")],
      extensionFactories: [contextTranscriptExtension, compactionExtension, (pi) => projectMemoryExtension(pi, {
        env: { PI_CODING_AGENT_DIR: agentDir, PI_PROJECT_MEMORY_DIR: memoryRoot },
      }), runtimeBridgeExtension],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: project, agentDir, modelRuntime: models, model,
      sessionManager: manager, settingsManager: settings, resourceLoader: loader, thinkingLevel: "medium" });
    sessions.add(session);
    installSessionRequestPolicy(session, models);
    await session.bindExtensions({});
    return session;
  };
  const first = await create();
  await first.prompt("first question");
  assert.equal(bridge?.promptLocked, true);
  const original = bodies.at(-1)!;
  assert.match(JSON.stringify(original.system), /original project memory/);
  assert.match(JSON.stringify(original.system), /original project instructions/);
  const sessionFile = first.sessionFile!;
  assert.ok(existsSync(sessionFile));
  const firstUser = first.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
  writeFileSync(join(memoryDir, "MEMORY.md"), "updated background memory");
  writeFileSync(join(project, "SYSTEM.md"), "updated project instructions");
  writeFileSync(join(agentDir, "memory-settings.json"), JSON.stringify({ version: 1, projectMaxChars: 2000, globalEnabled: false, autoSummarize: false }));
  await first.prompt("second question");
  assert.deepEqual(stripCache(bodies.at(-1)!.system), stripCache(original.system));
  assert.deepEqual(stripCache(bodies.at(-1)!.tools), stripCache(original.tools));
  assert.deepEqual(stripCache(bodies.at(-1)!.messages.slice(0, original.messages.length - 1)), stripCache(original.messages.slice(0, -1)), "normal turns must preserve the earlier request prefix");
  assert.doesNotMatch(JSON.stringify(bodies.at(-1)), /updated background memory/);
  await first.reload();
  await first.prompt("after resource reload");
  assert.deepEqual(stripCache(bodies.at(-1)!.system), stripCache(original.system));
  await first.compact();
  assert.ok(existsSync(transcriptPathFor(sessionFile)), "normal compaction must still commit its archive");
  await first.prompt("after compaction");
  assert.deepEqual(stripCache(bodies.at(-1)!.system), stripCache(original.system));
  const rewound = await first.navigateTree(firstUser.id, { summarize: false });
  assert.equal(rewound.cancelled, false);
  await first.prompt("user edited and resent the first question");
  assert.deepEqual(stripCache(bodies.at(-1)!.system), stripCache(original.system));
  await shutdownAgentSession(first);
  sessions.delete(first);
  const reopened = await create(SessionManager.open(sessionFile));
  await reopened.prompt("reopened conversation");
  assert.deepEqual(stripCache(bodies.at(-1)!.system), stripCache(original.system));
  assert.doesNotMatch(JSON.stringify(bodies.at(-1)), /updated background memory/);
  const fresh = await create();
  await fresh.prompt("new conversation");
  assert.match(JSON.stringify(bodies.at(-1)!.system), /updated background memory/);
  assert.match(JSON.stringify(bodies.at(-1)!.system), /updated project instructions/);
});
