/** Every live or in-flight tab counts against the session's limit. */
export const SESSION_TAB_LIMIT = 8;
export type BrowserTabOwner = "agent" | "user";

/** about:blank can contain an Agent-created report; URL alone does not identify an empty page. */
export const EMPTY_BROWSER_DOCUMENT = "document.location.href === 'about:blank' && document.head.childNodes.length === 0 && document.body.childNodes.length === 0";

export function assertBrowserTabCapacity(count: number): void {
  if (count >= SESSION_TAB_LIMIT) {
    throw new Error(`This conversation already has ${SESSION_TAB_LIMIT} browser tabs. Reuse an existing tab or close one with devtools.close_page before opening another. 当前会话最多 ${SESSION_TAB_LIMIT} 个浏览器标签页，请复用或关闭已有页面。`);
  }
}

/** Only a settled, untouched Agent page may be discarded automatically. */
export function isSettledAgentBlank(
  tab: { owner: BrowserTabOwner; phase: string; userInputAt?: number },
  url: string,
  loading: boolean,
): boolean {
  return tab.owner === "agent" && tab.phase === "ready" && tab.userInputAt === undefined
    && !loading && /^about:blank$/i.test(url);
}

/**
 * 哪些 CDP 命令算 Agent 真的在用这张页。
 *
 * 不能「收到命令就算」：chrome-devtools-mcp 每次回话都要列页面，会挨个给所有页面发
 * Runtime.callFunctionOn 读标题，还有各种监听的开开关关——照那样算，每调一次工具所有
 * 页面都被误标成「正在操作」。只认有意图的动作：导航、刷新、点击和
 * 键盘输入、截图、读页面快照、切到这张页。
 */
export function isAgentTabUse(method: string): boolean {
  return /^(Page\.(navigate|reload|captureScreenshot|bringToFront)|Accessibility\.getFullAXTree|Input\.)/.test(method);
}
