import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BROWSER_URL = "about:blank";

/**
 * Normalize text entered by the user or sent through the browser MCP.
 *
 * CoilCoil intentionally does not maintain a protocol or filesystem allowlist:
 * the embedded Chromium instance decides whether it can load a given URL.
 * Absolute paths and home-relative paths are converted to file URLs so local
 * reports can be opened without callers having to encode them first.
 */
export function normalizeBrowserUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value || /^about:blank$/i.test(value)) return DEFAULT_BROWSER_URL;

  const localPath = value === "~"
    ? homedir()
    : value.startsWith("~/")
      ? resolve(homedir(), value.slice(2))
      : isAbsolute(value)
        ? value
        : undefined;
  if (localPath) return pathToFileURL(localPath).toString();

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return new URL(value).toString();

  const candidate = value.includes(".") && !value.includes(" ")
    ? `https://${value}`
    : `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  return new URL(candidate).toString();
}
