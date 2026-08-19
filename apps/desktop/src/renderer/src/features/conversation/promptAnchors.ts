/** 面板一行显示的字数上限；再长由 CSS 的省略号接手。 */
export const ANCHOR_EXCERPT_LIMIT = 40;

/** First line of a prompt, trimmed to something that fits one row of the panel. */
export function excerpt(text: string, limit = ANCHOR_EXCERPT_LIMIT): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  if (!line) return "（仅图片）";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
