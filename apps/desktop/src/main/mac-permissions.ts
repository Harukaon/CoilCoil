import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shell, systemPreferences } from "electron";
import type { MacPermissionId, MacPermissionStatus, MacPermissions } from "../shared/desktop-api";

/**
 * 这台 Mac 给了 CoilCoil 哪些权限，以及怎么去开。
 *
 * ## 为什么要自己探
 *
 * macOS 对大多数权限都没有「查询我有没有」的接口——只有去碰一下受保护的东西，看它
 * 让不让。能问的（屏幕录制、辅助功能）就问 Electron，问不到的就去列一个一定存在
 * 而且一定受保护的目录：列得动是有，抛 EPERM/EACCES 是明确被拒，抛 ENOENT 只能说
 * 「不知道」——绝不能把「找不到」说成「被拒绝」。
 *
 * 探针选 `~/Library/Cookies` 和 `~/Library/Safari`：2026-09-18 在 macOS 27 上量过，
 * 未授权的 App 列这两个都是 Operation not permitted，有权限的进程列得出来。常见的
 * `~/Library/Application Support/com.apple.TCC` 在这台机器上根本不存在，靠它会把
 * 「没授权」误判成「不知道」。
 *
 * ## 这些权限是彼此独立的
 *
 * 「完全磁盘访问权限」不包含「App 管理」，也不包含「屏幕录制」——在系统设置里是三个
 * 各自独立的开关（2026-09-18 逐个用深链打开验证过）。所以这里也一项一项地报。
 */

/** 每一项在系统设置里的锚点。逐个验证过都能直接跳到对应那一页。 */
const SETTINGS_ANCHOR: Record<MacPermissionId, string> = {
  "full-disk": "Privacy_AllFiles",
  "screen-recording": "Privacy_ScreenCapture",
  "app-management": "Privacy_AppBundles",
  accessibility: "Privacy_Accessibility",
};

const FULL_DISK_PROBES = [
  join(homedir(), "Library", "Cookies"),
  join(homedir(), "Library", "Safari"),
];

export function classifyProbe(errors: readonly (string | undefined)[]): MacPermissionStatus {
  if (errors.length === 0) return "granted";
  return errors.some((code) => code === "EPERM" || code === "EACCES") ? "denied" : "unknown";
}

function probe(paths: readonly string[]): MacPermissionStatus {
  const failures: (string | undefined)[] = [];
  for (const path of paths) {
    try {
      readdirSync(path);
      return "granted";
    } catch (error) {
      failures.push((error as NodeJS.ErrnoException).code);
    }
  }
  return classifyProbe(failures);
}

/** Electron 的媒体权限状态映射到我们这四档。 */
export function fromMediaAccess(status: string): MacPermissionStatus {
  if (status === "granted") return "granted";
  if (status === "denied" || status === "restricted") return "denied";
  return "unknown";
}

export function macPermissions(): MacPermissions {
  if (process.platform !== "darwin") {
    return {
      platform: "other",
      status: { "full-disk": "unsupported", "screen-recording": "unsupported", "app-management": "unsupported", accessibility: "unsupported" },
    };
  }
  return {
    platform: "darwin",
    status: {
      "full-disk": probe(FULL_DISK_PROBES),
      "screen-recording": fromMediaAccess(systemPreferences.getMediaAccessStatus("screen")),
      // App 管理没有查询接口，只能给入口，不谎报状态。
      "app-management": "unknown",
      accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "unknown",
    },
  };
}

/** 打开系统设置里对应那一页。目的地在表里写死，调用方只能递一个已知的 id。 */
export async function openPermissionSettings(id: MacPermissionId): Promise<void> {
  if (process.platform !== "darwin") return;
  const anchor = SETTINGS_ANCHOR[id];
  if (!anchor) return;
  await shell.openExternal(`x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?${anchor}`);
}
