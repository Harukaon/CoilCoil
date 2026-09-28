import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

type AgentMessage = ContextEvent["messages"][number];

/**
 * Keep a readable copy of everything compaction throws away.
 *
 * Compaction is lossy by construction: a stretch of conversation becomes a
 * paragraph of prose, and whatever was not worth a sentence is gone from the
 * model's view for good. That is the right trade most of the time and the wrong
 * one exactly when it matters — the detail the summary skipped turns out to be
 * the one the next question needs.
 *
 * It does not have to be a one-way door. Pi appends the summary as a new entry
 * and leaves the original messages in the session file, so the history is still
 * on disk; it is only unreachable. This writes that same stretch out as plain
 * text next to the session and tells the model where it went, which turns
 * compaction from lossy into lossy-but-recoverable.
 *
 * **No new tool.** The Agent already has `read` (absolute paths, `offset` and
 * `limit`, a byte cap that truncates) and `grep`. Those are the right tools with
 * the right guard rails already on them, and a bespoke history tool would have
 * been a third way to do the same thing. What the model gets is a path and an
 * index; it decides whether any of it is worth reading.
 *
 * `context-clearing` 目前没有注册。以后如果重新启用，这个扩展必须排在它前面
 * （`package.json` 里的 `pi.extensions` 就是执行顺序）。两个扩展挂的是同一个
 * `session_before_compact`，拿到的是同一个 `preparation.messagesToSummarize` 数组，而
 * 清理层会就地改写它。排在后面，存档里留下的就是占位符而不是原文。
 *
 * The transcript is plain text rather than a pointer into the raw session file
 * on purpose. That file is JSONL — every line a JSON object wrapped around
 * escaped content — so reading it back costs more tokens than the conversation
 * it replaced. Prose in, prose out.
 */

const SECTION_MARKER = "<!-- coilcoil:compaction ";
/** Enough of one tool result to be worth having; the rest is rarely read back. */
const MAX_RESULT_CHARS = 20_000;
const MAX_ARGUMENT_CHARS = 2_000;

export interface TranscriptSection {
  /** 1-indexed, inclusive line range inside the transcript file. */
  fromLine: number;
  toLine: number;
  /** When the compaction happened, for the model to order things by. */
  at: number;
  messageCount: number;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（截断，原文共 ${text.length} 字符）`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; text?: string };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

/**
 * An assistant turn carries its tool calls inside its own content rather than
 * as separate messages, so what the model asked for has to be pulled out of the
 * same array as what it said. The arguments are the part worth keeping: they
 * are what makes a cleared result re-fetchable.
 */
function toolCallLines(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const lines: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; name?: string; arguments?: unknown };
    if (record.type !== "toolCall") continue;
    lines.push(
      `### 调用 ${record.name ?? "?"}`,
      truncate(JSON.stringify(record.arguments ?? {}), MAX_ARGUMENT_CHARS),
    );
  }
  return lines;
}

/**
 * Render one compacted stretch as something a person — or a model with `read` —
 * can actually follow. Roles become headings so `grep` has anchors.
 */
export function renderTranscript(messages: readonly AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const record = message as {
      role: string;
      content?: unknown;
      toolName?: string;
      customType?: string;
    };
    switch (record.role) {
      case "user":
        lines.push("## 用户", textOf(record.content));
        break;
      case "assistant": {
        const said = textOf(record.content).trim();
        if (said) lines.push("## 助手", said);
        lines.push(...toolCallLines(record.content));
        break;
      }
      case "toolResult":
        lines.push(`### 结果 ${record.toolName ?? "?"}`, truncate(textOf(record.content), MAX_RESULT_CHARS));
        break;
      case "bashExecution":
        lines.push("### 终端", truncate(textOf(record.content), MAX_RESULT_CHARS));
        break;
      // A summary of an earlier stretch is itself worth keeping: it is how a
      // second compaction leaves a trace of the first one.
      case "branchSummary":
      case "compactionSummary":
        lines.push(`## 上一轮总结（${record.role}）`, truncate(textOf(record.content), MAX_RESULT_CHARS));
        break;
      case "custom":
        lines.push(`### ${record.customType ?? "custom"}`, truncate(textOf(record.content), MAX_ARGUMENT_CHARS));
        break;
      default:
        break;
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function transcriptPathFor(sessionFile: string): string {
  return `${sessionFile.replace(/\.jsonl$/i, "")}.transcript.md`;
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 0;
  for (const character of text) if (character === "\n") lines += 1;
  return text.endsWith("\n") ? lines : lines + 1;
}

/**
 * Recover the index from a transcript written before this process started.
 *
 * Resuming a session leaves the file on disk but the in-memory index empty, and
 * an index that forgets the earlier compactions points the model at a file
 * without telling it where anything is. Each section carries its own marker
 * line, so the ranges can simply be read back.
 */
export function readSections(path: string): TranscriptSection[] {
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const sections: TranscriptSection[] = [];
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith(SECTION_MARKER)) continue;
    const raw = line.slice(SECTION_MARKER.length, line.lastIndexOf("-->")).trim();
    try {
      const parsed = JSON.parse(raw) as { at?: number; messageCount?: number; toLine?: number };
      sections.push({
        fromLine: index + 1,
        toLine: typeof parsed.toLine === "number" ? parsed.toLine : lines.length,
        at: typeof parsed.at === "number" ? parsed.at : 0,
        messageCount: typeof parsed.messageCount === "number" ? parsed.messageCount : 0,
      });
    } catch {
      // A hand-edited or half-written marker is skipped rather than fatal.
    }
  }
  return sections;
}

/** Wraps the note so it can be recognised and not appended twice. */
export const TRANSCRIPT_NOTE_MARKER = "<compacted_transcript>";

/**
 * The note handed to the model: where the history went, and what is in it.
 *
 * Worded as a reference card, not as a task. The first version ended with
 * "只有在当前问题确实需要更早的细节时才去读", which asks the model to make a
 * judgement — and a judgement asked for on every single request gets reported
 * on every single request. Sessions filled up with "这次问题不需要读取压缩对话
 * 原文", which is the model dutifully answering a question nobody wanted asked.
 *
 * So: state where the archive is and how to page through it, and say plainly
 * that using it needs no announcement.
 */
export function transcriptNote(path: string, sections: readonly TranscriptSection[]): string | undefined {
  if (!sections.length) return undefined;
  const index = sections.map((section, order) => {
    const when = section.at ? new Date(section.at).toISOString().slice(0, 16).replace("T", " ") : "未知时间";
    return `  ${order + 1}. 第 ${section.fromLine}–${section.toLine} 行 · ${section.messageCount} 条 · 压缩于 ${when}`;
  });
  return [
    TRANSCRIPT_NOTE_MARKER,
    "这个会话压缩过。被压缩掉的对话原文没有丢，完整存在这个文件里：",
    path,
    "",
    "分段索引（行号可直接用 read 的 offset/limit 翻页，也可以先用 grep 搜关键词）：",
    ...index,
    "",
    "这是一份需要时可查的存档。按行段取，不要一次读回太多；用不上就不用管它，也不必在回复里交代自己读没读。",
    "</compacted_transcript>",
  ].join("\n");
}

export default function contextTranscriptExtension(pi: ExtensionAPI): void {
  let transcriptPath: string | undefined;
  let sections: TranscriptSection[] = [];
  let pendingArchive: { path: string; body: string; at: number; messageCount: number } | undefined;

  const locate = (ctx: ExtensionContext): string | undefined => {
    if (transcriptPath) return transcriptPath;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!sessionFile) return undefined;
    transcriptPath = transcriptPathFor(sessionFile);
    sections = readSections(transcriptPath);
    return transcriptPath;
  };

  const reset = (_event: unknown, ctx: ExtensionContext): void => {
    transcriptPath = undefined;
    sections = [];
    pendingArchive = undefined;
    locate(ctx);
  };

  pi.on("session_start", reset);
  // A different branch has its own history; the transcript follows the session
  // file, so re-reading it is what keeps the index honest after a fork.
  pi.on("session_tree", reset);
  pi.on("session_shutdown", () => {
    transcriptPath = undefined;
    sections = [];
    pendingArchive = undefined;
  });

  /**
   * Capture the original stretch before the clearing extension rewrites the
   * summary input. Only write it if Pi actually commits the compaction: an
   * automatic threshold check can be cancelled when the request copy fits.
   *
   * Nothing is returned, so Pi's own summarization runs untouched — this only
   * adds the way back. Failing to write must not stop a compaction that the
   * session may need to survive the next request, so errors are swallowed.
   */
  pi.on("session_before_compact", (event, ctx) => {
    pendingArchive = undefined;
    const path = locate(ctx);
    const messages = event.preparation?.messagesToSummarize ?? [];
    if (!path || !messages.length) return undefined;
    try {
      pendingArchive = { path, body: renderTranscript(messages), at: Date.now(), messageCount: messages.length };
    } catch {
      // The transcript is a convenience; compaction is not.
    }
    return undefined;
  });

  pi.on("session_compact", () => {
    const archive = pendingArchive;
    pendingArchive = undefined;
    if (!archive) return;
    try {
      const existing = existsSync(archive.path) ? countLines(readFileSync(archive.path, "utf8")) : 0;
      const fromLine = existing + 1;
      const toLine = fromLine + countLines(archive.body) + 1;
      const marker = `${SECTION_MARKER}${JSON.stringify({ at: archive.at, messageCount: archive.messageCount, toLine })} -->`;
      mkdirSync(dirname(archive.path), { recursive: true });
      appendFileSync(archive.path, `${marker}\n${archive.body}\n`, "utf8");
      sections.push({ fromLine, toLine, at: archive.at, messageCount: archive.messageCount });
    } catch {
      // The transcript is a convenience; compaction is not.
    }
  });

  pi.on("session_compact_failed", () => { pendingArchive = undefined; });

  /**
   * Re-state the pointer on every request once there is something to point at.
   *
   * It has to be re-stated rather than written once: the note itself would be
   * summarized away by the next compaction, taking the way back with it.
   */
  /**
   * Stated once per run in the system prompt, not appended to every request.
   *
   * It used to be pushed onto the end of the message list on every `context`
   * event — the last thing the model saw before answering, every turn. That
   * reads as a fresh instruction rather than as reference material, and the
   * model acknowledged it each time. The system prompt is the right home: it is
   * rebuilt for every run, so it survives compaction without being restated
   * inside the conversation itself.
   */
  pi.on("before_agent_start", (event, ctx) => {
    locate(ctx);
    const note = transcriptPath ? transcriptNote(transcriptPath, sections) : undefined;
    if (!note || event.systemPrompt.includes(TRANSCRIPT_NOTE_MARKER)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${note}` };
  });
}
