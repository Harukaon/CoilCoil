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

/** Public event channels consumed by CoilCoil's bundled runtime. */
export const PLAN_STATE_CHANNEL = "coilcoil:plan:state:v1";
export const PLAN_RPC_REQUEST_CHANNEL = "coilcoil:plan:rpc:v1:request";
export const PLAN_RPC_REPLY_PREFIX = "coilcoil:plan:rpc:v1:reply:";
export const PLAN_ENTRY_TYPE = "coilcoil-plan";

type PlanStatus = "pending_approval" | "running" | "delegated" | "completed" | "rejected" | "failed";
type ExecutionTarget = "main" | "subagent";

export interface PlanState {
  id: string;
  title: string;
  markdown: string;
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
  markdown: string;
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
  markdown: Type.String({ minLength: 1, description: "完整的 Markdown 计划文档正文" }),
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

function cleanMarkdown(value: unknown): string {
  if (typeof value !== "string") return "";
  const markdown = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (!markdown.trim()) return "";
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

function titleFromMarkdown(markdown: string): string {
  const heading = markdown.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (heading) return cleanText(heading.replace(/\s+#+\s*$/, ""), 160) || "执行计划";
  const firstLine = markdown.split("\n").find((line) => line.trim());
  return cleanText(firstLine?.replace(/^#+\s*/, ""), 160) || "执行计划";
}

function isPlanStatus(value: unknown): value is PlanStatus {
  return value === "pending_approval" || value === "running" || value === "delegated"
    || value === "completed" || value === "rejected" || value === "failed";
}

function legacyMarkdown(value: Record<string, unknown>): string {
  const title = cleanText(value.title, 160);
  const objective = cleanMultiline(value.objective, 4_000);
  if (!title || !objective) return "";
  const steps = Array.isArray(value.steps)
    ? value.steps.flatMap((raw) => {
      if (!isRecord(raw)) return [];
      const text = cleanText(raw.text, 240);
      if (!text) return [];
      return [`- [${raw.status === "completed" ? "x" : raw.status === "in_progress" ? " " : " "}] ${text}`];
    })
    : [];
  const criteria = Array.isArray(value.acceptanceCriteria)
    ? value.acceptanceCriteria.map((item) => cleanText(item, 240)).filter(Boolean)
    : [];
  const notes = cleanMultiline(value.notes, 4_000);
  return cleanMarkdown([
    `# ${title}`,
    "",
    "## 目标",
    objective,
    ...(steps.length ? ["", "## 执行步骤", ...steps] : []),
    ...(criteria.length ? ["", "## 验收标准", ...criteria.map((item) => `- ${item}`)] : []),
    ...(notes ? ["", "## 备注", notes] : []),
  ].join("\n"));
}

/** Parse the session-owned plan metadata while keeping its document as Markdown. */
export function parsePlanState(value: unknown): PlanState | undefined {
  if (!isRecord(value)) return undefined;
  const id = cleanText(value.id, 120);
  const markdown = cleanMarkdown(value.markdown) || legacyMarkdown(value);
  const filePath = cleanText(value.filePath, 4_000);
  if (!id || !markdown || !filePath || !isPlanStatus(value.status)) return undefined;
  const number = (key: string, fallback: number): number => (
    typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : fallback
  );
  const target = value.executionTarget === "main" || value.executionTarget === "subagent"
    ? value.executionTarget : undefined;
  return {
    id,
    title: titleFromMarkdown(markdown),
    markdown,
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

function normaliseInput(input: PlanInput): Pick<PlanState, "title" | "markdown"> {
  const markdown = cleanMarkdown(input.markdown);
  if (!markdown) throw new Error("计划 Markdown 不能为空。");
  return { title: titleFromMarkdown(markdown), markdown };
}

export function serializePlanFile(plan: PlanState): string {
  return cleanMarkdown(plan.markdown);
}

/**
 * Parse the durable metadata and then project the human-editable Markdown body
 * over it. A fallback lets native write/edit replace the whole document while
 * preserving the session-owned identity and approval state.
 */
export function parsePlanFile(text: string, fallback?: PlanState): PlanState | undefined {
  const match = text.match(/<!--\s*coilcoil-plan:v1\s*([\s\S]*?)\s*-->/i);
  let metadata: PlanState | undefined;
  if (match) {
    try {
      metadata = parsePlanState(JSON.parse(match[1]));
    } catch {
      metadata = undefined;
    }
  }
  const base = metadata ?? fallback;
  if (!base) return undefined;
  const markdown = cleanMarkdown(match ? text.replace(match[0], "") : text) || base.markdown;
  return { ...base, title: titleFromMarkdown(markdown), markdown };
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

/** Exported for the regression test that keeps this scan from going quadratic again. */
export function latestPlanFromBranch(ctx: ExtensionContext): PlanState | undefined {
  /* getBranch() 每次调用都要把整条父链重走一遍、再新建一个数组。原来它写在循环条件
     和取元素两处，于是这个倒着找的循环是 O(n²)：一个 60MB 的会话打开一次要在这里
     花掉 5.8 秒，而「打开会话」总共才 6.5 秒。取一次就够，分支在这段循环里不会变。 */
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
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
    "请先使用原生 read 工具读取计划文件。计划文件正文是唯一的计划来源，不要假设它必须包含固定标题、步骤或验收标准章节。",
    "请按 Markdown 文档表达的计划执行；需要更新进度时，使用原生 write/edit 工具直接修改同一份 Markdown 文件。",
    "不要重新设计计划，也不要只给出建议；完成后汇报实际改动、验证结果和未完成项。",
    `计划文件：${plan.filePath}`,
    `计划 ID：${plan.id}`,
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
            source: { client: "coilcoil-plan" },
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
    promptSnippet: "plan: 以完整 Markdown 创建需要用户审批的执行计划",
    promptGuidelines: [
      "当任务包含多个明确步骤、需要用户先确认方案时使用 plan；不要把普通的 Todo 进度更新当作 plan。",
      "plan 只接收一个 markdown 参数；直接提交完整 Markdown 文档，不要把计划拆成额外的标题、目标、步骤或验收字段。",
      "Markdown 的结构由任务本身决定，不要求固定章节。创建后停止等待用户在界面中选择主 Agent 或指定子 Agent 执行。",
      "计划文件是纯 Markdown，可由原生 read/write/edit 工具继续修改；不要把计划只写在回复文本里。",
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
        content: [{ type: "text", text: `计划已保存，等待用户审批。\n文件：${filePath}\n\n${plan.title}` }],
        details: { plan, filePath } satisfies PlanDetails,
      };
    },
    renderCall(args, theme: Theme) {
      const title = titleFromMarkdown(cleanMarkdown(args.markdown));
      return new Text(theme.fg("toolTitle", theme.bold("plan")) + theme.fg("muted", ` · ${title}`), 0, 0);
    },
    renderResult(result, _options, theme: Theme) {
      const details = planDetails(result.details);
      if (!details) return new Text(theme.fg("error", "计划状态无效"), 0, 0);
      return new Text(theme.fg("accent", `${details.plan.title} · 等待审批`) + `\n${details.filePath}`, 0, 0);
    },
  });
}
