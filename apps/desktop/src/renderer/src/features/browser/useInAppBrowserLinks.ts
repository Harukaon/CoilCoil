import { useCallback, useEffect } from "react";

/**
 * Whether this click asked for the built-in browser rather than the real one.
 *
 * Command on macOS, Control elsewhere — the same chord those platforms already
 * use for "open this somewhere other than here". Control is deliberately not
 * accepted on macOS: there it is a right-click, and treating it as a modifier
 * would fire a navigation every time someone opened the context menu.
 */
export function wantsInAppBrowser(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return window.coilcoil.platform === "darwin" ? event.metaKey : event.ctrlKey;
}

/** The key to name in a tooltip, spelled the way the platform spells it. */
export function inAppBrowserModifierLabel(): string {
  return window.coilcoil.platform === "darwin" ? "⌘" : "Ctrl";
}

export function markdownBrowserUrl(href: string | null): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function useInAppBrowserLinks({
  scopeId,
  openBrowser,
  openFile,
  reportError,
}: {
  scopeId: string;
  openBrowser(): void;
  openFile(path: string): void;
  reportError(message: string): void;
}): void {
  const openInApp = useCallback((url: string): void => {
    openBrowser();
    void window.coilcoil.createBrowserTab(scopeId, url).catch((error: unknown) => {
      reportError(error instanceof Error ? error.message : String(error));
    });
  }, [openBrowser, reportError, scopeId]);

  /**
   * A link in the transcript goes where a link goes: the user's own browser.
   *
   * It used to be captured into the panel on the right, which is the wrong
   * default — that panel is a tool for the Agent to drive, and sending someone's
   * click there strands them in a window with no history, no extensions and none
   * of their logins. The panel stays one modifier away.
   */
  const openLink = useCallback((url: string, inApp: boolean): void => {
    if (inApp) {
      openInApp(url);
      return;
    }
    void window.coilcoil.openExternal(url).catch((error: unknown) => {
      reportError(error instanceof Error ? error.message : String(error));
    });
  }, [openInApp, reportError]);

  useEffect(() => {
    const routeMarkdownLink = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : undefined;
      const fileLink = target?.closest<HTMLAnchorElement>(".markdown-file-link[data-file-path]");
      const filePath = fileLink?.dataset.filePath;
      if (filePath) {
        event.preventDefault();
        event.stopPropagation();
        // The right-hand panel is the workspace tree and single-file previews.
        // A folder belongs to the operating system's file manager instead.
        if (fileLink?.dataset.fileKind === "directory") {
          void window.coilcoil.revealPath(filePath).catch((error: unknown) => {
            reportError(error instanceof Error ? error.message : String(error));
          });
          return;
        }
        openFile(filePath);
        return;
      }
      const anchor = target?.closest<HTMLAnchorElement>(".markdown a[href]");
      const url = markdownBrowserUrl(anchor?.getAttribute("href") ?? null);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      openLink(url, wantsInAppBrowser(event));
    };
    document.addEventListener("click", routeMarkdownLink, true);
    return () => document.removeEventListener("click", routeMarkdownLink, true);
  }, [openFile, openLink, reportError]);
}
