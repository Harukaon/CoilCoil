/**
 * 编辑历史消息时「要不要回退代码」弹窗里的说明：只说几个文件，改得再多也是一句话。
 * 回退只管 Agent 用编辑工具改过的文件（见 runtime-core 的 runtime-checkpoints.ts）。
 */
export function checkpointRewindDescription(fileCount: number, skippedCount = 0): string {
  const skipped = skippedCount ? `另有 ${skippedCount} 个文件没有备份（太大或已过期），不会回退。` : "";
  return `这条消息之后 Agent 改动了 ${fileCount} 个文件，回退会把它们恢复到这条消息发出时的样子；其它文件不动。${skipped}`;
}
