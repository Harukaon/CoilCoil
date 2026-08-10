import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, SubagentActivity, ToolRun } from "@suocode/runtime-protocol";
import { buildConversationTimeline } from "../src/renderer/src/features/conversation/buildConversationTimeline.ts";

const messages: ChatMessage[] = [
  {
    id: "user-1",
    order: 1,
    role: "user",
    text: "请调用子 Agent 调研。",
    timestamp: 1,
  },
  {
    id: "assistant-1",
    order: 2,
    role: "assistant",
    text: "好的，我来安排。",
    timestamp: 2,
  },
  {
    id: "assistant-2",
    order: 4,
    role: "assistant",
    text: "调研已经完成。",
    timestamp: 4,
  },
];

const tools: ToolRun[] = [{
  id: "subagent-call-1",
  order: 3,
  name: "subagent",
  label: "委派调研任务",
  args: {},
  output: "",
  status: "running",
  startedAt: 3,
}];

const activity: SubagentActivity = {
  id: "run-1",
  runId: "run-1",
  parentToolId: "subagent-call-1",
  index: 0,
  agent: "explore",
  task: "调研子 Agent GUI",
  status: "running",
  background: true,
  toolCount: 1,
  tokens: 42,
  durationMs: 500,
  updatedAt: 3,
};

test("subagent card occupies the original tool position between parent replies", () => {
  const timeline = buildConversationTimeline(messages, tools, [activity]);
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0]?.kind, "user");
  const agentTurn = timeline[1];
  assert.equal(agentTurn?.kind, "agent");
  if (agentTurn?.kind !== "agent") return;
  assert.deepEqual(agentTurn.items.map((item) => item.kind), ["message", "subagent", "message"]);
  const projected = agentTurn.items[1];
  assert.equal(projected?.kind, "subagent");
  if (projected?.kind === "subagent") assert.equal(projected.activity.runId, "run-1");
});

test("ordinary tools remain grouped when no subagent activity owns the tool call", () => {
  const timeline = buildConversationTimeline(messages, tools, []);
  const agentTurn = timeline[1];
  assert.equal(agentTurn?.kind, "agent");
  if (agentTurn?.kind !== "agent") return;
  assert.deepEqual(agentTurn.items.map((item) => item.kind), ["message", "tools", "message"]);
});
