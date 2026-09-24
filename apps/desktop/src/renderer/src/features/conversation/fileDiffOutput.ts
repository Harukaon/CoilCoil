/**
 * edit / write 返回的 diff（workflow 的 file-diff.ts 生成）。
 *
 * 第一行是「已修改 路径（+3 -1）」或「已新建 路径（12 行）」，后面是统一格式的
 * diff。界面按行上色；标签条上的 +N −M 也从这里读——从调用参数里数行数是数不准的：
 * edit 现在传的是 edits[]，write 覆盖旧文件时整份内容都会被当成新增。
 */
export type DiffLineKind = "hunk" | "add" | "del" | "context" | "note";

export interface FileDiffOutput {
  header: string;
  path: string;
  additions: number;
  deletions: number;
  lines: Array<{ kind: DiffLineKind; text: string }>;
}

const MODIFIED = /^已修改 (.+)（\+(\d+) -(\d+)）$/;
const CREATED = /^已新建 (.+)（(\d+) 行）$/;

export function parseFileDiffOutput(toolName: string, output: string): FileDiffOutput | undefined {
  if (toolName !== "edit" && toolName !== "write") return undefined;
  const [header = "", ...rest] = output.split("\n");
  const modified = MODIFIED.exec(header);
  const created = modified ? undefined : CREATED.exec(header);
  if (!modified && !created) return undefined;
  return {
    header,
    path: (modified ?? created)![1]!,
    additions: Number(modified ? modified[2] : created![2]),
    deletions: modified ? Number(modified[3]) : 0,
    lines: rest.map((text) => ({
      kind: text.startsWith("@@") ? "hunk"
        : text.startsWith("+") ? "add"
          : text.startsWith("-") ? "del"
            : text.startsWith(" ") ? "context"
              : "note",
      text,
    })),
  };
}
