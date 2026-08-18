import type { BrowserWindow, Event } from "electron";
import type { BrowserRuntimeManager } from "./browser-runtime";

export function routableHostUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The application renderer must never be replaced by a link destination.
 * Markdown links normally route in the renderer; this is the process-level
 * fallback for future surfaces that accidentally render an unhandled anchor.
 */
export function installHostNavigationGuard(
  window: BrowserWindow,
  browser: BrowserRuntimeManager,
  activateBrowser: (scopeId: string) => void,
): void {
  window.webContents.once("did-finish-load", () => {
    window.webContents.on("will-navigate", (event: Event, rawUrl: string) => {
      if (rawUrl === window.webContents.getURL()) return;
      event.preventDefault();
      const url = routableHostUrl(rawUrl);
      if (!url) return;
      const scopeId = browser.state().scopeId;
      activateBrowser(scopeId);
      void browser.createTab(url, true, scopeId).catch((error: unknown) => {
        console.error("[browser] 无法从应用链接打开网页", error);
      });
    });
  });
}
