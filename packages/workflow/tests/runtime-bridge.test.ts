import assert from "node:assert/strict";
import test from "node:test";
import runtimeBridgeExtension, {
  RUNTIME_BRIDGE_COMMAND_EVENT,
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
});
