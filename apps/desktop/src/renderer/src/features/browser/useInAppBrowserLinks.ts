import { useCallback, useEffect } from "react";

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
  const openLink = useCallback((url: string): void => {
    openBrowser();
    void window.suocode.createBrowserTab(scopeId, url).catch((error: unknown) => {
      reportError(error instanceof Error ? error.message : String(error));
    });
  }, [openBrowser, reportError, scopeId]);

  useEffect(() => {
    const routeMarkdownLink = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : undefined;
      const fileLink = target?.closest<HTMLAnchorElement>(".markdown-file-link[data-file-path]");
      const filePath = fileLink?.dataset.filePath;
      if (filePath) {
        event.preventDefault();
        event.stopPropagation();
        openFile(filePath);
        return;
      }
      const anchor = target?.closest<HTMLAnchorElement>(".markdown a[href]");
      const url = markdownBrowserUrl(anchor?.getAttribute("href") ?? null);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      openLink(url);
    };
    document.addEventListener("click", routeMarkdownLink, true);
    return () => document.removeEventListener("click", routeMarkdownLink, true);
  }, [openFile, openLink]);
}
