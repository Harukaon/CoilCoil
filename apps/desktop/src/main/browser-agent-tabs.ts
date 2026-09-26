/**
 * Agent 开的标签页只保留最近用过的几张。
 *
 * 任务一多，Agent 会一张接一张地开新页，而不是回头复用开过的那张——这不是它真想
 * 开这么多，是忘了；提示词管不住。所以由浏览器兜底：Agent 再开新页、它的标签页超过
 * 上限时，关掉其中最久没用过的，并在那次工具返回里告诉它关了哪张、网址是什么，要用
 * 就再开。
 *
 * 只在「Agent 开了新页」这一刻收，没有定时回收：页面不会在谁也没动它的时候自己消失。
 * 用户开的标签页永远不动；Agent 开的、用户在里面点过打过字的也不动——那是用户正在用的。
 */
export const AGENT_TAB_LIMIT = 5;

export type BrowserTabOwner = "agent" | "user";

export interface RecycledAgentTab {
  url: string;
  title: string;
}

/** 收掉的页先记着，等运行时来取、写进下一次工具返回；取一次就清空，只说一遍。 */
export class RecycledAgentTabs {
  private readonly byScope = new Map<string, RecycledAgentTab[]>();

  record(scopeId: string, tab: RecycledAgentTab): void {
    this.byScope.set(scopeId, [...this.byScope.get(scopeId) ?? [], tab]);
  }

  take(scopeId: string): RecycledAgentTab[] {
    const tabs = this.byScope.get(scopeId) ?? [];
    this.byScope.delete(scopeId);
    return tabs;
  }
}

/**
 * 超出上限时该关哪几张。
 *
 * `keepIds` 是这次不能动的：刚开出来的那张，以及这个会话当前显示的那张。
 * 只算 Agent 开的、而且用户没在里面动过的：用户点过、打过字的那张正被用户用着，不收，
 * 也不占 Agent 的名额；用户自己开的更不收。
 */
export function agentTabsToRecycle<T extends { id: string; owner: BrowserTabOwner; lastUsedAt: number; userInputAt?: number }>(
  tabs: readonly T[],
  keepIds: ReadonlySet<string>,
  limit = AGENT_TAB_LIMIT,
): T[] {
  const agentTabs = tabs.filter((tab) => tab.owner === "agent" && tab.userInputAt === undefined);
  const excess = agentTabs.length - limit;
  if (excess <= 0) return [];
  return agentTabs
    .filter((tab) => !keepIds.has(tab.id))
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    .slice(0, excess);
}

/**
 * 哪些 CDP 命令算 Agent 真的在用这张页。
 *
 * 不能「收到命令就算」：chrome-devtools-mcp 每次回话都要列页面，会挨个给所有页面发
 * Runtime.callFunctionOn 读标题，还有各种监听的开开关关——照那样算，每调一次工具所有
 * 页面都「刚用过」，最久没用的就成了随机的。只认有意图的动作：导航、刷新、点击和
 * 键盘输入、截图、读页面快照、切到这张页。
 */
export function isAgentTabUse(method: string): boolean {
  return /^(Page\.(navigate|reload|captureScreenshot|bringToFront)|Accessibility\.getFullAXTree|Input\.)/.test(method);
}
