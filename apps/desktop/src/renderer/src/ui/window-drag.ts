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
 * 5. 承载拖动层的那个标题栏元素带 `.window-drag-bar`（挂上 `<WindowDragBar />`
 *    时会自动补上）。**刷新机制认的是这个类，不是拖动层本身**——原因见下。
 *
 * ## 为什么还需要 refreshWindowDragRegions()
 *
 * Chromium 只有在**某个元素的 `-webkit-app-region` 计算值发生变化**时，才会把
 * 「可拖动矩形列表」标脏并重新收集一遍。以下情况都不会触发重算：
 *
 * - 矩形只是移动或改变大小（面板拉宽、标题多出一行、窗口变高）；
 * - 一个曾经在拖动带上挖过洞的浮层（弹出菜单、右键菜单、设置弹窗）被卸载，
 *   洞留在原地，而窗口系统还照着那份旧列表判断。
 *
 * 结果就是标题栏莫名其妙拖不动，而随便 resize 一下窗口（强制重排 + 重算）就好了。
 *
 * ## 刷新是怎么保证「一定赶得上」的
 *
 * 窗口系统是在按下鼠标那一刻才去查这份列表的，所以只要在按下之前重算过就来得及。
 * 按下之前一定发生的事只有两件：指针移进标题栏，以及标题栏本身有过变化。于是这里
 * 就盯这两件事，而不是去枚举「哪些操作会让列表过期」——那正是过去几次修复反复漏掉
 * 的地方：
 *
 * - **指针在标题栏上（或者在窗口最顶上那条里）** → 立刻重算。判定用的是标题栏
 *   容器 `.window-drag-bar`，不是拖动层元素。上一版认的是拖动层，可是拖动层被
 *   压在内容底下，指针实际命中的往往是盖在它上面的东西（右侧栏那条空带
 *   `.inspector-drag-surface`、技能/记忆/任务页标题栏里包标题的那个 div），于是
 *   那几条标题栏**一次都没刷新过**——恰好就是用户报的失效位置。
 * - **标题栏自己变了**（尺寸、里面多出或少掉一个按钮、标签开了关了、标题文字变长）
 *   → 重算。见 observeWindowDragBar()。
 * - **body 上多出或少掉一个直接子节点** → 重算。弹窗、右键菜单、下拉浮层都是
 *   portal 到 body 底下的，它们关掉时留下的洞就是「标题栏整条按不动」的来源。
 *
 * 重算的办法是翻转一个哨兵元素的 `app-region`（`.window-drag-sentinel`，0×0、在
 * 窗口外）。标脏是整份文档级的，所以翻它一下就够；好处是**任何一条真实的拖动带都
 * 不会有哪怕一帧被关掉**——早期实现是把标题栏自己 toggle 成 no-drag 再还原，那一帧
 * 里按下去就是拖不动的。
 */

/** 指针停在拖动带上时，两次重算之间至少隔这么久。 */
export const HOVER_REFRESH_INTERVAL_MS = 250;

/**
 * 窗口最顶上这条里必然坐着某条标题栏（最高的一条是会话头 56px）。指针一进这条
 * 就重算，不去管它此刻压在哪个元素上——比逐个元素判定少一层出错的机会，也让刷新
 * 提前到指针真正走到拖动带之前。
 */
export const TITLE_BAR_STRIP_PX = 56;

/** 悬停刷新的状态：指针当前是否在拖动带内，以及上一次重算的时间。 */
export interface HoverRefreshState {
  inside: boolean;
  refreshedAt: number;
}

export const initialHoverRefreshState: HoverRefreshState = { inside: false, refreshedAt: 0 };

/**
 * 这一次指针事件算不算「压在标题栏上」。
 *
 * 两个条件是或的关系：要么指针的祖先里有一条标题栏，要么它落在窗口顶上那条里。
 * 后者是兜底——将来谁加了一条标题栏却忘了标 `.window-drag-bar`，顶部那条也还在。
 */
export function isDragBarPoint(hasDragBarAncestor: boolean, clientY: number): boolean {
  return hasDragBarAncestor || clientY <= TITLE_BAR_STRIP_PX;
}

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
/** 标题栏容器的标记类，observeWindowDragBar() 会自动补上。 */
export const DRAG_BAR_CLASS = "window-drag-bar";
/** `.window-drag` 也算：设置页和气泡窗的标题栏还是老写法，直接标在容器上。 */
const DRAG_BAR_SELECTOR = `.${DRAG_BAR_CLASS}, .window-drag`;

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

/** 把同一帧里的多次请求合并成一次重算。 */
function coalescedRefresh(target: Document): { run: () => void; cancel: () => void } {
  const view = target.defaultView;
  let frame = 0;
  return {
    run: () => {
      if (frame || !view) return;
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        refreshWindowDragRegions(target);
      });
    },
    cancel: () => {
      if (frame && view) view.cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

/**
 * 盯住一条标题栏，它一变就把拖动矩形标脏。
 *
 * 尺寸变化（拉面板、收侧栏、缩窗口）和内容变化（多出一个按钮、开关一个标签页、
 * 标题文字变长）都会挪动这条标题栏里那些 no-drag 的洞，而 Chromium 对这两类变化
 * 都不会自己重算。顺手把 `.window-drag-bar` 补到容器上，这样「哪些元素是标题栏」
 * 只由挂不挂 `<WindowDragBar />` 决定，不会有谁忘了写类名。
 */
export function observeWindowDragBar(bar: Element, target: Document = document): () => void {
  bar.classList.add(DRAG_BAR_CLASS);
  const refresh = coalescedRefresh(target);
  const resize = new ResizeObserver(refresh.run);
  resize.observe(bar);
  const mutation = new MutationObserver(refresh.run);
  mutation.observe(bar, { attributes: true, characterData: true, childList: true, subtree: true });
  refresh.run();
  return () => {
    resize.disconnect();
    mutation.disconnect();
    refresh.cancel();
  };
}

/**
 * 装上全局的拖动区刷新。
 *
 * 四条触发都指向同一个目标：**在鼠标按下之前，那份矩形列表一定是新的**。
 */
export function installWindowDragRegions(target: Document = document): () => void {
  const view = target.defaultView;
  let state = initialHoverRefreshState;
  // 先把哨兵挂上：它要先以某个值真正算过一次样式，之后的翻转才算「值变了」。
  ensureSentinel(target);

  const overDragBar = (event: Event): boolean => {
    const node = event.target;
    const hasBar = node instanceof Element && node.closest(DRAG_BAR_SELECTOR) !== null;
    const clientY = event instanceof MouseEvent ? event.clientY : Number.POSITIVE_INFINITY;
    return isDragBarPoint(hasBar, clientY);
  };

  const onPointerMove = (event: Event): void => {
    const next = nextHoverRefresh(state, overDragBar(event), performance.now());
    state = next.state;
    if (next.refresh) refreshWindowDragRegions(target);
  };
  // 能收到这一下，就说明系统没把它当成拖窗口——列表是旧的。当场重算，并且把悬停
  // 状态清掉，紧接着的下一次尝试一定用的是新列表。
  const onPointerDown = (event: Event): void => {
    if (!overDragBar(event)) return;
    state = initialHoverRefreshState;
    refreshWindowDragRegions(target);
  };
  const onResize = (): void => refreshWindowDragRegions(target);

  target.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  target.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  view?.addEventListener("resize", onResize);

  // 弹窗、右键菜单、下拉浮层都是 portal 到 body 底下的。它们里面的按钮在标题栏上
  // 挖过洞，关掉时洞会留在旧列表里——这就是「开过一次菜单，标题栏整条按不动」。
  const bodyRefresh = coalescedRefresh(target);
  const bodyObserver = target.body ? new MutationObserver(bodyRefresh.run) : undefined;
  if (target.body && bodyObserver) bodyObserver.observe(target.body, { childList: true });

  return () => {
    target.removeEventListener("pointermove", onPointerMove, { capture: true });
    target.removeEventListener("pointerdown", onPointerDown, { capture: true });
    view?.removeEventListener("resize", onResize);
    bodyObserver?.disconnect();
    bodyRefresh.cancel();
    sentinel?.remove();
    sentinel = undefined;
  };
}
