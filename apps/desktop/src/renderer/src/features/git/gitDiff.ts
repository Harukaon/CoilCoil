/**
 * 把 `git diff` 的输出拆成界面画得出来的行：单栏按原样排，左右对照把删除和新增
 * 配成一行行。行号从 hunk 头上算出来，两种视图用的是同一份解析结果。
 */
export type DiffRowKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffRowKind;
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldNumber = 0;
  let newNumber = 0;
  // git 的上下文行一定以空格开头；结尾换行切出来的那个空串不是一行。
  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    const header = HUNK.exec(raw);
    if (header) {
      oldNumber = Number(header[1]);
      newNumber = Number(header[2]);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // diff --git / index / --- / +++ 这些文件头
    if (raw.startsWith("+")) current.lines.push({ kind: "add", text: raw.slice(1), newNumber: newNumber++ });
    else if (raw.startsWith("-")) current.lines.push({ kind: "del", text: raw.slice(1), oldNumber: oldNumber++ });
    else if (raw.startsWith(" ")) current.lines.push({ kind: "context", text: raw.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ });
    // 其余（「\ No newline at end of file」）不是内容行。
  }
  return hunks;
}

export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

/** 左右对照：上下文两边都有；一段连续的删除和紧跟着的新增按顺序配对。 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < hunk.lines.length) {
    const line = hunk.lines[index]!;
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (hunk.lines[index]?.kind === "del") deletions.push(hunk.lines[index++]!);
    while (hunk.lines[index]?.kind === "add") additions.push(hunk.lines[index++]!);
    for (let pair = 0; pair < Math.max(deletions.length, additions.length); pair += 1) {
      rows.push({ left: deletions[pair], right: additions[pair] });
    }
  }
  return rows;
}

export function diffStats(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions += 1;
      else if (line.kind === "del") deletions += 1;
    }
  }
  return { additions, deletions };
}
