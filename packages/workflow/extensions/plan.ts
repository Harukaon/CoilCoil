import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  SUBAGENT_ACTIVITY_CHANNEL,
  SUBAGENT_RPC_REQUEST_CHANNEL,
  subagentRpcReplyChannel,
  type SubagentActivityPayload,
  type SubagentRpcRequest,
  type SubagentToolDetails,
} from "./subagents/types.ts";

/** Public event channels consumed by SuoCode's bundled runtime. */
export const PLAN_STATE_CHANNEL = "suocode:plan:state:v1";
export const PLAN_RPC_REQUEST_CHANNEL = "suocode:plan:rpc:v1:request";
export const PLAN_RPC_REPLY_PREFIX = "suocode:plan:rpc:v1:reply:";
export const PLAN_ENTRY_TYPE = "suocode-plan";

type PlanStepStatus = "pending" | "in_progress" | "completed";
type PlanStatus = "pending_approval" | "running" | "delegated" | "completed" | "rejected" | "failed";
type ExecutionTarget = "main" | "subagent";

export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus;
}

export interface PlanState {
  id: string;
  title: string;
  objective: string;
  steps: PlanStep[];
  acceptanceCriteria: string[];
  notes?: string;
  filePath: string;
  revision: number;
  status: PlanStatus;
  createdAt: number;
  updatedAt: number;
  executionTarget?: ExecutionTarget;
  agentProfile?: string;
  subagentRunId?: string;
  report?: string;
  error?: string;
}

interface PlanInput {
  title: string;
  objective: string;
  steps: Array<{ text: string }>;
  acceptanceCriteria: string[];
  notes?: string;
}

interface PlanRpcRequest {
  version: 1;
  requestId: string;
  method: "approve" | "reject";
  params: { planId: string; target?: ExecutionTarget; agent?: string };
}

interface PlanDetails {
  plan: PlanState;
  filePath: string;
}

const PlanParams = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 160, description: "计划标题" }),
  objective: Type.String({ minLength: 1, maxLength: 4_000, description: "要达成的目标" }),
  steps: Type.Array(
    Type.Object({ text: Type.String({ minLength: 1, maxLength: 240, description: "执行步骤" }) }),
    { minItems: 1, maxItems: 40, description: "按顺序排列的执行步骤" },
  ),
  acceptanceCriteria: Type.Array(
    Type.String({ minLength: 1, maxLength: 240, description: "验收标准" }),
    { minItems: 1, maxItems: 20, description: "用于判断计划是否完成的明确验收标准" },
  ),
  notes: Type.Optional(Type.String({ maxLength: 4_000, description: "补充说明" })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function cleanMultiline(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxChars);
}

function isPlanStatus(value: unknown): value is PlanStatus {
  return value === "pending_approval" || value === "running" || value === "delegated"
    || value === "completed" || value === "rejected" || value === "failed";
}

function isStepStatus(value: unknown): value is PlanStepStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

/** Parse only the durable, intentionally small plan shape from an extension entry/file. */
export function parsePlanState(value: unknown): PlanState | undefined {
  if (!isRecord(value)) return undefined;
  const id = cleanText(value.id, 120);
  const title = cleanText(value.title, 160);
  const objective = cleanMultiline(value.objective, 4_000);
  const filePath = cleanText(value.filePath, 4_000);
  if (!id || !title || !objective || !filePath || !isPlanStatus(value.status)) return undefined;
  if (!Array.isArray(value.steps) || value.steps.length > 40) return undefined;
  const steps: PlanStep[] = [];
  for (let index = 0; index < value.steps.length; index += 1) {
    const raw = value.steps[index];
    if (!isRecord(raw)) return undefined;
    const text = cleanText(raw.text, 240);
    const stepId = cleanText(raw.id, 120) || `${id}-${index + 1}`;
    if (!text || !isStepStatus(raw.status)) return undefined;
    steps.push({ id: stepId, text, status: raw.status });
  }
  const acceptanceCriteria = Array.isArray(value.acceptanceCriteria)
    ? value.acceptanceCriteria.map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 20)
    : [];
  const number = (key: string, fallback: number): number => (
    typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : fallback
  );
  const target = value.executionTarget === "main" || value.executionTarget === "subagent"
    ? value.executionTarget : undefined;
  return {
    id,
    title,
    objective,
    steps,
    acceptanceCriteria,
    notes: cleanMultiline(value.notes, 4_000) || undefined,
    filePath,
    revision: Math.max(1, Math.floor(number("revision", 1))),
    status: value.status,
    createdAt: number("createdAt", Date.now()),
    updatedAt: number("updatedAt", Date.now()),
    executionTarget: target,
    agentProfile: cleanText(value.agentProfile, 120) || undefined,
    subagentRunId: cleanText(value.subagentRunId, 160) || undefined,
    report: cleanMultiline(value.report, 48_000) || undefined,
    error: cleanMultiline(value.error, 8_000) || undefined,
  };
}

function normaliseInput(input: PlanInput): Pick<PlanState, "title" | "objective" | "steps" | "acceptanceCriteria" | "notes"> {
  const title = cleanText(input.title, 160);
  const objective = cleanMultiline(input.objective, 4_000);
  const steps = input.steps
    .map((step, index) => ({ id: `step-${index + 1}`, text: cleanText(step.text, 240), status: "pending" as const }))
    .filter((step) => step.text);
  if (!title) throw new Error("计划标题不能为空。");
  if (!objective) throw new Error("计划目标不能为空。");
  if (!steps.length) throw new Error("计划至少需要一个执行步骤。");
  const acceptanceCriteria = input.acceptanceCriteria
    .map((item) => cleanText(item, 240))
    .filter(Boolean)
    .slice(0, 20);
  if (!acceptanceCriteria.length) throw new Error("计划至少需要一条验收标准。");
  return {
    title,
    objective,
    steps,
    acceptanceCriteria,
    notes: cleanMultiline(input.notes, 4_000) || undefined,
  };
}

function escapeHeading(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/^#+/, "").trim();
}

export function serializePlanFile(plan: PlanState): string {
  const metadata = JSON.stringify(plan);
  const lines = [
    "<!-- suocode-plan:v1",
    metadata,
    "-->",
    `# ${escapeHeading(plan.title)}`,
    "",
    "## 目标",
    plan.objective,
    "",
    "## 执行步骤",
    ...plan.steps.map((step) => `${step.status === "completed" ? "- [x]" : step.status === "in_progress" ? "- [~]" : "- [ ]"} ${step.text}`),
    "",
    "## 验收标准",
    ...(plan.acceptanceCriteria.length ? plan.acceptanceCriteria.map((item) => `- ${item}`) : ["- （待补充）"]),
  ];
  if (plan.notes) lines.push("", "## 备注", plan.notes);
  lines.push("");
  return lines.join("\n");
}

function markdownSection(text: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"));
  return match?.[1]?.trim();
}

function parseVisiblePlan(text: string, base: PlanState): PlanState {
  const heading = text.match(/(?:^|\n)#\s+([^\n]+)/)?.[1];
  const objective = markdownSection(text, "目标");
  const stepSection = markdownSection(text, "执行步骤");
  const criteriaSection = markdownSection(text, "验收标准");
  const notes = markdownSection(text, "备注");

  const parsedSteps: PlanStep[] = [];
  if (stepSection) {
    const lines = stepSection.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*-\s*\[([ xX~])\]\s+(.+?)\s*$/);
      if (!match) continue;
      const stepText = cleanText(match[2], 240);
      if (!stepText) continue;
      const marker = match[1].toLowerCase();
      parsedSteps.push({
        id: base.steps[parsedSteps.length]?.id ?? `step-${parsedSteps.length + 1}`,
        text: stepText,
        status: marker === "x" ? "completed" : marker === "~" ? "in_progress" : "pending",
      });
    }
  }

  const parsedCriteria = criteriaSection
    ?.split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] ?? "")
    .map((line) => cleanText(line, 240))
    .filter((line) => line && line !== "（待补充）")
    .slice(0, 20);

  return {
    ...base,
    title: cleanText(heading, 160) || base.title,
    objective: cleanMultiline(objective, 4_000) || base.objective,
    steps: parsedSteps.length ? parsedSteps : base.steps,
    acceptanceCriteria: parsedCriteria?.length ? parsedCriteria : base.acceptanceCriteria,
    notes: notes === undefined ? base.notes : cleanMultiline(notes, 4_000) || undefined,
  };
}

/**
 * Parse the durable metadata and then project the human-editable Markdown body
 * over it. A fallback lets native write/edit replace the whole document while
 * preserving the session-owned identity and approval state.
 */
export function parsePlanFile(text: string, fallback?: PlanState): PlanState | undefined {
  const match = text.match(/<!--\s*suocode-plan:v1\s*([\s\S]*?)\s*-->/i);
  let metadata: PlanState | undefined;
  if (match) {
    try {
      metadata = parsePlanState(JSON.parse(match[1]));
    } catch {
      metadata = undefined;
    }
  }
  const base = metadata ?? fallback;
  return base ? parseVisiblePlan(text, base) : undefined;
}

function planDetails(value: unknown): PlanDetails | undefined {
  if (!isRecord(value)) return undefined;
  const plan = parsePlanState(value.plan ?? value);
  if (!plan) return undefined;
  return { plan, filePath: plan.filePath };
}

function assistantReport(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.map((part: unknown) => {
    if (!isRecord(part)) return "";
    return typeof part.text === "string" ? part.text : "";
  }).join("").trim();
  return text || undefined;
}

function assistantFailure(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "length") {
    return undefined;
  }
  if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
    return message.errorMessage.trim();
  }
  if (message.stopReason === "aborted") return "主 Agent 执行已中止。";
  if (message.stopReason === "length") return "主 Agent 达到单次输出长度限制，计划尚未确认完成。";
  return "主 Agent 执行失败。";
}

function latestPlanFromBranch(ctx: ExtensionContext): PlanState | undefined {
  for (let index = ctx.sessionManager.getBranch().length - 1; index >= 0; index -= 1) {
    const entry = ctx.sessionManager.getBranch()[index];
    if (entry.type === "custom" && entry.customType === PLAN_ENTRY_TYPE) {
      const parsed = parsePlanState(entry.data);
      if (parsed) return parsed;
    }
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "plan") {
      const parsed = planDetails(entry.message.details);
      if (parsed) return parsed.plan;
    }
  }
  return undefined;
}

function stateWith(plan: PlanState, patch: Partial<PlanState>): PlanState {
  return { ...plan, ...patch, revision: plan.revision + 1, updatedAt: Date.now() };
}

function executionPrompt(plan: PlanState, delegated: boolean): string {
  return [
    delegated ? "你正在执行一个由主 Agent 审批后派发的计划。" : "用户已批准执行下面的计划。",
    "请先读取计划文件，再严格按步骤推进；必要时使用原生 read/write/edit 工具更新计划文件中的复选框和步骤状态。",
    "不要重新设计计划，也不要只给出建议；完成后汇报实际改动、验证结果和未完成项。",
    `计划文件：${plan.filePath}`,
    `计划 ID：${plan.id}`,
    "",
    `标题：${plan.title}`,
    `目标：${plan.objective}`,
    "步骤：",
    ...plan.steps.map((step, index) => `${index + 1}. ${step.text}`),
    ...(plan.acceptanceCriteria.length ? ["验收标准：", ...plan.acceptanceCriteria.map((item) => `- ${item}`)] : []),
  ].join("\n");
}

function replyChannel(requestId: string): string {
  return `${PLAN_RPC_REPLY_PREFIX}${requestId}`;
}

function isPlanRpc(value: unknown): value is PlanRpcRequest {
  return isRecord(value)
    && value.version === 1
    && typeof value.requestId === "string"
    && (value.method === "approve" || value.method === "reject")
    && isRecord(value.params)
    && typeof value.params.planId === "string";
}

export default function planExtension(pi: ExtensionAPI): void {
  let currentPlan: PlanState | undefined;
  let currentContext: ExtensionContext | undefined;
  let unsubscribeSubagents: (() => void) | undefined;
  let unsubscribePlanRpc: (() => void) | undefined;
  let pendingTerminalSubagent: SubagentActivityPayload | undefined;

  const publish = (plan: PlanState): void => {
    currentPlan = plan;
    pi.appendEntry(PLAN_ENTRY_TYPE, plan);
    pi.events.emit(PLAN_STATE_CHANNEL, plan);
  };

  const persistFile = async (plan: PlanState): Promise<void> => {
    await mkdir(dirname(plan.filePath), { recursive: true, mode: 0o700 });
    await writeFile(plan.filePath, serializePlanFile(plan), { encoding: "utf8", mode: 0o600 });
  };

  const persist = async (plan: PlanState): Promise<void> => {
    await persistFile(plan);
    publish(plan);
  };

  const restore = async (ctx: ExtensionContext): Promise<void> => {
    currentContext = ctx;
    const fromBranch = latestPlanFromBranch(ctx);
    if (!fromBranch) {
      currentPlan = undefined;
      pi.events.emit(PLAN_STATE_CHANNEL, null);
      return;
    }
    try {
      const disk = parsePlanFile(await readFile(fromBranch.filePath, "utf8"), fromBranch);
      currentPlan = disk && disk.id === fromBranch.id
        ? { ...fromBranch, ...disk, status: fromBranch.status, executionTarget: fromBranch.executionTarget, agentProfile: fromBranch.agentProfile, subagentRunId: fromBranch.subagentRunId, report: fromBranch.report, error: fromBranch.error }
        : fromBranch;
    } catch {
      currentPlan = fromBranch;
    }
    if (currentPlan) pi.events.emit(PLAN_STATE_CHANNEL, currentPlan);
  };

  pi.on("session_start", async (_event, ctx) => {
    await restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.on("agent_settled", async () => {
    if (!currentPlan || currentPlan.status !== "running" || currentPlan.executionTarget !== "main") return;
    const branch = currentContext?.sessionManager.getBranch() ?? [];
    const lastAssistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
    const message = lastAssistant && lastAssistant.type === "message" ? lastAssistant.message : undefined;
    const failure = assistantFailure(message);
    const report = assistantReport(message);
    await persist(stateWith(currentPlan, {
      status: failure ? "failed" : "completed",
      report: report || undefined,
      error: failure,
    })).catch(() => undefined);
  });

  pi.on("tool_result", async (event) => {
    if (!currentPlan || !currentContext || event.toolName === "plan") return;
    const inputPath = isRecord(event.input)
      ? typeof event.input.path === "string"
        ? event.input.path
        : typeof event.input.file_path === "string"
          ? event.input.file_path
          : undefined
      : undefined;
    if (!inputPath) return;
    const resolved = resolve(currentContext.cwd, inputPath);
    if (resolved !== resolve(currentPlan.filePath)) return;
    try {
      const disk = parsePlanFile(await readFile(currentPlan.filePath, "utf8"), currentPlan);
      if (!disk || disk.id !== currentPlan.id) return;
      const merged = { ...currentPlan, ...disk, status: currentPlan.status, executionTarget: currentPlan.executionTarget, agentProfile: currentPlan.agentProfile, subagentRunId: currentPlan.subagentRunId, report: currentPlan.report, error: currentPlan.error };
      if (JSON.stringify(merged) !== JSON.stringify(currentPlan)) {
        merged.revision = currentPlan.revision + 1;
        merged.updatedAt = Date.now();
        publish(merged);
      }
    } catch {
      // A partial write should not interrupt the Agent turn.
    }
  });

  const finishDelegatedPlan = async (activity: SubagentActivityPayload): Promise<void> => {
    if (!currentPlan || currentPlan.status !== "delegated" || activity.planId !== currentPlan.id) return;
    if (!currentPlan.subagentRunId) {
      pendingTerminalSubagent = activity;
      return;
    }
    if (activity.runId !== currentPlan.subagentRunId) return;
    pendingTerminalSubagent = undefined;
    const status: PlanStatus = activity.status === "completed" ? "completed" : "failed";
    await persist(stateWith(currentPlan, {
      status,
      report: activity.finalOutput,
      error: activity.error || (activity.status === "stopped" ? "子 Agent 已停止。" : undefined),
    }));
  };

  unsubscribeSubagents = pi.events.on(SUBAGENT_ACTIVITY_CHANNEL, (raw: unknown) => {
    if (!currentPlan || currentPlan.status !== "delegated" || !isRecord(raw) || !Array.isArray(raw.activities)) return;
    const activity = (raw.activities as unknown[]).map((item) => item as SubagentActivityPayload).find((item) => item.planId === currentPlan?.id);
    if (!activity || (activity.status !== "completed" && activity.status !== "failed" && activity.status !== "stopped")) return;
    void finishDelegatedPlan(activity).catch(() => undefined);
  });

  unsubscribePlanRpc = pi.events.on(PLAN_RPC_REQUEST_CHANNEL, async (raw: unknown) => {
    // Runtime-core uses this channel for approval requests.
    if (!isPlanRpc(raw)) return;
    const requestId = raw.requestId;
    const replyError = (message: string): void => pi.events.emit(replyChannel(requestId), { version: 1, requestId, success: false, error: { message } });
    try {
      if (!currentPlan || currentPlan.id !== raw.params.planId) return replyError("找不到要操作的计划。");
      if (raw.method === "reject") {
        if (currentPlan.status !== "pending_approval") return replyError("当前计划已经开始或结束，不能再拒绝。");
        const next = stateWith(currentPlan, { status: "rejected", error: undefined });
        await persist(next);
        pi.events.emit(replyChannel(requestId), { version: 1, requestId, success: true, data: { plan: next } });
        return;
      }
      if (currentPlan.status !== "pending_approval") return replyError("当前计划已经处理过了。");
      const target = raw.params.target ?? "main";
      if (target !== "main" && target !== "subagent") return replyError("执行目标无效。");
      let next = stateWith(currentPlan, {
        status: target === "main" ? "running" : "delegated",
        executionTarget: target,
        agentProfile: target === "subagent" ? cleanText(raw.params.agent, 120) || "explore" : undefined,
        error: undefined,
        report: undefined,
      });
      await persist(next);
      if (target === "main") {
        pi.sendUserMessage(executionPrompt(next, false), { deliverAs: "followUp" });
      } else {
        const requestIdForChild = randomUUID();
        const childReply = subagentRpcReplyChannel(requestIdForChild);
        const details = await new Promise<SubagentToolDetails>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const unsubscribe = pi.events.on(childReply, (reply: unknown) => {
            if (timer) clearTimeout(timer);
            unsubscribe();
            if (!isRecord(reply) || reply.success !== true) {
              reject(new Error(isRecord(reply) && isRecord(reply.error) && typeof reply.error.message === "string" ? reply.error.message : "子 Agent 派发失败。"));
              return;
            }
            const data = isRecord(reply.data) && isRecord(reply.data.details) ? reply.data.details : undefined;
            if (!data) reject(new Error("子 Agent 返回了无效的运行信息。"));
            else resolve(data as unknown as SubagentToolDetails);
          });
          timer = setTimeout(() => { unsubscribe(); reject(new Error("等待子 Agent 派发响应超时。")); }, 15_000);
          pi.events.emit(SUBAGENT_RPC_REQUEST_CHANNEL, {
            version: 1,
            requestId: requestIdForChild,
            method: "run",
            params: { agent: next.agentProfile, task: executionPrompt(next, true), background: true, planId: next.id },
            source: { client: "suocode-plan" },
          } satisfies SubagentRpcRequest);
        });
        next = stateWith(next, { subagentRunId: details.runId, status: "delegated" });
        await persist(next);
        if (pendingTerminalSubagent?.planId === next.id && pendingTerminalSubagent.runId === details.runId) {
          await finishDelegatedPlan(pendingTerminalSubagent);
          next = currentPlan ?? next;
        }
      }
      pi.events.emit(replyChannel(requestId), { version: 1, requestId, success: true, data: { plan: next } });
    } catch (error) {
      const next = currentPlan && currentPlan.id === raw.params.planId
        ? stateWith(currentPlan, { status: "failed", error: error instanceof Error ? error.message : String(error) })
        : undefined;
      if (next) await persist(next).catch(() => undefined);
      replyError(error instanceof Error ? error.message : String(error));
    }
  });

  pi.on("session_shutdown", async () => {
    unsubscribeSubagents?.();
    unsubscribePlanRpc?.();
    unsubscribeSubagents = undefined;
    unsubscribePlanRpc = undefined;
    pendingTerminalSubagent = undefined;
    currentPlan = undefined;
    currentContext = undefined;
  });

  pi.registerTool({
    name: "plan",
    label: "Plan",
    description: "为复杂任务创建一个写入磁盘的、等待用户审批的执行计划。计划文件可用原生 read/write/edit 工具查看和修改；用户批准后才执行。",
    promptSnippet: "plan: 创建需要用户审批的执行计划",
    promptGuidelines: [
      "当任务包含多个明确步骤、需要用户先确认方案时使用 plan；不要把普通的 Todo 进度更新当作 plan。",
      "计划必须包含可执行步骤和验收标准，创建后停止等待用户在界面中选择主 Agent 或指定子 Agent 执行。",
      "计划文件是持久化 Markdown，不要把计划只写在回复文本里。",
    ],
    parameters: PlanParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: PlanInput, _signal, _onUpdate, ctx) {
      if (currentPlan && (currentPlan.status === "pending_approval" || currentPlan.status === "running" || currentPlan.status === "delegated")) {
        throw new Error(`当前已有计划“${currentPlan.title}”处于${currentPlan.status === "pending_approval" ? "等待审批" : "执行中"}，请先完成、拒绝或修改该计划文件。`);
      }
      const normalized = normaliseInput(params);
      const now = Date.now();
      const id = `plan-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
      const filePath = join(ctx.sessionManager.getSessionDir(), "plans", ctx.sessionManager.getSessionId(), `${id}.md`);
      const plan: PlanState = {
        ...normalized,
        id,
        filePath,
        revision: 1,
        status: "pending_approval",
        createdAt: now,
        updatedAt: now,
      };
      await persist(plan);
      return {
        content: [{ type: "text", text: `计划已保存，等待用户审批。\n文件：${filePath}\n\n${plan.title}\n${plan.steps.map((step, index) => `${index + 1}. ${step.text}`).join("\n")}` }],
        details: { plan, filePath } satisfies PlanDetails,
      };
    },
    renderCall(args, theme: Theme) {
      return new Text(theme.fg("toolTitle", theme.bold("plan")) + theme.fg("muted", ` · ${args.steps.length} 步`), 0, 0);
    },
    renderResult(result, _options, theme: Theme) {
      const details = planDetails(result.details);
      if (!details) return new Text(theme.fg("error", "计划状态无效"), 0, 0);
      return new Text(theme.fg("accent", `${details.plan.title} · 等待审批`) + `\n${details.filePath}`, 0, 0);
    },
  });
}
