/**
 * 页面只有一个虚拟鼠标：Agent 的 CDP 操作也会触发 cursor-changed，但面板上的系统光标
 * 是用户的，不应该因为 Agent 去点了链接就变成小手。只把用户操作引起的变化送给面板。
 */
interface CursorState {
  source: "agent" | "user";
  pageCursor?: string;
  settle?: ReturnType<typeof setTimeout>;
}

export class PageCursors {
  private readonly states = new Map<string, CursorState>();

  constructor(private readonly publish: (tabId: string, cursor: string) => void, private readonly settleMs = 120) {}

  private state(tabId: string): CursorState {
    let state = this.states.get(tabId);
    if (!state) {
      state = { source: "agent" };
      this.states.set(tabId, state);
    }
    return state;
  }

  /** Agent 的虚拟鼠标到了别处：网页报告的光标只记下来，不改用户的光标。 */
  agentMoved(tabId: string): void {
    const state = this.state(tabId);
    state.source = "agent";
    clearTimeout(state.settle);
    state.settle = undefined;
  }

  /** 用户移动、点击或滚动：从此刻起，网页反馈的光标是用户的。 */
  userMoved(tabId: string): void {
    const state = this.state(tabId);
    if (state.source === "user") return;
    state.source = "user";
    // 网页只在光标种类发生变化时发事件。Agent 刚悬停过同种元素、或者刚切到这张页时，
    // 用户挪到相同光标的地方不会收到新事件；等这一帧的鼠标输入处理完，把缓存的种类补上。
    clearTimeout(state.settle);
    state.settle = setTimeout(() => {
      state.settle = undefined;
      if (state.source === "user" && state.pageCursor !== undefined) this.publish(tabId, state.pageCursor);
    }, this.settleMs);
  }

  pageChanged(tabId: string, cursor: string): void {
    const state = this.state(tabId);
    state.pageCursor = cursor;
    if (state.source !== "user") return;
    clearTimeout(state.settle);
    state.settle = undefined;
    this.publish(tabId, cursor);
  }

  /** 界面切页会把光标重置成箭头；下一次用户移进来需重新同步。 */
  switched(tabId: string): void {
    this.agentMoved(tabId);
  }

  forget(tabId: string): void {
    clearTimeout(this.states.get(tabId)?.settle);
    this.states.delete(tabId);
  }
}
