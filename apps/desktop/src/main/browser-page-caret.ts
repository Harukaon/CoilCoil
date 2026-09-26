import type { BrowserCaret } from "../shared/desktop-api";

/**
 * 输入法候选框跟着页面里的光标走。
 *
 * 用户在面板里打字时，键盘先落在面板上一个看不见的输入框（焦点代理）里，系统的输入法
 * 候选框就出现在这个输入框旁边。这里问页面「光标现在在哪儿」，面板把焦点代理挪过去，
 * 候选框就出现在用户打字的地方，而不是停在他最后点的那一下。
 *
 * 脚本跑在页面的一个隔离环境里（和浏览器插件一样）：页面自己的脚本看不见它、也改不了
 * 它用的东西；它不改页面的 DOM，只量一量——输入框里的字多宽，用离屏画布按同样的字体量。
 * 不走调试通道：那条是和 Agent 共用的，这里不去碰。
 */

/** 这个隔离环境的编号：0 是网页自己，999 是 Electron 预加载用的，挑一个不冲突的。 */
export const CARET_WORLD_ID = 1031;

/**
 * 在页面里算光标位置（页面坐标，CSS 像素）。不在能打字的地方就是 null，面板留在用户点的地方。
 *
 * - 输入框：字体、内边距、滚动都算上，量光标前面那段字有多宽；密码框按圆点量。
 * - 多行文本框：按宽度把字折成行（和浏览器一样按词折，一个词比一行还长时按字折），
 *   算光标在第几行、行里多宽。
 * - 可编辑区域（富文本编辑器）：直接取选区的位置。
 * - 同源的内嵌页一层层往里找；跨源的看不进去，交回 null。
 *
 * 这是一段字符串，原样送进页面：里面不能有反引号和模板占位，反斜杠要写两个。
 */
export const CARET_SCRIPT = `(() => {
  const px = (value) => parseFloat(value) || 0;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  let dx = 0;
  let dy = 0;
  let el = document.activeElement;
  for (let depth = 0; el && (el.tagName === "IFRAME" || el.tagName === "FRAME"); depth += 1) {
    let inner = null;
    try { inner = el.contentDocument; } catch (error) { inner = null; }
    if (!inner || depth > 8) return null;
    const frame = el.getBoundingClientRect();
    const frameStyle = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    dx += frame.left + el.clientLeft + px(frameStyle.paddingLeft);
    dy += frame.top + el.clientTop + px(frameStyle.paddingTop);
    el = inner.activeElement;
  }
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || !el.ownerDocument) return null;
  const doc = el.ownerDocument;
  const view = doc.defaultView || window;
  const style = view.getComputedStyle(el);
  const fontSize = px(style.fontSize) || 16;
  const lineHeight = px(style.lineHeight) || Math.round(fontSize * 1.2);
  const done = (x, y, height) => ({ x: Math.round(x + dx), y: Math.round(y + dy), height: Math.max(1, Math.round(height)) });
  const isInput = el.tagName === "INPUT" && ["text", "search", "url", "tel", "password", "email", "number"].includes(el.type);
  if (isInput || el.tagName === "TEXTAREA") {
    const box = el.getBoundingClientRect();
    const left = box.left + el.clientLeft + px(style.paddingLeft);
    const top = box.top + el.clientTop + px(style.paddingTop);
    const width = Math.max(1, el.clientWidth - px(style.paddingLeft) - px(style.paddingRight));
    const height = Math.max(1, el.clientHeight - px(style.paddingTop) - px(style.paddingBottom));
    let caret = null;
    try { caret = el.selectionDirection === "backward" ? el.selectionStart : el.selectionEnd; } catch (error) { caret = null; }
    const value = String(el.value || "");
    const context = value.length > 20000 || typeof OffscreenCanvas !== "function" ? null : new OffscreenCanvas(1, 1).getContext("2d");
    if (!context) return done(left, top, Math.min(height, lineHeight));
    context.font = style.font || [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(" ");
    if (style.letterSpacing && style.letterSpacing !== "normal" && "letterSpacing" in context) context.letterSpacing = style.letterSpacing;
    const measure = (text) => context.measureText(text).width;
    const shown = el.type === "password" ? "\\u2022".repeat(value.length) : value;
    const before = typeof caret === "number" ? shown.slice(0, caret) : shown;
    const rtl = style.direction === "rtl";
    if (isInput) {
      const full = measure(shown);
      let x = rtl ? left + width - measure(before) : left + measure(before) - el.scrollLeft;
      const align = style.textAlign;
      if (!rtl && full < width) {
        if (align === "center" || align === "-webkit-center") x += (width - full) / 2;
        else if (align === "right" || align === "end" || align === "-webkit-right") x += width - full;
      }
      const caretHeight = Math.min(height, Math.max(lineHeight, fontSize));
      return done(clamp(x, left, left + width), top + (height - caretHeight) / 2, caretHeight);
    }
    const wraps = style.whiteSpace !== "pre" && style.whiteSpace !== "nowrap" && el.getAttribute("wrap") !== "off";
    const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
    let row = 0;
    let rowWidth = 0;
    before.split("\\n").forEach((line, index) => {
      if (index > 0) { row += 1; rowWidth = 0; }
      if (!wraps) { rowWidth = measure(line); return; }
      const parts = segmenter ? Array.from(segmenter.segment(line), (part) => part.segment) : line.split(" ").flatMap((word, at) => (at ? [" ", word] : [word]));
      for (const part of parts) {
        if (!part) continue;
        const partWidth = measure(part);
        if (part.trim() === "") { rowWidth += partWidth; continue; }
        if (rowWidth > 0 && rowWidth + partWidth > width) { row += 1; rowWidth = 0; }
        if (partWidth <= width) { rowWidth += partWidth; continue; }
        for (const char of part) {
          const charWidth = measure(char);
          if (rowWidth > 0 && rowWidth + charWidth > width) { row += 1; rowWidth = 0; }
          rowWidth += charWidth;
        }
      }
    });
    const x = rtl ? left + width - rowWidth : left + rowWidth - el.scrollLeft;
    const y = top + row * lineHeight - el.scrollTop;
    return done(clamp(x, left, left + width), clamp(y, top, top + Math.max(0, height - lineHeight)), lineHeight);
  }
  const editable = el.isContentEditable || doc.designMode === "on";
  const selection = editable && doc.getSelection ? doc.getSelection() : null;
  if (!selection || !selection.focusNode) return null;
  const range = doc.createRange();
  try { range.setStart(selection.focusNode, selection.focusOffset); } catch (error) { return null; }
  range.collapse(true);
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1] : null;
  if (rect && rect.height > 0) return done(rect.left, rect.top, rect.height);
  const holder = selection.focusNode.nodeType === 1 ? selection.focusNode : selection.focusNode.parentElement;
  if (!holder || !holder.getBoundingClientRect) return null;
  const holderBox = holder.getBoundingClientRect();
  const holderStyle = view.getComputedStyle(holder);
  const holderLine = px(holderStyle.lineHeight) || Math.round((px(holderStyle.fontSize) || 16) * 1.2);
  return done(holderBox.left + px(holderStyle.borderLeftWidth) + px(holderStyle.paddingLeft), holderBox.top + px(holderStyle.borderTopWidth) + px(holderStyle.paddingTop), holderLine);
})()`;

/** 页面回来的位置逐项核对：脚本跑在网页的进程里，回来的东西不能全信。 */
export function parseCaret(value: unknown): BrowserCaret | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, height } = value as Record<string, unknown>;
  const finite = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 100_000;
  if (!finite(x) || !finite(y) || !finite(height) || height <= 0) return null;
  return { x, y, height: Math.min(height, 400) };
}

/** 问页面光标在哪儿。页面卡住（比如停在网页对话框上）时脚本跑不了，等一小会儿就算了。 */
export async function readPageCaret(
  contents: { executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<unknown> },
  timeoutMs = 300,
): Promise<BrowserCaret | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    const result = await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(CARET_WORLD_ID, [{ code: CARET_SCRIPT }]).catch(() => null),
      late,
    ]);
    return parseCaret(result);
  } finally {
    clearTimeout(timer);
  }
}
