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
