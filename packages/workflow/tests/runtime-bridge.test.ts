import assert from "node:assert/strict";
import test from "node:test";
import runtimeBridgeExtension, {
  RUNTIME_BRIDGE_COMMAND_EVENT,
  RUNTIME_BRIDGE_POLICY_ENTRY,
  RUNTIME_BRIDGE_REPLY_PREFIX,
  filterDisabledSkillsFromPrompt,
} from "../extensions/runtime-bridge.ts";

test("filters only the disabled Skill metadata block", () => {
  const prompt = `before
<available_skills>
  <skill>
    <name>one</name>
    <description>first</description>
    <location>/skills/one/SKILL.md</location>
  </skill>
  <skill>
    <name>two</name>
    <description>second</description>
    <location>/skills/two/SKILL.md</location>
  </skill>
</available_skills>
after`;
  const filtered = filterDisabledSkillsFromPrompt(prompt, new Set(["/skills/one/SKILL.md"]));
  assert.doesNotMatch(filtered, /<name>one<\/name>/);
  assert.match(filtered, /<name>two<\/name>/);
  assert.match(filtered, /before/);
  assert.match(filtered, /after/);
});

test("applies session prompt and Skill controls through the event bridge", async () => {
  const handlers = new Map<string, Function[]>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const emitted: Array<{ channel: string; value: any }> = [];
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: {
      on(channel: string, listener: (value: unknown) => void) {
        const values = listeners.get(channel) ?? new Set();
        values.add(listener);
        listeners.set(channel, values);
        return () => values.delete(listener);
      },
      emit(channel: string, value: unknown) {
        emitted.push({ channel, value });
        for (const listener of listeners.get(channel) ?? []) listener(value);
      },
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  };
  runtimeBridgeExtension(pi as any);
  pi.events.emit(RUNTIME_BRIDGE_COMMAND_EVENT, {
    version: 1,
    requestId: "prompt",
    method: "set-system-prompt",
    prompt: "custom effective prompt",
  });
  const result = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, {});
  assert.equal(result.systemPrompt, "custom effective prompt");
  assert.equal(emitted.find((event) => event.channel === `${RUNTIME_BRIDGE_REPLY_PREFIX}prompt`)?.value.ok, true);
  pi.events.emit(RUNTIME_BRIDGE_COMMAND_EVENT, {
    version: 1,
    requestId: "restore",
    method: "set-system-prompt",
  });
  const restored = emitted.find((event) => event.channel === `${RUNTIME_BRIDGE_REPLY_PREFIX}restore`)?.value.state;
  assert.equal(restored.systemPromptOverride, undefined);
  assert.equal(restored.effectiveSystemPrompt, "base");
  assert.equal(entries.length, 2);
});

test("restores the latest persisted session prompt and Skill policy", async () => {
  const handlers = new Map<string, Function[]>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const emitted: Array<{ channel: string; value: any }> = [];
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: {
      on(channel: string, listener: (value: unknown) => void) {
        const values = listeners.get(channel) ?? new Set();
        values.add(listener);
        listeners.set(channel, values);
        return () => values.delete(listener);
      },
      emit(channel: string, value: unknown) {
        emitted.push({ channel, value });
        for (const listener of listeners.get(channel) ?? []) listener(value);
      },
    },
    appendEntry() {},
  };
  runtimeBridgeExtension(pi as any);
  const basePrompt = `<available_skills>
  <skill>
    <name>one</name>
    <location>/skills/one/SKILL.md</location>
  </skill>
  <skill>
    <name>two</name>
    <location>/skills/two/SKILL.md</location>
  </skill>
</available_skills>`;
  let branchEntries = [
    { type: "custom", customType: RUNTIME_BRIDGE_POLICY_ENTRY, data: { systemPromptOverride: "old", disabledSkills: ["/skills/old/SKILL.md"] } },
    { type: "custom", customType: RUNTIME_BRIDGE_POLICY_ENTRY, data: { systemPromptOverride: "restored prompt", disabledSkills: ["/skills/two/SKILL.md"] } },
  ];
  const context = {
    getSystemPrompt: () => basePrompt,
    sessionManager: {
      getBranch: () => branchEntries,
    },
  };
  await handlers.get("session_start")?.[0]({}, context);

  pi.events.emit(RUNTIME_BRIDGE_COMMAND_EVENT, {
    version: 1,
    requestId: "restored-state",
    method: "get",
  });
  const state = emitted.find((event) => event.channel === `${RUNTIME_BRIDGE_REPLY_PREFIX}restored-state`)?.value.state;
  assert.equal(state.effectiveSystemPrompt, "restored prompt");
  assert.equal(state.systemPromptOverride, "restored prompt");
  assert.deepEqual(state.disabledSkills, ["/skills/two/SKILL.md"]);

  const started = await handlers.get("before_agent_start")?.[0]({ systemPrompt: basePrompt }, {});
  assert.equal(started.systemPrompt, "restored prompt");

  pi.events.emit(RUNTIME_BRIDGE_COMMAND_EVENT, {
    version: 1,
    requestId: "clear-restored-prompt",
    method: "set-system-prompt",
  });
  const filteredState = emitted.find((event) => event.channel === `${RUNTIME_BRIDGE_REPLY_PREFIX}clear-restored-prompt`)?.value.state;
  assert.match(filteredState.effectiveSystemPrompt, /<name>one<\/name>/);
  assert.doesNotMatch(filteredState.effectiveSystemPrompt, /<name>two<\/name>/);

  branchEntries = [];
  await handlers.get("session_tree")?.[0]({}, context);
  pi.events.emit(RUNTIME_BRIDGE_COMMAND_EVENT, {
    version: 1,
    requestId: "rewound-state",
    method: "get",
  });
  const rewoundState = emitted.find((event) => event.channel === `${RUNTIME_BRIDGE_REPLY_PREFIX}rewound-state`)?.value.state;
  assert.equal(rewoundState.systemPromptOverride, undefined);
  assert.deepEqual(rewoundState.disabledSkills, []);
  assert.match(rewoundState.effectiveSystemPrompt, /<name>one<\/name>/);
  assert.match(rewoundState.effectiveSystemPrompt, /<name>two<\/name>/);
});

test("会话开始后提示词又变了，get 拿到的是当前值而不是开场快照", async () => {
  const handlers = new Map<string, Function[]>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const emitted: Array<{ channel: string; value: any }> = [];
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: {
      on(channel: string, listener: (value: unknown) => void) {
        const values = listeners.get(channel) ?? new Set();
        values.add(listener);
        listeners.set(channel, values);
        return () => values.delete(listener);
      },
      emit(channel: string, value: unknown) {
        emitted.push({ channel, value });
        for (const listener of listeners.get(channel) ?? []) listener(value);
      },
    },
    appendEntry() {},
  };
  runtimeBridgeExtension(pi as any);

  // 开场时的提示词。
  let livePrompt = "工具：read, bash";
  const context = {
    getSystemPrompt: () => livePrompt,
    sessionManager: { getBranch: () => [] },
  };
  await handlers.get("session_start")?.[0]({}, context);

  // session_start 之后仍会改提示词的真实情况：mcp-adapter 异步发现 MCP 服务后
  // 调用 setActiveTools，Pi 借此重建系统提示词。
  livePrompt = "工具：read, bash, mcp__github__search";

  pi.events.emit(RUNTIME_BRIDGE_COMMAND_EVENT, { version: 1, requestId: "after-mcp", method: "get" });
  const state = emitted.find((event) => event.channel === `${RUNTIME_BRIDGE_REPLY_PREFIX}after-mcp`)?.value.state;
  assert.equal(state.effectiveSystemPrompt, livePrompt);
});

test("重新读取实时提示词时仍然套用被禁用的 Skill 过滤", async () => {
  const handlers = new Map<string, Function[]>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const emitted: Array<{ channel: string; value: any }> = [];
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: {
      on(channel: string, listener: (value: unknown) => void) {
        const values = listeners.get(channel) ?? new Set();
        values.add(listener);
        listeners.set(channel, values);
        return () => values.delete(listener);
      },
      emit(channel: string, value: unknown) {
        emitted.push({ channel, value });
        for (const listener of listeners.get(channel) ?? []) listener(value);
      },
    },
    appendEntry() {},
  };
  runtimeBridgeExtension(pi as any);
  let livePrompt = "<available_skills>\n  <skill>\n    <name>one</name>\n    <location>/skills/one/SKILL.md</location>\n  </skill>\n</available_skills>";
  await handlers.get("session_start")?.[0]({}, {
    getSystemPrompt: () => livePrompt,
    sessionManager: { getBranch: () => [] },
  });
  pi.events.emit(RUNTIME_BRIDGE_COMMAND_EVENT, {
    version: 1, requestId: "disable", method: "set-skill-enabled",
    filePath: "/skills/one/SKILL.md", enabled: false,
  });
  // 提示词随后又被重建（技能块还在里面）。
  livePrompt = `新的前言\n${livePrompt}`;
  pi.events.emit(RUNTIME_BRIDGE_COMMAND_EVENT, { version: 1, requestId: "recheck", method: "get" });
  const state = emitted.find((event) => event.channel === `${RUNTIME_BRIDGE_REPLY_PREFIX}recheck`)?.value.state;
  assert.match(state.effectiveSystemPrompt, /新的前言/);
  assert.doesNotMatch(state.effectiveSystemPrompt, /<name>one<\/name>/);
});
