import { CARET_WORLD_ID } from "./browser-page-caret";

/**
 * 网页的悬停提示（元素的 title、SVG 里的 <title>）。
 *
 * 离屏页面里浏览器不画这个提示，Electron 也不报。面板在鼠标停住一会儿后问一下网页「这个位置
 * 有没有提示」，有就自己画出来（LivePageSurface）。规则和浏览器一样：从指到的元素往上找第一个
 * 带 title 的；title 是空的元素挡住外层的提示；SVG 用它里面的 <title>；同源的内嵌页和打开的
 * shadow DOM 一层层往里找，跨源的内嵌页看不进去就不出提示。
 *
 * 和光标位置用同一个隔离环境（见 browser-page-caret.ts）：网页自己的脚本看不见它，只读不改，
 * 不走和 Agent 共用的调试通道。
 *
 * 这是一段字符串，原样送进页面：里面不能有反引号和模板占位，反斜杠要写两个。
 */
export const TOOLTIP_SCRIPT = `((x, y) => {
  const px = (value) => parseFloat(value) || 0;
  let doc = document;
  let el = doc.elementFromPoint(x, y);
  for (let depth = 0; el && depth < 16; depth += 1) {
    if (el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (inner && inner !== el) { el = inner; continue; }
    }
    if (el.tagName !== "IFRAME" && el.tagName !== "FRAME") break;
    let inner = null;
    try { inner = el.contentDocument; } catch (error) { inner = null; }
    if (!inner) return null;
    const box = el.getBoundingClientRect();
    const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    x -= box.left + el.clientLeft + px(style.paddingLeft);
    y -= box.top + el.clientTop + px(style.paddingTop);
    doc = inner;
    el = doc.elementFromPoint(x, y);
  }
  for (let node = el, steps = 0; node && steps < 200; steps += 1) {
    if (node.nodeType === 1) {
      if (node.namespaceURI === "http://www.w3.org/2000/svg") {
        const title = Array.from(node.children || []).find((child) => String(child.tagName).toLowerCase() === "title");
        const text = title ? String(title.textContent || "").trim() : "";
        if (text) return text;
      }
      const attribute = node.getAttribute ? node.getAttribute("title") : null;
      if (attribute !== null) return attribute.trim() ? attribute : null;
    }
    const root = node.getRootNode ? node.getRootNode() : null;
    node = node.parentElement || (root && root.host) || null;
  }
  return null;
})`;

/** 页面回来的提示逐项核对：只要字符串，太长的截断，全是空白的不要。 */
export function parseTooltip(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n?/g, "\n").slice(0, 1000);
  return text.trim() ? text : null;
}

/** 问页面这个位置（页面窗口的像素）有没有提示。页面卡住时等一小会儿就算了。 */
export async function readPageTooltip(
  contents: {
    executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<unknown>;
    getZoomFactor(): number;
  },
  point: { x: number; y: number },
  timeoutMs = 300,
): Promise<string | null> {
  // 页面放大缩小过的话，网页里的坐标要除以缩放倍数。
  const zoom = contents.getZoomFactor() || 1;
  const code = `${TOOLTIP_SCRIPT}(${JSON.stringify(point.x / zoom)}, ${JSON.stringify(point.y / zoom)})`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    const result = await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(CARET_WORLD_ID, [{ code }]).catch(() => null),
      late,
    ]);
    return parseTooltip(result);
  } finally {
    clearTimeout(timer);
  }
}
