import type { WebContents } from "electron";

export const DEFAULT_BROWSER_URL = "about:blank";
export const DEFAULT_BROWSER_SCOPE_ID = "default";
export const BROWSER_TARGET_ID = "suocode-browser";
export const BROWSER_CONTEXT_ID = "suocode-browser-context";

/** Logical size used while a guest is parked in its 1x1 renderer slot. */
export const DEFAULT_BROWSER_VIEWPORT = { width: 1280, height: 720 };

export interface BrowserTab {
  id: string;
  scopeId: string;
  tabTargetId: string;
  pageTargetId: string;
  guest?: WebContents;
  guestNonce: string;
  phase: "awaiting-guest" | "loading" | "ready" | "closing";
  announced: boolean;
  emulatedSize?: { width: number; height: number };
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
