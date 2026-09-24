import type { DesktopPlatform } from "../../shared/desktop-api";

const PLATFORM_QUERY = "platform";
const VALID_PLATFORMS: readonly DesktopPlatform[] = ["darwin", "win32", "linux"];

/**
 * The platform the renderer should present.
 *
 * The real platform still comes from Electron's preload bridge. A loopback
 * browser client may opt into another chrome with `?platform=win32` while
 * developing; the override is deliberately limited to dev/remote pages so a
 * packaged desktop window cannot be made to lie about its host platform.
 */
export function rendererPlatform(): DesktopPlatform {
  const actual = window.coilcoil?.platform ?? "darwin";
  if (!window.coilcoil?.isRemote || !isDevelopmentBrowserPage()) return actual;
  const requested = new URLSearchParams(window.location.search).get(PLATFORM_QUERY);
  return VALID_PLATFORMS.includes(requested as DesktopPlatform) ? requested as DesktopPlatform : actual;
}

export function platformComputerLabel(platform: DesktopPlatform = rendererPlatform()): string {
  if (platform === "darwin") return "Mac";
  return platform === "win32" ? "Windows" : "Linux";
}

function isDevelopmentBrowserPage(): boolean {
  const loopback = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  return loopback && (window.location.port === "5173" || window.location.port === "7789");
}
