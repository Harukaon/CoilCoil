import { useEffect, useRef, useState } from "react";
import type { BrowserStateSnapshot } from "../../../../shared/desktop-api";
import { ownBrowserTabCount } from "../inspector/inspectorTabs";

const EMPTY_STATE = (scopeId: string): BrowserStateSnapshot => ({ scopeId, tabs: [], zoom: 1 });

/**
 * 当前工作区那一份浏览器标签页列表。
 *
 * 以前这份状态住在 BrowserPanel 里，因为标签条也画在面板内部。标签条挪到右侧栏
 * 顶上以后，画标签的人（WorkspaceInspector）比面板高一层，所以订阅也跟着提上来，
 * 面板只拿现成的快照。主进程仍然是标签集合和「哪个是当前标签」的唯一权威——
 * agent 通过 MCP 开关标签走的也是同一条路，这边只是跟着渲染。
 *
 * `open` 表示右侧栏里有没有浏览器这一项。只有开着的时候才在这个 scope 没有任何
 * 标签页时补建一个，而且只在挂载/切 scope/开合时判断一次：如果每次快照更新都判断，
 * agent 用 MCP 关掉最后一个标签页，这里就会立刻又给它建一个。其他工作区的标签不会
 * 混进当前快照。
 */
export function useBrowserTabs({ scopeId, workspacePath, open }: {
  scopeId: string;
  /** 决定用哪一份 cookie：一个工作区一份登录状态。 */
  workspacePath?: string;
  open: boolean;
}): {
  state: BrowserStateSnapshot;
  setState: (next: BrowserStateSnapshot) => void;
} {
  const [state, setState] = useState<BrowserStateSnapshot>(() => EMPTY_STATE(scopeId));
  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  useEffect(() => window.coilcoil.onBrowserStateUpdated((next) => {
    if (next.scopeId === scopeRef.current) setState(next);
  }), []);

  useEffect(() => {
    let cancelled = false;
    setState(EMPTY_STATE(scopeId));
    void window.coilcoil.setBrowserScope(scopeId, workspacePath).then(async (current) => {
      if (cancelled) return;
      // 只数当前工作区的标签；即使收到旧版本带 foreign 标记的快照，也不能拿别的
      // 工作区页面来阻止当前工作区补建自己的首张标签。
      const next = open && ownBrowserTabCount(current) === 0 ? await window.coilcoil.createBrowserTab(scopeId) : current;
      if (!cancelled) setState(next);
    });
    return () => { cancelled = true; };
  }, [open, scopeId, workspacePath]);

  return { state, setState };
}
