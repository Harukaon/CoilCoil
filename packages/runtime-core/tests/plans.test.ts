import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type AgentSession,
  createEventBus,
  type EventBusController,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  PlanApprovalState,
  ProjectSnapshot,
  RuntimeEvent,
} from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";

const PLAN_RPC_REQUEST_CHANNEL = "coilcoil:plan:rpc:v1:request";
const PLAN_RPC_REPLY_PREFIX = "coilcoil:plan:rpc:v1:reply:";

interface RuntimeInternals {
  reconstructState(session: AgentSession): { planApproval?: PlanApprovalState };
  active?: {
    eventBus: EventBusController;
    project: ProjectSnapshot;
    planApproval?: PlanApprovalState;
  };
}

function plan(overrides: Partial<PlanApprovalState> = {}): PlanApprovalState {
  return {
    id: "plan-test",
    title: "实现计划审批",
    markdown: "# 实现计划审批\n\n审批后执行。\n\n- [ ] 完成实现\n",
    filePath: "/tmp/sessions/plans/session/plan-test.md",
    revision: 1,
    status: "pending_approval",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function project(planApproval?: PlanApprovalState): ProjectSnapshot {
  return {
    cwd: "/tmp/project",
    files: [],
    changes: [],
    terminals: [],
    plan: [],
    planApproval,
    refreshedAt: 1,
  };
}

test("runtime restores the latest durable plan state from the active branch", (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-runtime-plan-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.inMemory(root);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "plan-call", name: "plan", arguments: {} }],
    timestamp: Date.now(),
  } as never);
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "plan-call",
    toolName: "plan",
    content: [{ type: "text", text: "等待审批" }],
    details: { plan: plan() },
    isError: false,
    timestamp: Date.now(),
  } as never);
  manager.appendCustomEntry("coilcoil-plan", plan({
    revision: 2,
    status: "delegated",
    executionTarget: "subagent",
    agentProfile: "worker",
    subagentRunId: "sa-plan-test",
    updatedAt: 2,
  }));

  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    checkpoints: false,
  });
  const restored = (runtime as unknown as RuntimeInternals).reconstructState({ sessionManager: manager } as AgentSession);
  assert.equal(restored.planApproval?.status, "delegated");
  assert.equal(restored.planApproval?.agentProfile, "worker");
  assert.equal(restored.planApproval?.subagentRunId, "sa-plan-test");
});

test("runtime approval bridge forwards the selected execution target and updates project state", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-runtime-plan-rpc-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const events: RuntimeEvent[] = [];
  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    checkpoints: false,
    onEvent: (event) => events.push(event),
  });
  const eventBus = createEventBus();
  const initial = plan();
  (runtime as unknown as RuntimeInternals).active = {
    eventBus,
    project: project(initial),
    planApproval: initial,
  };

  eventBus.on(PLAN_RPC_REQUEST_CHANNEL, (raw) => {
    const request = raw as {
      requestId: string;
      method: string;
      params: { planId: string; target: string; agent?: string };
    };
    assert.equal(request.method, "approve");
    assert.deepEqual(request.params, { planId: initial.id, target: "subagent", agent: "worker" });
    eventBus.emit(`${PLAN_RPC_REPLY_PREFIX}${request.requestId}`, {
      success: true,
      data: {
        plan: plan({
          revision: 2,
          status: "delegated",
          executionTarget: "subagent",
          agentProfile: "worker",
          subagentRunId: "sa-plan-test",
          updatedAt: 2,
        }),
      },
    });
  });

  const approved = await runtime.approvePlan(initial.id, "subagent", "worker");
  assert.equal(approved.status, "delegated");
  assert.equal((runtime as unknown as RuntimeInternals).active?.project.planApproval?.subagentRunId, "sa-plan-test");
  assert.ok(events.some((event) => event.type === "plan_approval_updated" && event.plan?.status === "delegated"));
  assert.ok(events.some((event) => event.type === "project_updated" && event.project.planApproval?.status === "delegated"));
});
