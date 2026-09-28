import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];

/** 一条发给模型的消息（convertToLlm 之后）：只有用户、助手、工具结果三种。 */
export interface LlmMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
}

/**
 * 粗估 token 数。
 *
 * Pi 用「字符数 ÷ 4」估，英文差不多，中文少估三四倍：一个汉字大约就是一个 token。
 * 压缩要回答的是「压完能不能落到窗口的 35% 以下」，少估了就会以为压够了，结果没多久
 * 又得压。所以中日韩字符按 1 个算，其余按 4 个字符 1 个算，宁可略多。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let wide = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) wide++;
  }
  const narrow = text.length - wide;
  return wide + Math.ceil(narrow / 4);
}

const IMAGE_TOKENS = 1200;

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((item): item is Block => Boolean(item) && typeof item === "object") : [];
}

/** 一条消息原样发出去大概多少 token（思考过程也算上：保留区里的消息是原样发的）。 */
export function estimateMessageTokens(message: AgentMessage | LlmMessage): number {
  let total = 4;
  for (const block of blocks((message as LlmMessage).content)) {
    if (block.type === "text") total += estimateTextTokens(block.text ?? "");
    else if (block.type === "thinking") total += estimateTextTokens(block.thinking ?? "");
    else if (block.type === "toolCall") total += estimateTextTokens(`${block.name ?? ""}${safeJson(block.arguments)}`);
    else if (block.type === "image") total += IMAGE_TOKENS;
  }
  const record = message as unknown as Record<string, unknown>;
  // bashExecution、custom 这类消息没有 content 块，内容在别的字段里。
  if (!Array.isArray(record.content) && typeof record.content !== "string") {
    for (const key of ["command", "output", "summary"]) {
      if (typeof record[key] === "string") total += estimateTextTokens(record[key] as string);
    }
  }
  return total;
}

function safeJson(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function textOf(content: unknown): string {
  return blocks(content).map((block) => {
    if (block.type === "text") return block.text ?? "";
    if (block.type === "image") return "[图片]";
    return "";
  }).filter(Boolean).join("\n");
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…（共 ${text.length} 字）`;
}

/**
 * 工具调用的参数，只留一行能看懂「做了什么」的痕迹。
 *
 * 路径、命令开头、搜索词这些短参数原样留下；编辑、写文件里整段的代码只留开头和总长。
 * 摘要和后面的模型要知道「改了 src/a.ts」，不需要知道改成了什么——那在文件里，在存档里。
 */
export function traceArguments(args: unknown, longValueChars = 160, headChars = 80): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return clip(safeJson(args), longValueChars);
  return Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const text = safeJson(value);
    return `${key}=${text.length <= longValueChars ? text : `${text.slice(0, headChars)}…（共 ${text.length} 字）`}`;
  }).join(", ");
}

/**
 * 第 1 层：整理稿。用户和助手的原话一字不动；思考过程删掉；工具调用只留一行，工具结果只留
 * 「结果多长、有没有出错」，出错时带上开头一小段报错。不调模型，一次就好。
 */
export function renderCleaned(messages: readonly LlmMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      if (text) lines.push(`【用户】${text}`);
    } else if (message.role === "assistant") {
      const text = blocks(message.content).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
      if (text) lines.push(`【助手】${text}`);
      for (const block of blocks(message.content)) {
        if (block.type === "toolCall") lines.push(`【工具】${block.name ?? "?"}(${traceArguments(block.arguments)})`);
      }
    } else if (message.role === "toolResult") {
      const text = textOf(message.content);
      lines.push(message.isError
        ? `  → 出错：${clip(text.trim(), 300)}`
        : `  → 结果已省略（${text.length} 字）`);
    }
  }
  return lines.join("\n\n");
}

const RESULT_HEAD = 2000;
const RESULT_TAIL = 800;

/**
 * 第 2 层：交给模型写摘要的材料。思考过程删掉；工具调用和工具结果都留（用户定的）——
 * 摘要要知道「做了之后发现了什么」。单条很长的结果留头尾：报错、结论多在这两处。
 */
export function renderForSummary(messages: readonly LlmMessage[]): string[] {
  const units: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      if (text) units.push(`【用户】${text}`);
    } else if (message.role === "assistant") {
      const parts: string[] = [];
      const text = blocks(message.content).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
      if (text) parts.push(`【助手】${text}`);
      for (const block of blocks(message.content)) {
        if (block.type === "toolCall") parts.push(`【工具调用】${block.name ?? "?"}(${traceArguments(block.arguments, 2000, 1500)})`);
      }
      if (parts.length) units.push(parts.join("\n"));
    } else if (message.role === "toolResult") {
      const text = textOf(message.content);
      const body = text.length <= RESULT_HEAD + RESULT_TAIL
        ? text
        : `${text.slice(0, RESULT_HEAD)}\n…（中间省略 ${text.length - RESULT_HEAD - RESULT_TAIL} 字）…\n${text.slice(-RESULT_TAIL)}`;
      units.push(`【工具结果${message.isError ? "·出错" : ""}${message.toolName ? `·${message.toolName}` : ""}】${body}`);
    }
  }
  return units;
}

/** Pi 整理出来的读写过的文件，写进摘要末尾，压完模型知道该回头看哪些文件。 */
export function fileListSection(fileOps: { read?: Set<string>; written?: Set<string>; edited?: Set<string> } | undefined): string {
  if (!fileOps) return "";
  const modified = [...new Set([...(fileOps.edited ?? []), ...(fileOps.written ?? [])])];
  const readOnly = [...(fileOps.read ?? [])].filter((path) => !modified.includes(path));
  const lines: string[] = [];
  if (modified.length) lines.push(`改过的文件：\n${modified.slice(-40).map((path) => `- ${path}`).join("\n")}`);
  if (readOnly.length) lines.push(`读过的文件：\n${readOnly.slice(-40).map((path) => `- ${path}`).join("\n")}`);
  return lines.length ? `## 涉及的文件\n${lines.join("\n")}` : "";
}

/** 第 1 层整理稿的开头。以后再压时认出它，把它当材料而不是当摘要。 */
export const CLEANED_HEADER = "<!-- coilcoil:cleaned-transcript -->";
const CLEANED_NOTE = "以下是较早对话的整理稿：用户和助手的原话原样保留，删去了助手的思考过程和工具输出，工具调用只留一行记录。完整原文在压缩存档里（路径见系统提示），需要细节时再去查。";

const FILES_MARKER = "<!-- coilcoil:files -->";

/** 认出上一次的整理稿，取出正文（去掉开头说明和末尾文件清单，文件清单每次重新生成）。 */
export function cleanedBody(summary: string): string | undefined {
  if (!summary.startsWith(CLEANED_HEADER)) return undefined;
  const at = summary.indexOf("\n---\n");
  const body = at < 0 ? "" : summary.slice(at + 5);
  const files = body.lastIndexOf(FILES_MARKER);
  return (files < 0 ? body : body.slice(0, files)).trimEnd();
}

/** 第 1 层的产物：上一份（整理稿正文或摘要）+ 这次整理的对话 + 文件清单。 */
export function composeCleaned(options: { previousBody?: string; previousSummary?: string; cleaned: string; files: string }): string {
  const sections = [
    options.previousSummary ? `## 更早内容的摘要\n${options.previousSummary}` : "",
    options.previousBody ?? "",
    options.cleaned,
  ].filter((part) => part.trim());
  const files = options.files.trim() ? `\n\n${FILES_MARKER}\n${options.files}` : "";
  return `${CLEANED_HEADER}\n${CLEANED_NOTE}\n---\n${sections.join("\n\n")}${files}`;
}

/**
 * 按预算把材料切块，切在消息之间；单条消息比整块预算还大就按字切开。
 */
export function chunkUnits(units: readonly string[], budgetTokens: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let used = 0;
  const flush = (): void => {
    if (current.length) chunks.push(current.join("\n\n"));
    current = [];
    used = 0;
  };
  for (const unit of units) {
    const tokens = estimateTextTokens(unit);
    if (tokens > budgetTokens) {
      flush();
      // 按比例估一个安全的字数，再逐段切。
      const chars = Math.max(1000, Math.floor(unit.length * (budgetTokens / tokens) * 0.9));
      for (let at = 0; at < unit.length; at += chars) chunks.push(unit.slice(at, at + chars));
      continue;
    }
    if (used + tokens > budgetTokens) flush();
    current.push(unit);
    used += tokens;
  }
  flush();
  return chunks;
}
