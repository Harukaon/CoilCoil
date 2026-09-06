/**
 * 索引式记忆的纯格式层：解析、生成和把旧的整块记忆拆成条目。
 *
 * 记忆原本是一个 MEMORY.md 整块正文，每轮全量注入上下文，越写越占位置。
 * 现在 MEMORY.md 只保留索引（一行一条：标题 + 一句摘要 + 文件名），正文放在
 * memories/ 下的独立文件里，模型需要哪条再用 read 打开哪条。
 *
 * 这里只做字符串处理，不碰文件系统；落盘和迁移在 memory-storage.ts 里，
 * 以免两个模块互相 import。
 */

/** 标记 MEMORY.md 已经是索引格式，避免把索引本身再当成旧正文迁移一次。 */
export const MEMORY_INDEX_MARKER = "<!-- coilcoil-memory-index v1 -->";

/** 记忆正文所在的子目录名，相对于项目记忆目录。 */
export const MEMORY_ENTRIES_DIRNAME = "memories";

const MEMORY_INDEX_TITLE = "# 项目记忆索引";
const MEMORY_INDEX_HINT = "每行一条记忆：标题、摘要和正文文件；需要细节时用 read 打开对应文件，不要把正文搬回本文件。";
const ENTRY_LINE = /^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[：:]|—|--|\s-\s)?\s*(.*)$/;
const SUMMARY_MAX_CHARS = 60;
const FILE_NAME_MAX_CHARS = 40;

export interface MemoryIndexEntry {
  /** 条目标题，也是索引里显示的名字。 */
  title: string;
  /** 相对于项目记忆目录的正文文件路径，例如 `memories/部署.md`。 */
  file: string;
  /** 一句话摘要，决定模型要不要打开这条正文。 */
  summary: string;
}

export function parseMemoryIndex(content: string): MemoryIndexEntry[] {
  const entries: MemoryIndexEntry[] = [];
  for (const line of content.split("\n")) {
    const matched = ENTRY_LINE.exec(line);
    if (!matched) continue;
    const file = matched[2].trim();
    if (!file || !file.toLowerCase().endsWith(".md")) continue;
    entries.push({
      title: matched[1].trim() || file,
      file,
      summary: matched[3].trim(),
    });
  }
  return entries;
}

/**
 * 旧格式（整块正文）和新格式（索引）都要能读，所以判断放宽：带标记的是索引，
 * 用户手动编辑时不小心删掉标记的，只要还解析得出条目行，也当索引处理。
 */
export function isMemoryIndex(content: string): boolean {
  return content.includes(MEMORY_INDEX_MARKER) || parseMemoryIndex(content).length > 0;
}

export function renderMemoryIndex(entries: readonly MemoryIndexEntry[]): string {
  const lines = entries.map((entry) => {
    const summary = entry.summary.trim();
    return `- [${entry.title}](${entry.file})${summary ? `：${summary}` : ""}`;
  });
  return `${MEMORY_INDEX_TITLE}\n\n${MEMORY_INDEX_MARKER}\n${MEMORY_INDEX_HINT}\n\n${lines.join("\n")}\n`;
}

/**
 * 摘要取正文里第一行普通文字。标题行只当兜底：条目标题本来就是那行标题，
 * 再拿它当摘要等于什么都没说。
 */
export function summarizeMemoryBody(body: string, maximum = SUMMARY_MAX_CHARS): string {
  const clip = (text: string): string => {
    const characters = Array.from(text);
    return characters.length > maximum ? `${characters.slice(0, maximum).join("")}…` : text;
  };
  let headingFallback = "";
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === MEMORY_INDEX_MARKER) continue;
    if (/^#{1,6}\s/.test(trimmed)) {
      headingFallback ||= trimmed.replace(/^#+\s*/, "").trim();
      continue;
    }
    const text = trimmed.replace(/^[-*+]\s*/, "").trim();
    if (text) return clip(text);
  }
  return headingFallback ? clip(headingFallback) : "";
}

/**
 * 把旧的整块记忆按 Markdown 标题切成若干条。没有标题就整块算一条，
 * 内容一个字都不丢——迁移只是换个地方放，不是重写。
 */
export function splitLegacyMemory(content: string): Array<{ title: string; body: string }> {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const headingLevel = /^##\s+/m.test(text) ? 2 : /^#\s+/m.test(text) ? 1 : 0;
  if (headingLevel === 0) return [{ title: "既有记忆", body: text }];
  const heading = headingLevel === 2 ? /^##\s+(.*)$/ : /^#\s+(.*)$/;
  const sections: Array<{ title: string; body: string[] }> = [];
  let preamble: string[] = [];
  for (const line of text.split("\n")) {
    const matched = heading.exec(line);
    if (matched) {
      sections.push({ title: matched[1].trim() || "既有记忆", body: [line] });
      continue;
    }
    if (sections.length === 0) preamble.push(line);
    else sections.at(-1)?.body.push(line);
  }
  const result = sections.map((section) => ({
    title: section.title,
    body: section.body.join("\n").trim(),
  })).filter((section) => section.body);
  const leading = preamble.join("\n").trim();
  if (leading) result.unshift({ title: "既有记忆", body: leading });
  return result.length ? result : [{ title: "既有记忆", body: text }];
}

/** 由标题生成文件名；中文可以直接留在文件名里，只去掉路径不接受的字符。 */
export function memoryEntryFileName(
  title: string,
  taken: ReadonlySet<string>,
  fallbackIndex: number,
): string {
  const cleaned = Array.from(
    title.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^[.\-]+|[.\-]+$/g, ""),
  ).slice(0, FILE_NAME_MAX_CHARS).join("");
  const stem = cleaned || `memory-${fallbackIndex}`;
  let candidate = `${stem}.md`;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${stem}-${suffix}.md`;
    suffix += 1;
  }
  return candidate;
}

/** 索引里指向正文的相对路径，统一用 `/`，Windows 上也一样。 */
export function memoryEntryPath(fileName: string): string {
  return `${MEMORY_ENTRIES_DIRNAME}/${fileName}`;
}
