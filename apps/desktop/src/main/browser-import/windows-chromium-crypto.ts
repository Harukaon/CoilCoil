import { execFile } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChromiumBrowserDescriptor } from "./browser-catalog";

const run = promisify(execFile);

export interface WindowsChromiumKeys {
  kind: "windows";
  legacy?: Buffer;
  appBound?: Buffer;
}

/** Only Chrome and Edge have an approved Windows source and a matching helper path. */
export async function readWindowsChromiumKeys(browser: ChromiumBrowserDescriptor): Promise<WindowsChromiumKeys> {
  if (process.platform !== "win32" || (browser.id !== "chrome" && browser.id !== "edge")) {
    throw new Error("这个浏览器不支持 Windows 登录状态导入。");
  }
  const { app } = await import("electron");
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build");
  const helper = join(root, "browser-import-helper", "BrowserImportKeyHelper.exe");
  let stdout: string;
  try {
    ({ stdout } = await run(helper, ["--request", browser.id], {
      timeout: 150_000,
      maxBuffer: 4096,
      windowsHide: true,
    }));
  } catch (error) {
    const failure = error as { code?: string | number; stderr?: string };
    if (failure.code === 2 || failure.stderr?.includes("approval was cancelled")) {
      throw new Error("已取消管理员授权，浏览器数据没有导入。");
    }
    if (failure.code === "ENOENT") throw new Error("导入组件未安装完整，请重新安装 CoilCoil。");
    throw new Error("Windows 没能读取浏览器的加密密钥。请确认已完全退出浏览器，再重试管理员授权。");
  }
  try {
    const response = JSON.parse(stdout) as { legacy?: string | null; appBound?: string | null };
    const legacy = response.legacy ? Buffer.from(response.legacy, "base64") : undefined;
    const appBound = response.appBound ? Buffer.from(response.appBound, "base64") : undefined;
    if ((legacy && legacy.length !== 32) || (appBound && appBound.length !== 32) || (!legacy && !appBound)) {
      throw new Error("密钥格式不正确");
    }
    return { kind: "windows", legacy, appBound };
  } catch {
    throw new Error("Windows 返回的浏览器密钥无效，没有导入任何登录数据。");
  }
}

/** Windows stores v10 and v20 records side by side; the two keys must never be mixed. */
export function decryptWindowsChromiumValue(
  encrypted: Buffer,
  hostKey: string,
  keys: WindowsChromiumKeys,
): string | undefined {
  if (encrypted.length === 0) return "";
  const version = encrypted.subarray(0, 3).toString("ascii");
  const key = version === "v20" ? keys.appBound : version === "v10" ? keys.legacy : undefined;
  if (!key || key.length !== 32 || encrypted.length < 3 + 12 + 16) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(3, 15));
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
    const clear = Buffer.concat([decipher.update(encrypted.subarray(15, -16)), decipher.final()]);
    // Recent Chromium prepends SHA-256(host_key) before the cookie value.
    // Never loosen a host-bound value by treating a mismatched hash as text.
    if (hostKey && clear.length >= 32) {
      const expected = createHash("sha256").update(hostKey).digest();
      if (clear.subarray(0, 32).equals(expected)) return clear.subarray(32).toString("utf8");
      if (version === "v20") return undefined;
    }
    return clear.toString("utf8");
  } catch {
    return undefined;
  }
}

export function clearWindowsChromiumKeys(keys: WindowsChromiumKeys): void {
  keys.legacy?.fill(0);
  keys.appBound?.fill(0);
}
