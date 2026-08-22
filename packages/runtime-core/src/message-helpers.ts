import {
  type SessionInfo,
  processImage,
} from "@earendil-works/pi-coding-agent";
import {
  type ChatMessage,
  type PromptImage,
  type SessionSummary,
  type SubagentActivity,
  type SubagentTimelineEntry,
  type TodoItem,
} from "@coilcoil/runtime-protocol";
import {
  existsSync,
} from "node:fs";
import {
  clampText,
  isRecord,
  stringValue
} from "./runtime-utils.js";
import { splitInlineThinking } from "./inline-thinking.js";

/** A prompt CoilCoil handed to Pi, waiting for Pi to echo it back as a user message. */
export interface PendingUserPrompt {
  id: string;
  /** Exactly the text passed to Pi, before Pi's own skill/template expansion. */
  text: string;
}

/**
 * Decide which pending prompt a Pi user message belongs to.
 *
 * Pi emits `message_start` for every user message, including ones no client
 * sent: a running `/goal` loop feeds itself a fresh prompt each round through
 * `sendUserMessage`. Claiming the head of the queue on sight handed that round
 * the client id of a message the user was still waiting to send, which replaced
 * the user's own bubble with the loop's text and pulled their prompt out of the
 * queue before it was ever delivered. Matching on the text keeps a
 * runtime-generated message from claiming anything.
 *
 * A leading-slash prompt is the one case the text cannot answer: Pi expands
 * skill commands and prompt templates before the message exists, so what comes
 * back is not what we sent. The head is claimed for that case alone, and only
 * once an exact match has been ruled out.
 *
 * Returns the index to consume, or -1 when the message belongs to no client.
 */
export function matchPendingUserPrompt(pending: readonly PendingUserPrompt[], text: string): number {
  const exact = pending.findIndex((prompt) => prompt.text === text);
  if (exact >= 0) return exact;
  return pending[0]?.text.startsWith("/") ? 0 : -1;
}

export function contentParts(content: unknown): { text: string; thinking: string; images: PromptImage[]; } {
  if (typeof content === "string") return { text: content, thinking: "", images: [] };
  if (!Array.isArray(content)) return { text: "", thinking: "", images: [] };

  const text: string[] = [];
  const thinking: string[] = [];
  const images: PromptImage[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "thinking" && typeof block.thinking === "string") thinking.push(block.thinking);
    if (block.type === "thinking" && typeof block.text === "string") thinking.push(block.text);
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      images.push({ mimeType: block.mimeType, data: block.data });
    }
  }
  return { text: text.join("\n"), thinking: thinking.join("\n"), images };
}

export function toolResultText(result: unknown): string {
  if (!isRecord(result)) return stringValue(result);
  const direct = contentParts(result.content).text;
  if (direct) return direct;
  if (typeof result.output === "string") return result.output;
  if (typeof result.text === "string") return result.text;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function subagentActivityStatusFrom(value: unknown): SubagentActivity["status"] {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "stopped") return value;
  return "completed";
}

export function subagentActivityFromDetails(details: unknown, parentToolId: string): SubagentActivity | undefined {
  if (!isRecord(details)) return undefined;
  const runId = stringValue(details.runId);
  if (!runId) return undefined;
  const usage = isRecord(details.usage) ? details.usage : undefined;
  const tokens = usage && typeof usage.total === "number" && Number.isFinite(usage.total) ? usage.total : 0;
  const turnCount = usage && typeof usage.turns === "number" && Number.isFinite(usage.turns) ? usage.turns : undefined;
  const finalOutput = stringValue(details.finalOutput);
  return {
    id: runId,
    runId,
    parentToolId,
    index: 0,
    agent: stringValue(details.agent) || "子 Agent",
    task: stringValue(details.task) || undefined,
    model: stringValue(details.model) || undefined,
    status: subagentActivityStatusFrom(details.status),
    background: details.background === true,
    controlReady: details.status === "running",
    resumable: details.resumable === true || undefined,
    finalOutput: finalOutput ? clampText(finalOutput, 48_000) : undefined,
    sessionFile: stringValue(details.sessionFile) || undefined,
    worktreePath: stringValue(details.worktreePath) || undefined,
    toolCount: typeof details.toolCount === "number" && Number.isFinite(details.toolCount) ? details.toolCount : 0,
    turnCount,
    tokens,
    durationMs: typeof details.durationMs === "number" && Number.isFinite(details.durationMs) ? details.durationMs : 0,
    error: stringValue(details.error) || undefined,
    updatedAt: Date.now(),
    planId: stringValue(details.planId) || undefined,
  };
}

export function subagentActivitiesFromPayload(raw: unknown): SubagentActivity[] {
  if (!isRecord(raw) || !Array.isArray(raw.activities)) return [];
  return raw.activities.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const runId = stringValue(entry.runId);
    if (!runId) return [];
    const recentTools = Array.isArray(entry.recentTools)
      ? entry.recentTools.flatMap((item) => isRecord(item) && stringValue(item.tool) ? [{ tool: stringValue(item.tool), args: stringValue(item.args) }] : [])
      : undefined;
    const recentOutput = Array.isArray(entry.recentOutput)
      ? entry.recentOutput.filter((item): item is string => typeof item === "string")
      : undefined;
    const messages = Array.isArray(entry.messages)
      ? entry.messages.flatMap((item) => isRecord(item) && stringValue(item.text) ? [{ role: stringValue(item.role) || "assistant", text: stringValue(item.text), thinking: stringValue(item.thinking) || undefined }] : [])
      : undefined;
    const toolCalls = Array.isArray(entry.toolCalls)
      ? entry.toolCalls.flatMap((item) => isRecord(item) && stringValue(item.text) ? [{ text: stringValue(item.text), expandedText: stringValue(item.expandedText) || undefined }] : [])
      : undefined;
    let timeline: SubagentTimelineEntry[] | undefined;
    if (Array.isArray(entry.timeline)) {
      const projected: SubagentTimelineEntry[] = [];
      entry.timeline.forEach((item, fallbackOrder) => {
        if (!isRecord(item)) return;
        const kind = stringValue(item.kind);
        const id = stringValue(item.id);
        const order = typeof item.order === "number" && Number.isFinite(item.order) ? item.order : fallbackOrder;
        if (!id || (kind !== "message" && kind !== "tool")) return;
        if (kind === "message") {
          const text = stringValue(item.text);
          if (!text && !stringValue(item.thinking)) return;
          projected.push({
            id,
            order,
            kind: "message",
            role: stringValue(item.role) || "assistant",
            text,
            thinking: stringValue(item.thinking) || undefined,
          });
          return;
        }
        const status: Extract<SubagentTimelineEntry, { kind: "tool"; }>["status"] = item.status === "running" || item.status === "failed" ? item.status : "succeeded";
        projected.push({
          id,
          order,
          kind: "tool",
          tool: stringValue(item.tool) || "tool",
          args: stringValue(item.args),
          expandedArgs: stringValue(item.expandedArgs) || undefined,
          output: stringValue(item.output) || undefined,
          status,
        });
      });
      timeline = projected.length ? projected : undefined;
    }
    const finalOutput = stringValue(entry.finalOutput);
    const activity: SubagentActivity = {
      id: stringValue(entry.id) || runId,
      runId,
      parentToolId: stringValue(entry.parentToolId) || undefined,
      index: typeof entry.index === "number" ? entry.index : 0,
      agent: stringValue(entry.agent) || "子 Agent",
      task: stringValue(entry.task) || undefined,
      model: stringValue(entry.model) || undefined,
      status: subagentActivityStatusFrom(entry.status),
      background: entry.background === true,
      controlReady: entry.controlReady === true || undefined,
      resumable: entry.resumable === true || undefined,
      currentTool: stringValue(entry.currentTool) || undefined,
      currentPath: stringValue(entry.currentPath) || undefined,
      recentTools: recentTools?.length ? recentTools : undefined,
      recentOutput: recentOutput?.length ? recentOutput : undefined,
      messages: messages?.length ? messages : undefined,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      timeline: timeline?.length ? timeline : undefined,
      finalOutput: finalOutput ? clampText(finalOutput, 48_000) : undefined,
      sessionFile: stringValue(entry.sessionFile) || undefined,
      worktreePath: stringValue(entry.worktreePath) || undefined,
      toolCount: typeof entry.toolCount === "number" && Number.isFinite(entry.toolCount) ? entry.toolCount : 0,
      turnCount: typeof entry.turnCount === "number" && Number.isFinite(entry.turnCount) ? entry.turnCount : undefined,
      tokens: typeof entry.tokens === "number" && Number.isFinite(entry.tokens) ? entry.tokens : 0,
      durationMs: typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) ? entry.durationMs : 0,
      error: stringValue(entry.error) || undefined,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
      planId: stringValue(entry.planId) || undefined,
    };
    return [activity];
  });
}

export function restoredSubagentActivity(activity: SubagentActivity): SubagentActivity {
  if (activity.status !== "pending" && activity.status !== "running") return activity;
  const resumable = Boolean(activity.sessionFile && existsSync(activity.sessionFile));
  return {
    ...activity,
    status: "stopped",
    controlReady: false,
    resumable: resumable || undefined,
  };
}

export function messageTimestamp(message: Record<string, unknown>): number {
  const timestamp = message.timestamp;
  if (typeof timestamp === "number") return timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

export interface AssistantToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export function assistantToolCalls(message: unknown): AssistantToolCall[] {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const timestamp = messageTimestamp(message);
  return message.content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "toolCall") return [];
    const id = stringValue(block.id) || stringValue(block.toolCallId);
    const name = stringValue(block.name) || stringValue(block.toolName);
    if (!id || !name) return [];
    const args = isRecord(block.arguments) ? { ...block.arguments } : isRecord(block.args) ? { ...block.args } : {};
    return [{ id, name, args, timestamp }];
  });
}

export function mapMessage(message: unknown, id: string, order: number, entryId?: string): ChatMessage | undefined {
  if (!isRecord(message) || typeof message.role !== "string") return undefined;
  const role = message.role;
  const parts = contentParts(message.content);

  if (role === "user") {
    return { id, entryId, order, role: "user", text: parts.text, images: parts.images.length ? parts.images : undefined, timestamp: messageTimestamp(message) };
  }
  if (role === "assistant") {
    const stopReason = stringValue(message.stopReason);
    const failed = stopReason === "error" || stopReason === "aborted";
    const provider = stringValue(message.provider);
    const modelId = stringValue(message.model);
    // Reasoning that a proxy inlined as <thinking> markup belongs in the
    // thinking channel, not rendered as literal tags in the reply.
    const split = splitInlineThinking(parts.text, parts.thinking);
    return {
      id,
      order,
      role: "assistant",
      model: provider && modelId ? { provider, id: modelId } : undefined,
      text: split.text || (failed ? stringValue(message.errorMessage) : ""),
      thinking: split.thinking || undefined,
      timestamp: messageTimestamp(message),
      isError: stopReason === "error",
      status: stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "succeeded",
    };
  }
  if (role === "toolResult") {
    return {
      id,
      order,
      role: "tool",
      text: parts.text,
      timestamp: messageTimestamp(message),
      toolName: stringValue(message.toolName) || "tool",
      toolCallId: stringValue(message.toolCallId) || undefined,
      isError: message.isError === true,
      status: message.isError === true ? "failed" : "succeeded",
    };
  }
  if (role === "bashExecution") {
    return {
      id,
      order,
      role: "tool",
      text: stringValue(message.output),
      timestamp: messageTimestamp(message),
      toolName: "bash",
      status: "succeeded",
    };
  }
  if (role === "custom" && message.display !== false) {
    const customType = stringValue(message.customType);
    return {
      id,
      order,
      role: "system",
      text: parts.text,
      timestamp: messageTimestamp(message),
      custom: customType
        ? { type: customType, details: isRecord(message.details) ? message.details : undefined }
        : undefined,
    };
  }
  return undefined;
}

export function titleFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "新建对话";
  return oneLine.length > 64 ? `${oneLine.slice(0, 61)}…` : oneLine;
}

export async function preparePromptImages(images: PromptImage[] | undefined): Promise<{ images: PromptImage[]; hints: string; }> {
  if (!images?.length) return { images: [], hints: "" };
  const prepared: PromptImage[] = [];
  const hints: string[] = [];
  for (const [index, image] of images.entries()) {
    if (!image.mimeType.startsWith("image/") || !image.data) throw new Error("粘贴的图片数据无效。");
    const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, { autoResizeImages: true });
    if (!processed.ok) throw new Error(`第 ${index + 1} 张图片无法处理：${processed.message}`);
    prepared.push({ id: image.id, name: image.name, mimeType: processed.mimeType, data: processed.data });
    if (processed.hints.length) hints.push(`<image name="${image.name || `pasted-${index + 1}`}">${processed.hints.join("\n")}</image>`);
  }
  return { images: prepared, hints: hints.join("\n") };
}

export function sessionSummary(info: SessionInfo): SessionSummary {
  return {
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    title: info.name || titleFromText(info.firstMessage),
    createdAt: info.created.toISOString(),
    updatedAt: info.modified.toISOString(),
    messageCount: info.messageCount,
  };
}

export function normalizeTodoPlan(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: TodoItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const rawText = typeof item.text === "string" ? item.text : typeof item.step === "string" ? item.step : undefined;
    const status = item.status;
    if (!rawText || (status !== "pending" && status !== "in_progress" && status !== "completed")) {
      return undefined;
    }
    result.push({ text: rawText, status });
  }
  return result;
}

export function planFromResult(result: unknown): TodoItem[] | undefined {
  if (!isRecord(result)) return undefined;
  const details = isRecord(result.details) ? result.details : undefined;
  return normalizeTodoPlan(details?.plan);
}

export function extractExitCode(result: unknown): number | undefined {
  if (!isRecord(result)) return undefined;
  const details = isRecord(result.details) ? result.details : undefined;
  const candidates = [details?.exitCode, details?.code, result.exitCode];
  return candidates.find((value): value is number => typeof value === "number");
}
