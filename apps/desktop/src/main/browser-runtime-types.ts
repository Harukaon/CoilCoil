import type { WebContents } from "electron";

export const DEFAULT_BROWSER_URL = "about:blank";
export const DEFAULT_BROWSER_SCOPE_ID = "default";
export const BROWSER_TARGET_ID = "coilcoil-browser";
export const BROWSER_CONTEXT_ID = "coilcoil-browser-context";

/** Logical size used while a guest is parked in its 1x1 renderer slot. */
export const DEFAULT_BROWSER_VIEWPORT = { width: 1280, height: 720 };

export interface BrowserTab {
  id: string;
  scopeId: string;
  /**
   * 这张标签页所属的 cookie jar（一个工作区一份）。
   *
   * 记在标签页上而不是记在窗口上：guest 的分区创建时就定死了，改不了，所以换工作
   * 区时不能拿窗口当前那份去套老标签页——各自带着自己那份活着，切回去还在。
   */
  partition: string;
  tabTargetId: string;
  pageTargetId: string;
  guest?: WebContents;
  guestNonce: string;
  phase: "awaiting-guest" | "loading" | "ready" | "closing";
  announced: boolean;
  /**
   * 这张空白页是桥自己开出来的，agent 并没有要过。
   *
   * 一个 CDP 客户端刚连上来就会问浏览器版本、列目标，这两条都得有一个页面才答得
   * 出来，于是桥先垫一张空白页。垫出来的这张只要还停在 about:blank，下一次
   * `Target.createTarget`（也就是 agent 的 new_page）就直接拿它用，不再开第二张
   * ——否则每个会话都是「一张没人要的空白页 + 一张真正在用的页」起步。
   * 标记本身不会随导航清掉，因为「能不能拿去用」每次都拿当前地址现算：只要它已经
   * 导航到别处，就不再是空白页，也就不会被接管。
   */
  implicit?: boolean;
  emulatedSize?: { width: number; height: number };
}

/**
 * 这张标签页可以直接拿去当 agent 要的那张新标签页吗。
 *
 * 只认桥自己垫出来的、已经就绪的、而且还停在空白页上的那一张。导航过的一律不算
 * ——那时候它已经是一张在用的页了，替 agent 把它导航走会把用户看着的东西换掉。
 */
export function isReusableBlankTab(
  tab: Pick<BrowserTab, "implicit" | "phase">,
  url: string | undefined,
): boolean {
  if (!tab.implicit || tab.phase !== "ready") return false;
  return !url || /^about:blank$/i.test(url);
}

/**
 * 界面要看到的那一排标签页：自己的在前，别的会话的跟在后面并标出来。
 *
 * scope 是给 CDP 客户端划的发现边界——一个后台会话的 agent 不该看见另一个会话的
 * 页面。但同一条边界被原样套在界面上之后，agent 在别的 scope 里开的标签页对用户就
 * 是隐形的：页面在加载、脚本在跑、cookie 在写，用户屏幕上什么都没有，点不到也关
 * 不掉。发现归发现，用户归用户，所以这里把全部标签页交出去。
 *
 * 顺序有意这么排：自己的那几张保持原来的次序和位置，别人的追加在后面，标签条不会
 * 因为别的会话开了一张页面就整排错位。
 */
export function orderTabsForUi<T extends { scopeId: string }>(
  tabs: Iterable<T>,
  scopeId: string,
): Array<{ tab: T; foreign: boolean }> {
  const all = [...tabs];
  return [
    ...all.filter((tab) => tab.scopeId === scopeId).map((tab) => ({ tab, foreign: false })),
    ...all.filter((tab) => tab.scopeId !== scopeId).map((tab) => ({ tab, foreign: true })),
  ];
}

export function browserContextId(scopeId: string): string {
  return `${BROWSER_CONTEXT_ID}:${scopeId}`;
}

export function browserTargetInfo(tab: BrowserTab, kind: "tab" | "page"): Record<string, unknown> {
  const contents = tab.guest;
  if (!contents || contents.isDestroyed()) throw new Error("内置浏览器视图不可用。");
  return {
    targetId: kind === "tab" ? tab.tabTargetId : tab.pageTargetId,
    type: kind,
    title: contents.getTitle() || "新标签页",
    url: contents.getURL() || DEFAULT_BROWSER_URL,
    attached: true,
    canAccessOpener: false,
    browserContextId: browserContextId(tab.scopeId),
  };
}
