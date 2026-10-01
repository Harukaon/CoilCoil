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

// Chrome 137+ stores its cookie key behind a third, CNG-bound GCM layer. This
// fixed Chrome transform is version-specific: fail closed if its tag or format
// changes, never import zero cookies with an unauthenticated key.
const CHROME_CNG_MASK = Buffer.from("ccf8a1cec56605b8517552ba1a2d061c03a29e90274fb2fcf59ba4b75c392390", "hex");

export function deriveChromeAppBoundKey(payload: Buffer, cngKey: Buffer): Buffer {
  if (cngKey.length !== 32 || payload.length < 8) throw new Error("Chrome 的密钥格式无法识别，未导入数据。");
  const headerLength = payload.readUInt32LE(0);
  if (headerLength > 4096 || headerLength > payload.length - 8) throw new Error("Chrome 的密钥头无效，未导入数据。");
  const offset = 8 + headerLength;
  const contentLength = payload.readUInt32LE(4 + headerLength);
  if (contentLength !== 93 || offset + contentLength !== payload.length || payload[offset] !== 3) {
    throw new Error("Chrome 更新了登录数据加密格式，当前版本无法安全导入。");
  }
  const aesKey = Buffer.alloc(32);
  try {
    for (let i = 0; i < aesKey.length; i++) aesKey[i] = cngKey[i] ^ CHROME_CNG_MASK[i];
    const iv = payload.subarray(offset + 33, offset + 45);
    const ciphertext = payload.subarray(offset + 45, offset + 77);
    const tag = payload.subarray(offset + 77, offset + 93);
    const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAuthTag(tag);
    const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (key.length !== 32) throw new Error("Chrome 密钥长度不正确");
    return key;
  } catch {
    throw new Error("Chrome 的登录数据无法通过完整性校验，没有导入任何数据。");
  } finally { aesKey.fill(0); }
}

export function directWindowsImportAvailable(browser: ChromiumBrowserDescriptor): boolean {
  return browser.id === "edge" || browser.id === "chrome";
}

/** Never request UAC for a source whose encrypted key we cannot really use. */
export async function readWindowsChromiumKeys(browser: ChromiumBrowserDescriptor): Promise<WindowsChromiumKeys> {
  if (process.platform !== "win32" || (browser.id !== "edge" && browser.id !== "chrome")) {
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
    if (browser.id === "chrome") {
      throw new Error("Chrome 的登录数据无法在这台 Windows 电脑上解锁，未导入任何数据。请确认 Chrome 已退出；如果仍失败，可能是 Chrome 更新了加密方式。");
    }
    throw new Error("Windows 没能读取浏览器的加密密钥。请确认已完全退出浏览器，再重试管理员授权。");
  }
  try {
    const response = JSON.parse(stdout) as {
      legacy?: string | null;
      appBound?: string | null;
      chromePayload?: string | null;
      chromeCngKey?: string | null;
    };
    const legacy = response.legacy ? Buffer.from(response.legacy, "base64") : undefined;
    let appBound: Buffer | undefined = response.appBound ? Buffer.from(response.appBound, "base64") : undefined;
    if (browser.id === "chrome" && response.chromePayload && response.chromeCngKey) {
      const payload = Buffer.from(response.chromePayload, "base64");
      const cngKey = Buffer.from(response.chromeCngKey, "base64");
      try { appBound = deriveChromeAppBoundKey(payload, cngKey); }
      finally { payload.fill(0); cngKey.fill(0); }
    }
    if ((legacy && legacy.length !== 32) || (appBound && appBound.length !== 32) || (!legacy && !appBound)) {
      throw new Error("密钥格式不正确");
    }
    return { kind: "windows", legacy, appBound };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Chrome")) throw error;
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
