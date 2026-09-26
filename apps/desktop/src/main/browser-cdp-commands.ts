export interface RoutedPageCommand {
  method: string;
  params: Record<string, unknown>;
  resetCache: boolean;
}

/** Route reload through a same-target navigation so Electron keeps the frame. */
export function routePageCommand(
  method: string,
  params: Record<string, unknown>,
  currentUrl: string,
): RoutedPageCommand {
  if (method !== "Page.reload") return { method, params, resetCache: false };
  return {
    method: "Page.navigate",
    params: { url: currentUrl, transitionType: "reload" },
    resetCache: params.ignoreCache === true,
  };
}

/**
 * 这些命令会关掉页面上所有人共用的开关：Agent 的连接和 App 自己用的是同一个调试会话。
 * Agent 一句 `Page.disable`，Chromium 连带清掉页面加载前要跑的脚本（打印替身、
 * window.chrome），选文件的拦截也随之失灵。桥直接回「好了」，不往下传；Agent 照样收得到
 * 它订过的事件，多收几条无妨。Runtime 域不在此列：App 不靠它，Agent 关了再开能拿回页面
 * 的执行上下文。
 */
export function isSharedStateReset(method: string, params: Record<string, unknown>): boolean {
  if (method === "Page.disable") return true;
  return method === "Page.setInterceptFileChooserDialog" && params.enabled !== true;
}

/** Lighthouse asks for its attached target without supplying a target id. */
export function isDirectPageTargetInfoRequest(
  method: string,
  params: Record<string, unknown>,
  pageTargetId: string,
): boolean {
  return method === "Target.getTargetInfo"
    && (params.targetId === undefined || params.targetId === pageTargetId);
}

/**
 * Commands that mean "activate this tab's window".
 *
 * The built-in browser has no window of its own — its tabs are guests inside the
 * app window — so Chromium answers these by activating the embedder: the app is
 * raised, and an app the user minimized is restored, in the middle of an agent
 * run happening in the background. Selecting the tab in the browser panel is the
 * honest translation, and it is already what `Target.activateTarget` does.
 *
 * `Page.bringToFront` reaches us from `select_page(bringToFront: true)` and from
 * any other CDP client driving the built-in browser.
 */
export function isTabActivationCommand(method: string): boolean {
  return method === "Page.bringToFront";
}
