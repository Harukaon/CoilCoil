import type { BrowserWindow, WebContents } from "electron";
import type { BrowserTabOwner } from "./browser-agent-tabs";

export const DEFAULT_BROWSER_URL = "about:blank";
export const DEFAULT_BROWSER_SCOPE_ID = "default";
export const BROWSER_TARGET_ID = "coilcoil-browser";
export const BROWSER_CONTEXT_ID = "coilcoil-browser-context";

/** 用户没在看的标签页的视口：常见的桌面尺寸（AI 截图、操作都按这个）。 */
export const DEFAULT_BROWSER_VIEWPORT = { width: 1280, height: 720 };

export interface BrowserTab {
  id: string;
  scopeId: string;
  /**
   * 这张标签页所属的 cookie jar（一个工作区一份）。
   *
   * 记在标签页上而不是记在窗口上：页面的分区创建时就定死了，改不了，所以换工作区时
   * 不能拿窗口当前那份去套老标签页——各自带着自己那份活着，切回去还在。
   */
  partition: string;
  /**
   * 谁开的这张（标签条上的标识、上限回收用）。用户和 Agent 都能直接用任何一张，不用
   * 接管：Agent 点击、打字只进这个离屏页面，碰不到用户的焦点（见 browser-offscreen.ts）。
   */
  owner: BrowserTabOwner;
  /** 承载这个页面的隐藏离屏窗口（每张标签页一个）。 */
  offscreen?: BrowserWindow;
  /** 最近一次被 Agent 操作或被选中的时间，用于选择最近使用的页面。 */
  lastUsedAt: number;
  tabTargetId: string;
  pageTargetId: string;
  /** 页面本身（离屏窗口的 webContents）。 */
  guest?: WebContents;
  /** 离屏页面正在建 → 在打开第一个网址 → 能用了 → 在关。 */
  phase: "creating" | "loading" | "ready" | "closing";
  /** Agent 最近一次在这张页面上动手的时间（导航、点击、打字、截图、读快照）：面板据此提示「正在操作」。 */
  agentActiveAt?: number;
  announced: boolean;
  /** Automatic UI/protocol placeholder, never an explicit user or Agent new-page request.
   * It can be adopted only while idle, untouched and genuinely empty. */
  implicit?: boolean;
  emulatedSize?: { width: number; height: number };
  /**
   * 页面「以为自己有焦点」的两个来源：Agent（chrome-devtools-mcp 给每张页面都开）和用户
   * （点进了面板里的这张页面）。任何一边要就开着，两边都不要才关；applied 是页面上现在的样子。
   */
  focusEmulation?: { agent: boolean; user: boolean; applied: boolean };
  /** 用户最近一次在这张页面上点、滚、打字的时间；用户动过的空白页不会自动清理。 */
  userInputAt?: number;
  /** 用户最近一次在这张页面上真按下去（点、按键、输入法上屏）的时间：网页这时要选文件、要打印，是用户要的。 */
  userPressAt?: number;
  /** 用户最近一次在这张页面上按下右键的时间：右键菜单只为用户弹，Agent 右键时不弹。 */
  userContextMenuAt?: number;
}

/**
 * 这张标签页可以直接拿去当 agent 要的那张新标签页吗。
 *
 * 只认桥自己垫出来的、已经就绪的、而且还停在空白页上的那一张。导航过的一律不算
 * ——那时候它已经是一张在用的页了，替 agent 把它导航走会把用户看着的东西换掉。
 */
export function isReusableBlankTab(
  tab: Pick<BrowserTab, "implicit" | "phase" | "userInputAt">,
  url: string | undefined,
  loading = false,
): boolean {
  if (!tab.implicit || tab.phase !== "ready" || tab.userInputAt !== undefined || loading) return false;
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
