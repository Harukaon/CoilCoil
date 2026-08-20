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
