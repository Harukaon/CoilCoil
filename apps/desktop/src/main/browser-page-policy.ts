import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * 内置浏览器页面的安全边界和 cookie 分区。
 *
 * 每张标签页都是主进程建的离屏页面（browser-offscreen.ts），设置全在这里写死，界面脚本
 * 和网页都改不了。以前嵌 <webview> 时，界面里的脚本能自己造一个页面、自己挑设置，得在
 * will-attach-webview 里逐项改写；现在主窗口关了 webviewTag，没有那个口子了。
 */

/** The jar used before any workspace is known, and by a window with none. */
export const BROWSER_PARTITION = "persist:coilcoil-browser";

/**
 * One cookie jar per workspace.
 *
 * The built-in browser already keeps each session's tabs apart, but every one of
 * them drank from the same jar: signing in to a site for one project signed you
 * in for all of them, and importing a second account meant overwriting the
 * first. Keying the jar on the workspace folder makes "which account is this"
 * a property of the project you opened, which is how the user thinks about it.
 *
 * Hashed rather than spelled out: partition strings end up in Electron's session
 * cache and on disk, and a workspace path can hold spaces, Chinese, or someone's
 * name. The leading segment stays readable so a jar on disk is recognisable as
 * CoilCoil's.
 */
export function browserPartitionFor(workspacePath?: string): string {
  const path = workspacePath?.trim();
  if (!path) return BROWSER_PARTITION;
  return `${BROWSER_PARTITION}-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 12)}`;
}

/**
 * 页面画面走不走 GPU 共享纹理（见 browser-frame-stream.ts）。
 *
 * macOS 上实测稳定：60 帧、窗口看不见时 Agent 照常截图。Windows、Linux 还没在真机上验过，
 * 先用改造前一直在用的 JPEG 画面（每秒 30 帧），其余功能两种画面完全一样。
 * COILCOIL_BROWSER_GPU_FRAMES=1 强制打开（在 Windows 真机上验证时用），=0 强制关掉（出问题时
 * 退回，不用发新版）。只对之后新开的页面生效。关了 GPU 的机器上页面本来就只出位图，自动退回。
 */
export function sharedTextureFrames(platform: NodeJS.Platform = process.platform, setting = process.env.COILCOIL_BROWSER_GPU_FRAMES): boolean {
  if (setting === "0") return false;
  if (setting === "1") return true;
  return platform === "darwin";
}

/**
 * 网页页面的设置：沙箱、隔离，没有 Node、没有预加载脚本，也不许再嵌网页。后台照常渲染：
 * 用户看别处时 Agent 还在操作它。
 *
 * 网页请求全屏按约定忽略（权限一律拒绝，见 BrowserRuntimeManager.installTabSecurity）。这里再
 * 加一道：就算以后放开了全屏，也只在网页区域里全屏，不动窗口——离屏页面的窗口是藏着的，
 * Electron 默认会把它变成全屏窗口，冒出来占满屏幕、抢走 App 的焦点，退出后还挂在屏幕上（实测）。
 */
export function browserPagePreferences(options: { partition: string; deviceScaleFactor: number; sharedTexture: boolean }): Electron.WebPreferences {
  return {
    offscreen: { useSharedTexture: options.sharedTexture, deviceScaleFactor: options.deviceScaleFactor },
    partition: options.partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    backgroundThrottling: false,
    disableHtmlFullscreenWindowResize: true,
  };
}
