/** 编辑历史消息时「要不要回退代码」弹窗里的说明：只说几个文件，改得再多也是一句话。 */
export function checkpointRewindDescription(fileCount: number): string {
  return `这条消息之后改动了 ${fileCount} 个文件，回退会把它们恢复到这条消息发出时的样子。`;
}
