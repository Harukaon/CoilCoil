import type { GitCommitFile } from "@coilcoil/runtime-protocol";

const LISTED_FILES = 3;

/**
 * 编辑历史消息时「要不要回退代码」弹窗里的说明：列几个文件名，其余用数量带过。
 * 状态是相对检查点的：A 是那之后新建的（回退会删掉），D 是那之后删掉的（会恢复）。
 */
export function checkpointRewindDescription(files: readonly GitCommitFile[]): string {
  const names = files.slice(0, LISTED_FILES).map((file) => file.path).join("、");
  const more = files.length > LISTED_FILES ? ` 等 ${files.length} 个文件` : "";
  const created = files.some((file) => file.state === "added");
  return [
    `这条消息发出之后，工作区里 ${names}${more} 被改过。`,
    `回退代码会把它们恢复成这条消息发出时的样子${created ? "，之后新建的文件会被删除" : ""}。`,
    "被 .gitignore 忽略的文件（依赖、构建产物）不受影响。",
  ].join("");
}
