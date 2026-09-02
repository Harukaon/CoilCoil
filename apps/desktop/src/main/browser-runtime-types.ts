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
