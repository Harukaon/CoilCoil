/**
 * 窗口拖动带（`-webkit-app-region`）的统一约定，以及让它不会失效的刷新机制。
 *
 * ## 约定（新加 UI 时请照做）
 *
 * 1. 任何一条可以拖动窗口的标题带，都用 `<WindowDragBar />` 在标题栏里铺一层
 *    **空的**拖动层（`.window-drag-layer`，绝对定位铺满、没有任何子节点），
 *    不要再把 `-webkit-app-region: drag` 直接写在标题栏元素上。
 * 2. 拖动层必须是标题栏的**第一个子节点**。Electron 拿到的是一串矩形，按文档
 *    顺序依次做并集（drag）/差集（no-drag）；排在后面的按钮才能在拖动层上挖洞。
 *    把拖动层放到后面，反而会把按钮的位置重新变回可拖动。
 * 3. 标题栏里会随内容长大的东西（标签条、按钮组）必须给拖动层留出一条最小宽度
 *    的空带，见 styles.css 里 `.inspector-drag-surface` 的 `min-width`。否则标签
 *    一多就把整条拖动带占满，看着还是标题栏，实际已经没有一块能按下去了。
 * 4. 只给真正的交互元素标 `no-drag`（`button` / `input` 等已由全局规则覆盖）。
 *    给一个容器标 `no-drag`，等于把它整块从拖动带里挖掉。
 *
 * ## 为什么还需要 refreshWindowDragRegions()
 *
 * Chromium 只有在**某个元素的 `-webkit-app-region` 计算值发生变化**时，才会把
 * 「可拖动矩形列表」标脏并重新收集一遍。以下情况都不会触发重算：
 *
 * - 矩形只是移动或改变大小（面板拉宽、标题多出一行、窗口变高）；
 * - 一个曾经在拖动带上挖过洞的浮层（弹出菜单、右键菜单、提示气泡）被卸载，
 *   洞留在原地，而窗口系统还照着那份旧列表判断。
 *
 * 结果就是标题栏莫名其妙拖不动，而随便 resize 一下窗口（强制重排 + 重算）就好了。
 *
 * 这里不再去枚举「哪些操作会让列表过期」——那是过去几次修复反复漏掉的地方——而是
 * 在**指针进入拖动带时**主动重算一次。窗口系统是在按下鼠标那一刻才去查这份列表的，
 * 而按下之前指针一定先移进来，所以这一下刷新永远赶得上，鼠标不在标题栏时零开销。
 *
 * 重算的办法是翻转一个哨兵元素的 `app-region`（`.window-drag-sentinel`，0×0、在
 * 窗口外）。标脏是整份文档级的，所以翻它一下就够；好处是**任何一条真实的拖动带都
 * 不会有哪怕一帧被关掉**——早期实现是把标题栏自己 toggle 成 no-drag 再还原，那一帧
 * 里按下去就是拖不动的。
 */

/** 指针停在拖动带上时，两次重算之间至少隔这么久。 */
export const HOVER_REFRESH_INTERVAL_MS = 250;

/** 悬停刷新的状态：指针当前是否在拖动带内，以及上一次重算的时间。 */
export interface HoverRefreshState {
  inside: boolean;
  refreshedAt: number;
}

export const initialHoverRefreshState: HoverRefreshState = { inside: false, refreshedAt: 0 };

/**
 * 判断这一次 pointermove 要不要重算拖动矩形。
 *
 * 刚进入拖动带时立刻重算（这一下最关键，紧接着就是按下鼠标）；停在里面不动时按
 * 固定间隔重算，覆盖「指针没动、底下的布局变了」；离开就复位，下次进来又是立刻。
 */
export function nextHoverRefresh(
  state: HoverRefreshState,
  inside: boolean,
  now: number,
): { state: HoverRefreshState; refresh: boolean } {
  if (!inside) return { state: { inside: false, refreshedAt: state.refreshedAt }, refresh: false };
  if (state.inside && now - state.refreshedAt < HOVER_REFRESH_INTERVAL_MS) {
    return { state: { inside: true, refreshedAt: state.refreshedAt }, refresh: false };
  }
  return { state: { inside: true, refreshedAt: now }, refresh: true };
}

const SENTINEL_CLASS = "window-drag-sentinel";
const DRAG_BAND_SELECTOR = ".window-drag";

let sentinel: HTMLElement | undefined;
let sentinelDraggable = false;

function ensureSentinel(target: Document): HTMLElement | undefined {
  if (sentinel?.isConnected && sentinel.ownerDocument === target) return sentinel;
  if (!target.body) return undefined;
  const element = target.createElement("div");
  element.className = SENTINEL_CLASS;
  element.setAttribute("aria-hidden", "true");
  // 初值和 sentinelDraggable 对齐，第一次翻转就一定是一次真实的变化。
  element.style.setProperty("-webkit-app-region", sentinelDraggable ? "drag" : "no-drag");
  target.body.append(element);
  sentinel = element;
  return element;
}

/**
 * 让 Chromium 重新收集一遍可拖动矩形。
 *
 * 尺寸变化、浮层卸载之后调用；调用点不需要知道是哪一条拖动带过期了，收集是整份
 * 文档一起做的。
 */
export function refreshWindowDragRegions(target: Document = document): void {
  const element = ensureSentinel(target);
  if (!element) return;
  sentinelDraggable = !sentinelDraggable;
  element.style.setProperty("-webkit-app-region", sentinelDraggable ? "drag" : "no-drag");
}

/**
 * 装上全局的拖动区刷新：指针进入任意一条 `.window-drag` 带时重算，窗口尺寸变化时
 * 也重算一次（有些拖动带不在 React 树里，例如设置页的标题条）。
 */
export function installWindowDragRegions(target: Document = document): () => void {
  let state = initialHoverRefreshState;
  const onPointerMove = (event: Event): void => {
    const node = event.target;
    const inside = node instanceof Element && node.closest(DRAG_BAND_SELECTOR) !== null;
    const next = nextHoverRefresh(state, inside, performance.now());
    state = next.state;
    if (next.refresh) refreshWindowDragRegions(target);
  };
  const onResize = (): void => refreshWindowDragRegions(target);
  target.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  const view = target.defaultView;
  view?.addEventListener("resize", onResize);
  return () => {
    target.removeEventListener("pointermove", onPointerMove, { capture: true });
    view?.removeEventListener("resize", onResize);
    sentinel?.remove();
    sentinel = undefined;
  };
}
