/**
 * edit / write 的返回换成这次改动的真实 diff。
 *
 * Pi 自带的两个工具只回一句「Successfully replaced 1 block(s) in …」「Successfully
 * wrote to …」：模型看不到自己到底改成了什么，界面上的「执行结果」也只有这一句。
 * 这里在执行前记下文件原来的内容，执行后读新内容，生成统一格式的 diff 替换那句话。
 * 开头一行说清改了哪个文件、加减几行；diff 太长就截断，新建一个大文件时不至于把
 * 整个文件又原样塞回给模型。
 *
 * 读不到、太大、像二进制的文件，或者工具本身失败了，都保留原来的返回。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { structuredPatch } from "diff";

export const MAX_DIFF_LINES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 读文件原文；不存在是 null，读不了或不该做 diff（太大、二进制）是 undefined。 */
function readForDiff(path: string): string | null | undefined {
  try {
    if (!existsSync(path)) return null;
    if (statSync(path).size > MAX_FILE_BYTES) return undefined;
    const text = readFileSync(path, "utf8");
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

export interface FileDiff {
  text: string;
  additions: number;
  deletions: number;
  created: boolean;
}

/** 生成给模型和界面看的 diff 文本；没有变化返回 undefined。 */
export function renderFileDiff(displayPath: string, before: string | null, after: string, maxLines = MAX_DIFF_LINES): FileDiff | undefined {
  if (before === after) return undefined;
  const created = before === null;
  const patch = structuredPatch(displayPath, displayPath, before ?? "", after, "", "", { context: 3 });
  let additions = 0;
  let deletions = 0;
  const body: string[] = [];
  for (const hunk of patch.hunks) {
    body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue; // 「\ No newline at end of file」对读的人没有信息量
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
      body.push(line);
    }
  }
  const head = created
    ? `已新建 ${displayPath}（${additions} 行）`
    : `已修改 ${displayPath}（+${additions} -${deletions}）`;
  const shown = body.length > maxLines
    ? [...body.slice(0, maxLines), `……diff 共 ${body.length} 行，只显示前 ${maxLines} 行`]
    : body;
  return { text: [head, ...shown].join("\n"), additions, deletions, created };
}

function inputPath(input: Record<string, unknown>): string | undefined {
  const value = input.path ?? input.file_path;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export default function fileDiffExtension(pi: ExtensionAPI): void {
  /** toolCallId → 执行前的文件：绝对路径、给人看的路径、原内容。 */
  const pending = new Map<string, { path: string; display: string; before: string | null }>();

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const raw = inputPath(event.input as Record<string, unknown>);
    if (!raw) return;
    const path = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
    const before = readForDiff(path);
    if (before === undefined) return;
    const fromCwd = relative(ctx.cwd, path);
    const display = fromCwd && !fromCwd.startsWith("..") && !isAbsolute(fromCwd) ? fromCwd : path;
    pending.set(event.toolCallId, { path, display, before });
  });

  pi.on("tool_result", (event) => {
    const entry = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!entry || event.isError) return;
    const after = readForDiff(entry.path);
    if (typeof after !== "string") return;
    const diff = renderFileDiff(entry.display, entry.before, after);
    if (!diff) return;
    return {
      content: [{ type: "text", text: diff.text }],
      details: {
        ...(event.details && typeof event.details === "object" ? event.details : {}),
        fileDiff: { path: entry.display, additions: diff.additions, deletions: diff.deletions, created: diff.created },
      },
    };
  });
}
