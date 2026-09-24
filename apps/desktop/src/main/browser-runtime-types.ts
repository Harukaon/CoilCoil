import type { WebContents } from "electron";
import type { BrowserTabOwner } from "./browser-agent-tabs";

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
  /** 谁开的这张：Agent 开的会被上限收掉、在标签条上带 Agent 标识；用户开的永远不动。 */
  owner: BrowserTabOwner;
  /** 最近一次被 Agent 操作或被选中的时间，上限收页时先关最久没用的。 */
  lastUsedAt: number;
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
 * 界面只显示当前会话的标签页。
 *
 * scope 是给 CDP 客户端划的发现边界（一个会话一个），界面也必须遵守同一条边界。把
 * 别的会话的页面拼进来，标签页就会在会话之间窜来窜去，看起来像几个会话共用了同一个
 * 浏览器。
 *
 * 后台会话的 Agent 仍然可以在自己的 scope 里继续加载页面；它们不会因为用户切换会话
 * 而被关闭，只是不混进当前会话的可见标签条。
 */
export function orderTabsForUi<T extends { scopeId: string }>(
  tabs: Iterable<T>,
  scopeId: string,
): Array<{ tab: T; foreign: boolean }> {
  return [...tabs]
    .filter((tab) => tab.scopeId === scopeId)
    .map((tab) => ({ tab, foreign: false }));
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
