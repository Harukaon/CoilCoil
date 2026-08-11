import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import planExtension, {
  PLAN_ENTRY_TYPE,
  PLAN_RPC_REPLY_PREFIX,
  PLAN_RPC_REQUEST_CHANNEL,
  PLAN_STATE_CHANNEL,
  parsePlanFile,
  serializePlanFile,
  type PlanState,
} from "../extensions/plan.ts";
import {
  SUBAGENT_ACTIVITY_CHANNEL,
  SUBAGENT_RPC_REQUEST_CHANNEL,
  subagentRpcReplyChannel,
} from "../extensions/subagents/types.ts";

interface Emission {
  channel: string;
  value: unknown;
}

function createHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const listeners = new Map<string, Set<(value: unknown) => unknown>>();
  const emissions: Emission[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  const tools: Array<Record<string, any>> = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: Record<string, any>) {
      tools.push(tool);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendUserMessage(content: unknown, options: unknown) {
      sentUserMessages.push({ content, options });
    },
    events: {
      on(channel: string, listener: (value: unknown) => unknown) {
        const values = listeners.get(channel) ?? new Set();
        values.add(listener);
        listeners.set(channel, values);
        return () => values.delete(listener);
      },
      emit(channel: string, value: unknown) {
        emissions.push({ channel, value });
        for (const listener of listeners.get(channel) ?? []) void listener(value);
      },
    },
  };
  planExtension(pi as never);
  const tool = tools.find((candidate) => candidate.name === "plan");
  assert.ok(tool, "plan tool must be registered");
  return {
    handlers,
    emissions,
    entries,
    sentUserMessages,
    parameters: tool.parameters as { properties?: Record<string, unknown>; required?: string[] },
    execute: tool.execute as (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: unknown,
    ) => Promise<{ details: { plan: PlanState; filePath: string } }>,
    emit: pi.events.emit,
    onBus: pi.events.on,
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for plan event");
}

async function createPlanFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "suocode-plan-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const branch: any[] = [];
  const context = {
    cwd: root,
    sessionManager: {
      getSessionDir: () => join(root, "sessions"),
      getSessionId: () => "parent-session",
      getBranch: () => branch,
    },
  };
  const harness = createHarness();
  await harness.handlers.get("session_start")?.[0]({}, context);
  const result = await harness.execute("tool-plan", {
    markdown: [
      "# 实现计划审批",
      "",
      "让用户审批后再执行。",
      "",
      "- [ ] 写入计划文件",
      "- [ ] 等待用户审批",
      "- [ ] 执行并验证",
      "",
      "| 验证项 | 预期 |",
      "| --- | --- |",
      "| 恢复 | 计划可以恢复 |",
      "| 回传 | 执行结果可以回传 |",
    ].join("\n"),
  }, undefined, undefined, context);
  return { root, branch, context, harness, plan: result.details.plan };
}

test("plan exposes exactly one model-facing Markdown parameter", () => {
  const harness = createHarness();
  assert.deepEqual(Object.keys(harness.parameters.properties ?? {}), ["markdown"]);
  assert.deepEqual(harness.parameters.required, ["markdown"]);
});

test("plan Markdown round-trips without imposing a document schema", async (t) => {
  const { plan } = await createPlanFixture(t);
  const raw = serializePlanFile(plan);
  assert.equal(raw, plan.markdown, "the persisted file must be the Markdown document itself");
  assert.doesNotMatch(raw, /suocode-plan:v1/);
  const serialized = raw
    .replace("- [ ] 写入计划文件", "- [x] 持久化计划文件")
    .replace("- [ ] 等待用户审批", "> 等待界面审批");
  const recovered = parsePlanFile(serialized, plan);
  assert.equal(recovered?.id, plan.id);
  assert.match(recovered?.markdown ?? "", /- \[x\] 持久化计划文件/);
  assert.match(recovered?.markdown ?? "", /> 等待界面审批/);
  assert.match(recovered?.markdown ?? "", /\| 验证项 \| 预期 \|/);
});

test("plan tool persists a private session file and syncs native edits", async (t) => {
  const { context, harness, plan } = await createPlanFixture(t);
  assert.match(plan.filePath, /sessions[/\\]plans[/\\]parent-session[/\\]plan-.+\.md$/);
  const source = await readFile(plan.filePath, "utf8");
  assert.match(source, /# 实现计划审批/);
  assert.equal(source, plan.markdown);
  assert.ok(harness.entries.some((entry) => entry.customType === PLAN_ENTRY_TYPE));
  assert.ok(harness.emissions.some((entry) => entry.channel === PLAN_STATE_CHANNEL));

  await writeFile(plan.filePath, source.replace("- [ ] 写入计划文件", "- [x] 已写入计划文件"), "utf8");
  await harness.handlers.get("tool_result")?.[0]({
    toolName: "edit",
    input: { path: plan.filePath },
  }, context);
  const updated = harness.emissions
    .filter((entry) => entry.channel === PLAN_STATE_CHANNEL)
    .at(-1)?.value as PlanState;
  assert.match(updated.markdown, /- \[x\] 已写入计划文件/);
  assert.ok(updated.revision > plan.revision);
});

test("an active plan must be resolved or edited instead of being silently replaced", async (t) => {
  const { context, harness } = await createPlanFixture(t);
  await assert.rejects(
    harness.execute("tool-plan-2", {
      markdown: "# 第二份计划\n\n不应覆盖仍待审批的计划。",
    }, undefined, undefined, context),
    /当前已有计划/,
  );
});

test("moving the session tree before the plan clears the projected approval card", async (t) => {
  const { context, harness } = await createPlanFixture(t);
  await harness.handlers.get("session_tree")?.[0]({}, context);
  assert.equal(harness.emissions.filter((entry) => entry.channel === PLAN_STATE_CHANNEL).at(-1)?.value, null);
});

test("approving for the main Agent starts execution and records its final report", async (t) => {
  const { branch, context, harness, plan } = await createPlanFixture(t);
  const reply = `${PLAN_RPC_REPLY_PREFIX}approve-main`;
  harness.emit(PLAN_RPC_REQUEST_CHANNEL, {
    version: 1,
    requestId: "approve-main",
    method: "approve",
    params: { planId: plan.id, target: "main" },
  });
  const approved = await waitFor(() => harness.emissions.find((entry) => entry.channel === reply));
  assert.equal((approved.value as any).success, true);
  assert.equal((approved.value as any).data.plan.status, "running");
  assert.equal(harness.sentUserMessages.length, 1);
  assert.match(String(harness.sentUserMessages[0].content), new RegExp(plan.id));
  assert.match(String(harness.sentUserMessages[0].content), /请先使用原生 read 工具读取计划文件/);

  branch.push({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "计划执行完成，验证通过。" }] },
  });
  await harness.handlers.get("agent_settled")?.[0]({}, context);
  const completed = harness.emissions
    .filter((entry) => entry.channel === PLAN_STATE_CHANNEL)
    .at(-1)?.value as PlanState;
  assert.equal(completed.status, "completed");
  assert.equal(completed.report, "计划执行完成，验证通过。");
});

test("a failed main Agent run does not mark the plan completed", async (t) => {
  const { branch, context, harness, plan } = await createPlanFixture(t);
  harness.emit(PLAN_RPC_REQUEST_CHANNEL, {
    version: 1,
    requestId: "approve-failing-main",
    method: "approve",
    params: { planId: plan.id, target: "main" },
  });
  await waitFor(() => harness.emissions.find((entry) => entry.channel === `${PLAN_RPC_REPLY_PREFIX}approve-failing-main`));
  branch.push({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "执行到一半时连接失败。" }],
      stopReason: "error",
      errorMessage: "上游连接失败",
    },
  });
  await harness.handlers.get("agent_settled")?.[0]({}, context);
  const failed = harness.emissions
    .filter((entry) => entry.channel === PLAN_STATE_CHANNEL)
    .at(-1)?.value as PlanState;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "上游连接失败");
  assert.equal(failed.report, "执行到一半时连接失败。");
});

test("approving for a selected child Agent dispatches it and records the returned report", async (t) => {
  const { harness, plan } = await createPlanFixture(t);
  let childRequest: any;
  harness.onBus(SUBAGENT_RPC_REQUEST_CHANNEL, (raw) => {
    childRequest = raw;
    harness.emit(subagentRpcReplyChannel(raw.requestId), {
      version: 1,
      requestId: raw.requestId,
      success: true,
      data: {
        details: {
          runId: "sa-plan-worker",
          agent: "worker",
          task: raw.params.task,
          status: "running",
          background: true,
          planId: plan.id,
        },
      },
    });
  });

  const reply = `${PLAN_RPC_REPLY_PREFIX}approve-child`;
  harness.emit(PLAN_RPC_REQUEST_CHANNEL, {
    version: 1,
    requestId: "approve-child",
    method: "approve",
    params: { planId: plan.id, target: "subagent", agent: "worker" },
  });
  const approved = await waitFor(() => harness.emissions.find((entry) => entry.channel === reply));
  assert.equal((approved.value as any).success, true);
  assert.equal((approved.value as any).data.plan.status, "delegated");
  assert.equal((approved.value as any).data.plan.subagentRunId, "sa-plan-worker");
  assert.equal(childRequest.params.agent, "worker");
  assert.equal(childRequest.params.planId, plan.id);
  assert.equal(childRequest.params.worktree, undefined, "the chosen profile must retain its own worktree policy");

  harness.emit(SUBAGENT_ACTIVITY_CHANNEL, {
    version: 1,
    activities: [{
      id: "sa-plan-worker",
      runId: "sa-plan-worker",
      agent: "worker",
      status: "completed",
      background: true,
      planId: plan.id,
      toolCount: 3,
      tokens: 100,
      durationMs: 1_000,
      updatedAt: Date.now(),
      finalOutput: "子 Agent 已完成全部步骤并通过测试。",
    }],
  });
  const completed = await waitFor(() => {
    const latest = harness.emissions.filter((entry) => entry.channel === PLAN_STATE_CHANNEL).at(-1)?.value as PlanState | undefined;
    return latest?.status === "completed" ? latest : undefined;
  });
  assert.equal(completed.report, "子 Agent 已完成全部步骤并通过测试。");
});

test("a child that finishes before the dispatch reply cannot revert the plan to delegated", async (t) => {
  const { harness, plan } = await createPlanFixture(t);
  harness.onBus(SUBAGENT_RPC_REQUEST_CHANNEL, (raw) => {
    harness.emit(SUBAGENT_ACTIVITY_CHANNEL, {
      version: 1,
      activities: [{
        id: "sa-fast-worker",
        runId: "sa-fast-worker",
        agent: "worker",
        status: "completed",
        background: true,
        planId: plan.id,
        toolCount: 0,
        tokens: 8,
        durationMs: 1,
        updatedAt: Date.now(),
        finalOutput: "快速任务已经完成。",
      }],
    });
    harness.emit(subagentRpcReplyChannel(raw.requestId), {
      version: 1,
      requestId: raw.requestId,
      success: true,
      data: {
        details: {
          runId: "sa-fast-worker",
          agent: "worker",
          task: raw.params.task,
          status: "running",
          background: true,
          planId: plan.id,
        },
      },
    });
  });

  const reply = `${PLAN_RPC_REPLY_PREFIX}approve-fast-child`;
  harness.emit(PLAN_RPC_REQUEST_CHANNEL, {
    version: 1,
    requestId: "approve-fast-child",
    method: "approve",
    params: { planId: plan.id, target: "subagent", agent: "worker" },
  });
  const approved = await waitFor(() => harness.emissions.find((entry) => entry.channel === reply));
  assert.equal((approved.value as any).data.plan.status, "completed");
  assert.equal((approved.value as any).data.plan.report, "快速任务已经完成。");
  const latest = harness.emissions.filter((entry) => entry.channel === PLAN_STATE_CHANNEL).at(-1)?.value as PlanState;
  assert.equal(latest.status, "completed");
});

test("rejecting a pending plan persists the decision without starting an Agent", async (t) => {
  const { harness, plan } = await createPlanFixture(t);
  const reply = `${PLAN_RPC_REPLY_PREFIX}reject-plan`;
  harness.emit(PLAN_RPC_REQUEST_CHANNEL, {
    version: 1,
    requestId: "reject-plan",
    method: "reject",
    params: { planId: plan.id },
  });
  const rejected = await waitFor(() => harness.emissions.find((entry) => entry.channel === reply));
  assert.equal((rejected.value as any).success, true);
  assert.equal((rejected.value as any).data.plan.status, "rejected");
  assert.equal(harness.sentUserMessages.length, 0);
});
