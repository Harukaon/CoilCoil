import {
  type SessionInfo,
  processImage,
} from "@earendil-works/pi-coding-agent";
import {
  type ChatMessage,
  type PromptBrowserElementPart,
  type PromptDocument,
  type PromptPart,
  type PromptImage,
  type SessionSummary,
  type SubagentActivity,
  type SubagentTimelineEntry,
  type TodoItem,
  promptDocumentText,
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
  /** The local display document, used when Pi normalizes image prompt text. */
  promptDocument?: PromptDocument;
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
  const normalized = text.trim();
  if (normalized) {
    const fuzzy = pending.findIndex((prompt) => {
      const candidates = (prompt.promptDocument ? [prompt.text, promptDocumentText(prompt.promptDocument)] : [])
        .map((candidate) => candidate.trim())
        .filter(Boolean);
      return candidates.some((candidate) => candidate === normalized
        || candidate.includes(normalized)
        || normalized.includes(candidate));
    });
    if (fuzzy >= 0) return fuzzy;
  }
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

const LEGACY_ELEMENT_IMAGE = /<image\b[^>]*\bname=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/image\s*>/gi;

function decodeMarkup(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function legacyElementField(body: string, label: string): string {
  const match = body.match(new RegExp(`(?:^|\\n)${label}:\\s*([\\s\\S]*?)(?=\\n(?:页面|URL|标签|选择器|XPath|属性|样式|组件|源码位置|可见文本|outerHTML):|$)`));
  return decodeMarkup(match?.[1]?.trim() ?? "");
}

/**
 * Older sessions only retained Pi's expanded image hint. Recover its visible
 * atomic label when the private prompt-document entry is not present yet.
 * This is deliberately narrow: ordinary user text containing an image tag is
 * left untouched unless it is recognizably a CoilCoil browser-element hint.
 */
export function legacyPromptDocumentFromText(text: string): PromptDocument | undefined {
  const matches = [...text.matchAll(LEGACY_ELEMENT_IMAGE)];
  if (!matches.length) return undefined;
  const parsed = matches.flatMap((match) => {
    const name = decodeMarkup(match[1] ?? match[2] ?? "");
    const body = match[3] ?? "";
    const label = body.match(/^\[([^\]\n]+)\]/m)?.[1]?.trim();
    const selectorFromName = name.replace(/^网页元素\s*[·:-]\s*/, "").trim();
    const selector = legacyElementField(body, "选择器") || selectorFromName;
    if (!label || !selector || !body.includes("页面:") || !body.includes("URL:")) return [];
    return [{
      label,
      element: {
        pageUrl: legacyElementField(body, "URL"),
        pageTitle: legacyElementField(body, "页面"),
        tagName: legacyElementField(body, "标签"),
        selector,
        xpath: legacyElementField(body, "XPath"),
        outerHtml: legacyElementField(body, "outerHTML"),
        text: legacyElementField(body, "可见文本") || undefined,
        attributes: {},
        styles: {},
      },
    }];
  });
  if (!parsed.length) return undefined;
  const visible = text.replace(LEGACY_ELEMENT_IMAGE, "").replace(/\n{3,}/g, "\n\n");
  const parts: PromptPart[] = [];
  let cursor = 0;
  for (const [index, item] of parsed.entries()) {
    const position = visible.indexOf(item.label, cursor);
    if (position < 0) continue;
    if (position > cursor) parts.push({ type: "text", text: visible.slice(cursor, position) });
    parts.push({
      type: "browser-element",
      id: `legacy-browser-element-${index + 1}`,
      label: item.label,
      element: item.element,
    });
    cursor = position + item.label.length;
  }
  if (!parts.length) return undefined;
  if (cursor < visible.length) parts.push({ type: "text", text: visible.slice(cursor) });
  return { version: 1, parts };
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
    modelInherited: details.modelInherited === true || undefined,
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
      modelInherited: entry.modelInherited === true || undefined,
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

export function mapMessage(message: unknown, id: string, order: number, entryId?: string, promptDocument?: PromptDocument): ChatMessage | undefined {
  if (!isRecord(message) || typeof message.role !== "string") return undefined;
  const role = message.role;
  const parts = contentParts(message.content);

  if (role === "user") {
    const recovered = promptDocument ?? legacyPromptDocumentFromText(parts.text);
    return {
      id,
      entryId,
      order,
      role: "user",
      text: recovered ? promptDocumentText(recovered) : parts.text,
      promptDocument: recovered,
      images: parts.images.length ? parts.images : undefined,
      timestamp: messageTimestamp(message),
    };
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

function browserElementContext(part: PromptBrowserElementPart): string {
  const element = part.element;
  const attributes = Object.entries(element.attributes).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(" ");
  const styles = Object.entries(element.styles).map(([name, value]) => `${name}: ${value}`).join("; ");
  const source = element.source ? `${element.source.file}${element.source.line ? `:${element.source.line}` : ""}${element.source.column ? `:${element.source.column}` : ""}` : "";
  return [
    `[${part.label}]`,
    `页面: ${element.pageTitle || "未命名页面"}`,
    `URL: ${element.pageUrl}`,
    `标签: ${element.tagName}`,
    `选择器: ${element.selector}`,
    `XPath: ${element.xpath}`,
    attributes ? `属性: ${attributes}` : "",
    styles ? `样式: ${styles}` : "",
    element.component ? `组件: ${element.component}` : "",
    source ? `源码位置: ${source}` : "",
    element.text ? `可见文本: ${clampText(element.text, 8_000)}` : "",
    element.outerHtml ? `outerHTML:\n${clampText(element.outerHtml, 16_000)}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Convert the editor's private atomic nodes into the ordinary prompt Pi accepts.
 * The document itself never goes into the model protocol; only this natural
 * text and optional image context do.
 */
export function promptDocumentPrompt(
  document: PromptDocument | undefined,
  images: PromptImage[] | undefined,
): { text: string; images?: PromptImage[] } {
  if (!document) return { text: "", images };
  const parts = document.parts.filter((part): part is PromptBrowserElementPart => part.type === "browser-element");
  if (!parts.length) return { text: document.parts.map((part) => part.type === "text" ? part.text : part.label).join(""), images };
  const imageIds = new Set(parts.map((part) => part.screenshotId).filter((id): id is string => Boolean(id)));
  const contexts = parts
    .filter((part) => !part.screenshotId || !images?.some((image) => image.id === part.screenshotId))
    .map(browserElementContext);
  const text = document.parts.map((part) => part.type === "text" ? part.text : part.label).join("");
  const nextImages = images?.map((image) => {
    if (!image.id || !imageIds.has(image.id)) return image;
    const matching = parts.filter((part) => part.screenshotId === image.id).map(browserElementContext);
    return { ...image, context: [image.context, ...matching].filter(Boolean).join("\n\n") };
  });
  return {
    text: [text, contexts.length ? `以下是用户选中元素的 DOM 上下文：\n\n${contexts.join("\n\n")}` : ""].filter(Boolean).join("\n\n"),
    images: nextImages,
  };
}

/** Decode persisted composer metadata defensively; malformed custom entries are ignored. */
export function promptDocumentFromUnknown(value: unknown): PromptDocument | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.parts)) return undefined;
  const parts: PromptPart[] = [];
  for (const raw of value.parts) {
    if (!isRecord(raw) || (raw.type !== "text" && raw.type !== "browser-element")) continue;
    if (raw.type === "text" && typeof raw.text === "string") {
      parts.push({ type: "text", text: raw.text });
      continue;
    }
    if (raw.type !== "browser-element" || typeof raw.id !== "string" || typeof raw.label !== "string" || !isRecord(raw.element)) continue;
    const element = raw.element;
    if (typeof element.pageUrl !== "string" || typeof element.pageTitle !== "string" || typeof element.tagName !== "string"
      || typeof element.selector !== "string" || typeof element.xpath !== "string" || typeof element.outerHtml !== "string") continue;
    const recordOfStrings = (candidate: unknown): Record<string, string> => {
      if (!isRecord(candidate)) return {};
      const result: Record<string, string> = {};
      for (const [key, item] of Object.entries(candidate)) if (typeof item === "string") result[key] = item;
      return result;
    };
    parts.push({
      type: "browser-element",
      id: raw.id,
      label: raw.label,
      element: {
        pageUrl: element.pageUrl,
        pageTitle: element.pageTitle,
        tagName: element.tagName,
        selector: element.selector,
        xpath: element.xpath,
        outerHtml: element.outerHtml,
        text: typeof element.text === "string" ? element.text : undefined,
        attributes: recordOfStrings(element.attributes),
        styles: recordOfStrings(element.styles),
        component: typeof element.component === "string" ? element.component : undefined,
        componentProps: isRecord(element.componentProps) ? element.componentProps as Record<string, string | number | boolean | null> : undefined,
        source: isRecord(element.source) && typeof element.source.file === "string" ? {
          file: element.source.file,
          line: typeof element.source.line === "number" ? element.source.line : undefined,
          column: typeof element.source.column === "number" ? element.source.column : undefined,
        } : undefined,
        bounds: isRecord(element.bounds) && typeof element.bounds.x === "number" && typeof element.bounds.y === "number"
          && typeof element.bounds.width === "number" && typeof element.bounds.height === "number"
          ? { x: element.bounds.x, y: element.bounds.y, width: element.bounds.width, height: element.bounds.height }
          : undefined,
      },
      screenshotId: typeof raw.screenshotId === "string" ? raw.screenshotId : undefined,
    });
  }
  if (!parts.length && value.parts.length > 0) return undefined;
  return { version: 1, parts };
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
    const context = typeof image.context === "string" && image.context.trim()
      ? image.context.slice(0, 30_000)
        .replace(/<image\b/gi, "&lt;image")
        .replace(/<\/image\s*>/gi, "&lt;/image&gt;")
      : undefined;
    prepared.push({ id: image.id, name: image.name, context, mimeType: processed.mimeType, data: processed.data });
    const details = [...processed.hints, ...(context ? [context] : [])];
    if (details.length) {
      const name = (image.name || `pasted-${index + 1}`).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
      })[character] ?? character);
      hints.push(`<image name="${name}">${details.join("\n")}</image>`);
    }
  }
  return { images: prepared, hints: hints.join("\n") };
}

/**
 * Only the fields a session list actually shows.
 *
 * Named as a subset rather than the whole of Pi's `SessionInfo` because the
 * rest of that type is expensive to produce — `allMessagesText` alone is every
 * message of the conversation concatenated — and nothing here has ever read it.
 * See `session-index.ts`.
 */
export type SessionSummarySource = Pick<
  SessionInfo,
  "id" | "path" | "cwd" | "name" | "firstMessage" | "created" | "modified" | "messageCount"
>;

export function sessionSummary(info: SessionSummarySource): SessionSummary {
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
