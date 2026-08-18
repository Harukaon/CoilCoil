import type { DesktopPlatform } from "./desktop-api";

/**
 * Platform wording shared by the renderer's menus and the main process dialogs.
 *
 * These have to agree: the file tree offers the action and main confirms it, so
 * a menu saying 废纸篓 above a Windows dialog saying 回收站 would look like two
 * different operations.
 */
export function trashLabel(platform: DesktopPlatform): string {
  return platform === "darwin" ? "废纸篓" : "回收站";
}

export function fileManagerLabel(platform: DesktopPlatform): string {
  if (platform === "darwin") return "访达";
  return platform === "win32" ? "文件资源管理器" : "文件管理器";
}

/** The accelerator prefix shown in menu hints: ⌘ on macOS, Ctrl elsewhere. */
export function primaryModifierLabel(platform: DesktopPlatform): string {
  return platform === "darwin" ? "⌘" : "Ctrl+";
}

export function currentPlatform(nodePlatform: NodeJS.Platform): DesktopPlatform {
  if (nodePlatform === "darwin") return "darwin";
  return nodePlatform === "win32" ? "win32" : "linux";
}
