import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import runtimeBridgeExtension, {
  RUNTIME_BRIDGE_COMMAND_EVENT,
  RUNTIME_BRIDGE_POLICY_ENTRY,
  RUNTIME_BRIDGE_REPLY_PREFIX,
  RUNTIME_BRIDGE_STATE_EVENT,
  SESSION_PROMPT_SNAPSHOT_ENTRY,
  filterDisabledSkillsFromPrompt,
  type RuntimeBridgeState,
} from "../extensions/runtime-bridge.ts";
import { UNRESTRICTED_SYSTEM_PROMPT } from "../extensions/unrestricted-system-prompt.ts";

type Handler = (event: unknown, context: unknown) => unknown;
type Reply = { ok: true; state: RuntimeBridgeState } | { ok: false; error: string };
const skillPrompt = `<available_skills>
  <skill><name>one</name><location>/skills/one/SKILL.md</location></skill>
  <skill><name>two</name><location>/skills/two/SKILL.md</location></skill>
</available_skills>`;

function harness(manager = SessionManager.inMemory("/tmp/runtime-bridge")) {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const emitted: Array<{ channel: string; value: unknown }> = [];
  let livePrompt = "base";
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
    events: {
      on(channel: string, listener: (value: unknown) => void) {
        const values = listeners.get(channel) ?? new Set();
        values.add(listener); listeners.set(channel, values);
        return () => values.delete(listener);
      },
      emit(channel: string, value: unknown) {
        emitted.push({ channel, value });
        for (const listener of listeners.get(channel) ?? []) listener(value);
      },
    },
  };
  runtimeBridgeExtension(pi as never);
  const ctx = { getSystemPrompt: () => livePrompt, sessionManager: manager };
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const command = (method: string, params: Record<string, unknown> = {}): Reply => {
    const requestId = String(emitted.length);
    pi.events.emit(RUNTIME_BRIDGE_COMMAND_EVENT, { version: 1, requestId, method, ...params });
    return emitted.find((entry) => entry.channel === `${RUNTIME_BRIDGE_REPLY_PREFIX}${requestId}`)!.value as Reply;
  };
  return { manager, pi, emit, command, setLivePrompt: (prompt: string) => { livePrompt = prompt; },
    state: () => emitted.filter((entry) => entry.channel === RUNTIME_BRIDGE_STATE_EVENT).at(-1)!.value as RuntimeBridgeState,
    start: async (prompt = livePrompt) => await emit("before_agent_start", { systemPrompt: prompt }) as { systemPrompt: string },
  };
}

test("filters only disabled Skill metadata", () => {
  const filtered = filterDisabledSkillsFromPrompt(`before\n${skillPrompt}\nafter`, new Set(["/skills/one/SKILL.md"]));
  assert.doesNotMatch(filtered, /<name>one<\/name>/);
  assert.match(filtered, /<name>two<\/name>/);
  assert.match(filtered, /before/);
  assert.match(filtered, /after/);
});

test("prompt and Skill controls apply before the first turn", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(h.command("set-system-prompt", { prompt: "custom" }).ok, true);
  assert.equal(h.command("set-system-prompt").ok, true);
  assert.equal(h.command("set-skill-enabled", { filePath: "/skills/two/SKILL.md", enabled: false }).ok, true);
  const started = await h.start(skillPrompt);
  assert.match(started.systemPrompt, /<name>one<\/name>/);
  assert.doesNotMatch(started.systemPrompt, /<name>two<\/name>/);
  assert.equal(h.state().promptLocked, true);
});

test("the first final prompt is persisted once and never replaced by live prompt rebuilds", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal((await h.start("base + original memory + archive path")).systemPrompt, "base + original memory + archive path");
  h.setLivePrompt("base + new memory + new Skill list");
  assert.equal((await h.start("a rebuilt prompt")).systemPrompt, "base + original memory + archive path");
  assert.equal(h.command("get").ok, true);
  assert.equal(h.state().effectiveSystemPrompt, "base + original memory + archive path");
  assert.equal(h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === SESSION_PROMPT_SNAPSHOT_ENTRY).length, 1);
});

test("started conversations reject prompt, Skill and mode edits without changing their policy", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.start();
  const entries = h.manager.getBranch().length;
  for (const [method, params] of [
    ["set-system-prompt", { prompt: "new prompt" }],
    ["set-system-prompt", {}],
    ["set-skill-enabled", { filePath: "/skills/one/SKILL.md", enabled: false }],
    ["set-agent-mode", { agentMode: "unrestricted" }],
  ] as const) {
    const reply = h.command(method, params);
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.match(reply.error, /新建对话/);
  }
  assert.equal(h.manager.getBranch().length, entries);
  assert.equal(h.state().agentMode, "standard");
  assert.deepEqual(h.state().disabledSkills, []);
  assert.equal((await h.start("updated files")).systemPrompt, "base");
});

test("reopening restores the saved prompt and policy even when project files changed", async () => {
  const h = harness();
  await h.emit("session_start");
  h.command("set-system-prompt", { prompt: "original override" });
  h.command("set-skill-enabled", { filePath: "/skills/two/SKILL.md", enabled: false });
  await h.start();
  const restoredManager = SessionManager.inMemory("/tmp/runtime-bridge", undefined, [h.manager.getHeader()!, ...h.manager.getBranch()]);
  const reopened = harness(restoredManager);
  reopened.setLivePrompt("updated configuration");
  await reopened.emit("session_start");
  assert.equal(reopened.state().promptLocked, true);
  assert.equal(reopened.state().systemPromptOverride, "original override");
  assert.deepEqual(reopened.state().disabledSkills, ["/skills/two/SKILL.md"]);
  assert.equal((await reopened.start()).systemPrompt, "original override");
});

test("normal compaction keeps the prompt, and an explicit rewind restores the selected branch", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.start("original prompt");
  const first = h.manager.appendMessage({ role: "user", content: "first question", timestamp: 1 });
  const keep = h.manager.appendMessage({ role: "user", content: "recent question", timestamp: 2 });
  h.manager.appendCompaction("older history summarized", keep, 100_000);
  await h.emit("session_compact");
  assert.equal((await h.start("updated files after compaction")).systemPrompt, "original prompt");
  h.manager.branch(first);
  await h.emit("session_tree");
  assert.equal((await h.start("updated files after rewind")).systemPrompt, "original prompt");
  h.manager.resetLeaf();
  await h.emit("session_tree");
  assert.equal(h.state().promptLocked, false, "rewinding before the first turn may establish a new branch snapshot");
  assert.equal((await h.start("new branch prompt")).systemPrompt, "new branch prompt");
});

test("a new conversation, including a copied branch with a new ID, captures its own prompt", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.start("old memory");
  const fresh = SessionManager.inMemory("/tmp/runtime-bridge");
  const copied = SessionManager.inMemory("/tmp/runtime-bridge", undefined, [fresh.getHeader()!, ...h.manager.getBranch()]);
  const next = harness(copied);
  await next.emit("session_start");
  assert.equal(next.state().promptLocked, false);
  assert.equal((await next.start("new memory")).systemPrompt, "new memory");
});

test("the fixed Unrestricted prompt is saved as the conversation snapshot", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(h.command("set-agent-mode", { agentMode: "unrestricted" }).ok, true);
  const rejected = h.command("set-system-prompt", { prompt: "must not apply" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error, /不能编辑 System Prompt/);
  assert.equal((await h.start("ordinary prompt")).systemPrompt, UNRESTRICTED_SYSTEM_PROMPT);
  assert.equal((await h.start("different prompt")).systemPrompt, UNRESTRICTED_SYSTEM_PROMPT);
});

test("pre-turn discovery refreshes the preview, then the inspector follows the saved snapshot", async () => {
  const h = harness();
  await h.emit("session_start");
  h.setLivePrompt("tools after MCP discovery");
  h.command("get");
  assert.equal(h.state().effectiveSystemPrompt, "tools after MCP discovery");
  await h.start();
  h.setLivePrompt("a later rebuild");
  h.command("get");
  assert.equal(h.state().effectiveSystemPrompt, "tools after MCP discovery");
});

test("legacy policy is restored before its first prompt snapshot", async () => {
  const h = harness();
  h.manager.appendCustomEntry(RUNTIME_BRIDGE_POLICY_ENTRY, { systemPromptOverride: "legacy override", disabledSkills: [] });
  await h.emit("session_start");
  assert.equal(h.state().promptLocked, false);
  assert.equal((await h.start()).systemPrompt, "legacy override");
});

test("context inspection preserves the source history and captures an independent copy", async () => {
  const h = harness();
  const messages = [{ role: "user", content: "original question", timestamp: 1 }];
  const before = structuredClone(messages);
  assert.equal(await h.emit("context", { messages }), undefined);
  assert.deepEqual(messages, before);
  messages[0].content = "a later local mutation";
  assert.deepEqual(h.state().contextMessages, before);
});
