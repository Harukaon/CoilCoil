/**
 * 记录「标题栏这一刻拖不动」的现场。只记录，不修复。
 *
 * ## 为什么需要它
 *
 * 「标题栏偶尔拖不动」是个薛定谔式的故障：只要界面保持不动它就一直坏着，而任何
 * 一点变化（改窗口大小、某个按钮出现或消失、随手按一下别处）都会让它自己恢复。
 * 所以出事的时候既看不见、也问不出来——等你去看它，它已经好了。用户 2026-09-18
 * 的原话：「状态不变它就是坏的，状态一变它就恢复，像薛定谔的猫」。
 *
 * 机制上对得上：Blink 每次布局之后重新收集一遍可拖动矩形，**和上一次逐条比对，
 * 一样就不发**。于是只要窗口那边手上那份是坏的，界面又一动不动，就永远等不到下
 * 一次推送；一有变化，清单跟上次不同，重新发一次，就好了。
 *
 * ## 判据
 *
 * 一次左键按下落在「按我们自己这份清单算应该是可拖动」的位置上，**而网页居然收到
 * 了这一下**——正常能拖的时候这一下会被系统截走，网页什么都收不到。所以收到就等于
 * 失效正在发生。这是唯一不需要改变任何状态就能观测到它的办法。
 *
 * 这里不做任何补救。想知道为什么不补救，看 ui/WindowDragBar.tsx 的文件头。
 */
import { diagnostics } from "../diagnostics";

/** 一条矩形，和 Electron 收到的那串一一对应。 */
export interface DragRegion {
  element: string;
  draggable: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 两次记录之间至少隔这么久，按不动时连按几下不至于刷屏。 */
export const REPORT_INTERVAL_MS = 2_000;

function label(element: Element): string {
  const raw = typeof element.className === "string" ? element.className : "";
  const classes = raw.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
  return element.tagName.toLowerCase() + (classes ? `.${classes}` : "");
}

/**
 * 按 Chromium 收集可拖动矩形的规则走一遍文档。
 *
 * 跳过 `visibility: hidden` 和非盒元素（纯 inline 标了 app-region 等于没标），
 * 不按 overflow 裁剪——被滚出可视区、肉眼看不见的元素照样占着它那块矩形。
 */
export function collectDragRegions(target: Document = document): DragRegion[] {
  const regions: DragRegion[] = [];
  const walk = (element: Element): void => {
    const style = target.defaultView?.getComputedStyle(element);
    const mode = style?.getPropertyValue("-webkit-app-region");
    if (style && mode && mode !== "none" && style.visibility === "visible") {
      const display = style.display;
      if (display !== "inline" && display !== "contents" && display !== "none") {
        const box = element.getBoundingClientRect();
        regions.push({
          element: label(element),
          draggable: mode === "drag",
          left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        });
      }
    }
    for (const child of element.children) walk(child);
  };
  if (target.documentElement) walk(target.documentElement);
  return regions;
}

/**
 * 这一点归谁。
 *
 * Electron 把这串矩形按顺序做并集（drag）/差集（no-drag）落成一个区域，对单点来说
 * 就等于：**最后一个盖住它的矩形说了算**。
 */
export function regionAt(regions: DragRegion[], x: number, y: number): DragRegion | undefined {
  let winner: DragRegion | undefined;
  for (const region of regions) {
    if (x >= region.left && x < region.right && y >= region.top && y < region.bottom) winner = region;
  }
  return winner;
}

/**
 * 这一下按下该不该被记成一次失效。
 *
 * 右键和 Ctrl+左键要排除：Electron 自己会在这两种按下期间整个关掉拖动区，让右键
 * 菜单能弹出来，那一下落到网页上是正常的。
 */
export function isDragPressLeak(button: number, ctrlKey: boolean, winner: DragRegion | undefined): boolean {
  if (button !== 0 || ctrlKey) return false;
  return winner?.draggable === true;
}

/** 装上记录器。返回卸载函数。 */
export function installWindowDragFailureReport(target: Document = document): () => void {
  let reportedAt = 0;
  const onMouseDown = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return;
    const now = performance.now();
    if (now - reportedAt < REPORT_INTERVAL_MS) return;
    const regions = collectDragRegions(target);
    const winner = regionAt(regions, event.clientX, event.clientY);
    if (!isDragPressLeak(event.button, event.ctrlKey, winner)) return;
    reportedAt = now;
    const view = target.defaultView;
    const scroller = target.scrollingElement;
    diagnostics.warn("window-drag", "drag_press_reached_page", {
      point: { x: Math.round(event.clientX), y: Math.round(event.clientY) },
      // 我们这边算出来它该是可拖的，可这一下还是落到了网页上。
      expected: winner,
      regionCount: regions.length,
      dragRegions: regions.filter((region) => region.draggable),
      // 下面这些是用来找「窗口那边那份为什么会对不上」的线索。
      viewport: { width: view?.innerWidth, height: view?.innerHeight },
      outer: { width: view?.outerWidth, height: view?.outerHeight },
      screenPosition: { x: view?.screenX, y: view?.screenY },
      devicePixelRatio: view?.devicePixelRatio,
      rootScroll: { top: scroller?.scrollTop ?? 0, left: scroller?.scrollLeft ?? 0 },
      visibility: target.visibilityState,
      focused: target.hasFocus(),
      // 全屏时 Electron 本来就不接拖动，这一条能把那种情况摘出去。
      looksFullscreen: view ? view.outerHeight >= view.screen.height : undefined,
      activeElement: target.activeElement ? label(target.activeElement) : undefined,
      selectionEmpty: view?.getSelection()?.isCollapsed ?? true,
    });
  };
  target.addEventListener("mousedown", onMouseDown, { capture: true, passive: true });
  return () => target.removeEventListener("mousedown", onMouseDown, { capture: true });
}
