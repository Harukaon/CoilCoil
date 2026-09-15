import type { BrowserStateSnapshot } from "../../../../shared/desktop-api";

/**
 * 右侧栏那一排标签里，浏览器网页标签的 id 约定与鼠标动作判定。
 *
 * 浏览器的每个网页都是这一排上的一个标签，和终端「一个 shell 一个标签」一样，
 * 而不是先开一个「浏览器」标签、里面再套一条自己的标签条。
 *
 * 但网页标签和终端标签有一点根本不同：网页标签由主进程按 scope 拥有，agent 通过
 * MCP/CDP 也会开、关、切换它们。所以它们**不进** useWorkspaceInspector 的状态
 * （那是按工作区存的本地状态），而是渲染时从主进程发来的快照展开成 `browser:<id>`。
 * 这样 agent 开一个标签页，上面那一排立刻多一个标签，不需要两边对账。
 *
 * useWorkspaceInspector 里那条 `browser` 记录只表示「这个工作区开着浏览器」，
 * 它同时也是网页还没建好时占位标签的 id。
 */

const BROWSER_TAB_PREFIX = "browser:";

/** 浏览器已经打开、但第一个网页标签还没建好时，先占住位子的那个标签。 */
export const BROWSER_PLACEHOLDER_TAB_ID = "browser";

export function browserPaneTabId(browserTabId: string): string {
  return `${BROWSER_TAB_PREFIX}${browserTabId}`;
}

/** 反过来：这个标签是不是某个网页标签，是的话对应主进程里的哪个 tab id。 */
export function browserTabIdFromPaneId(paneTabId: string): string | undefined {
  return paneTabId.startsWith(BROWSER_TAB_PREFIX) ? paneTabId.slice(BROWSER_TAB_PREFIX.length) : undefined;
}

export interface BrowserPaneTab {
  id: string;
  label: string;
  loading: boolean;
  /** 别的会话的 agent 开的那一张：照样列出来，只是图标不同。 */
  foreign: boolean;
}

/**
 * 把主进程的浏览器快照摊成标签条上的若干个标签。
 *
 * 空列表要还一个占位标签：一个工作区如果只开了浏览器，标签条空掉会让右侧栏退回
 * 「打开一个面板」的空状态，等第一个网页建好又跳回来，闪一下。
 */
export function browserPaneTabs(state: BrowserStateSnapshot): BrowserPaneTab[] {
  if (state.tabs.length === 0) return [{ id: BROWSER_PLACEHOLDER_TAB_ID, label: "浏览器", loading: true, foreign: false }];
  return state.tabs.map((tab) => ({
    id: browserPaneTabId(tab.id),
    label: tab.title,
    loading: tab.loading,
    foreign: tab.foreign === true,
  }));
}

/** 当前选中的是哪个网页标签。主进程是 activeTabId 的唯一权威，这里只做展示。 */
export function activeBrowserPaneTabId(state: BrowserStateSnapshot): string {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
  return active ? browserPaneTabId(active.id) : BROWSER_PLACEHOLDER_TAB_ID;
}

/**
 * 这个会话自己开着几张网页标签。
 *
 * 「浏览器开着但一张网页都没有，补建一张」和「最后一张关掉了，浏览器这一项也收
 * 起来」这两条判断都只能看自己的那几张：别的会话的标签页现在也列在这一排里，拿
 * 总数去判断的话，用户这边一张页面都没有却以为有。
 */
export function ownBrowserTabCount(state: BrowserStateSnapshot): number {
  return state.tabs.filter((tab) => tab.foreign !== true).length;
}

/** 中键 = 关闭标签页。 */
export const MIDDLE_MOUSE_BUTTON = 1;

/**
 * 这一下中键要不要关掉标签。
 *
 * 不能关的标签（没给 closable 的）不响应；调用方另外要在 mousedown 上
 * `preventDefault()`，否则 Chromium 会先把中键当成自动滚动/中键粘贴。
 */
export function isMiddleClickClose(button: number, closable: boolean | undefined): boolean {
  return button === MIDDLE_MOUSE_BUTTON && closable === true;
}
