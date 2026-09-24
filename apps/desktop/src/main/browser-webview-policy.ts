import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { BROWSER_RESTORE_SRC_PREFIX } from "../shared/desktop-api";

export function restoreGuestSrc(tabId: string): string {
  return `${BROWSER_RESTORE_SRC_PREFIX}${tabId}`;
}

/**
 * Hardening for the `<webview>` guests that render the built-in browser.
 *
 * Enabling `webviewTag` lets any script in the app renderer mint a guest and pick
 * its own preferences, including a preload script that would run with elevated
 * privileges. This module is the single gate that closes that surface: it runs
 * from `will-attach-webview` and either rewrites the guest's settings into the
 * only shape CoilCoil allows, or refuses the attachment outright.
 *
 * The functions are pure so the policy can be tested without launching Electron.
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

/** Everything the element may point at before main performs the real navigation. */
const ALLOWED_SRC = new Set(["", "about:blank"]);

/**
 * The guest attaches at about:blank and every real navigation is routed through
 * `normalizeBrowserUrl` in the main process, so the element's own `src` never
 * needs to name a destination. Anything else means the renderer is trying to
 * choose a target, which is exactly what this policy exists to prevent.
 */
export function isAllowedGuestSrc(src: string | undefined): boolean {
  if (src === undefined) return true;
  return ALLOWED_SRC.has(src.trim().toLowerCase()) || restoreTabIdFromSrc(src) !== undefined;
}

/**
 * 用户接管 Agent 标签页时，新元素用这个 src 报到。
 *
 * 主进程要把 Agent 那边的页面（网址、历史、表单内容）用 navigationHistory.restore
 * 恢复进来，而 Chromium 只肯往「从没加载过任何页面」的 WebContents 里恢复——元素要是
 * 照常先加载 about:blank 就来不及了。所以这张标签页的元素带一个标记报到，主进程在
 * will-attach-webview 里认出它、确认确实有一张标签页在等接管，再把 src 清空：guest
 * 照样创建、挂上，但什么都不加载。标记里的 tab id 只用来挑「是哪一张在等」，身份仍由
 * dom-ready 之后的 nonce 登记确认（见 BrowserGuestRegistry）。
 */

export function restoreTabIdFromSrc(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  const match = /^about:blank#coilcoil-restore=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(src.trim());
  return match?.[1];
}

/**
 * Rewrite a pending guest's preferences in place. Returns false when the
 * attachment must be rejected instead — used for the two properties that cannot
 * be repaired after the fact: the session partition (immutable once the guest
 * has navigated) and the initial `src`.
 */
export function hardenGuestPreferences(
  webPreferences: Record<string, unknown>,
  params: Record<string, unknown>,
  expects: ((partition: unknown) => boolean) | string = BROWSER_PARTITION,
): boolean {
  // 一个窗口同时认几份 jar：每张标签页带着自己工作区那份，切工作区时老标签页照常
  // 活着（后台会话的 Agent 还在操作它们）。所以这里问的是「这份是不是我认的其中
  // 一份」，而不是「是不是那一份」。渲染层能选的只有主进程发给它的那几份。
  const accepted = typeof expects === "function" ? expects : (value: unknown) => value === expects;
  // A preload runs with privileges the guest page must never reach. The element's
  // `preload` attribute surfaces here as `preloadURL`, so drop every spelling.
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  delete webPreferences.preloadURLs;

  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.experimentalFeatures = false;
  webPreferences.enableBlinkFeatures = "";
  webPreferences.webviewTag = false;
  // Background tabs must keep rendering: agents drive them while the user looks elsewhere.
  webPreferences.backgroundThrottling = false;
  if (!accepted(params.partition)) return false;
  webPreferences.partition = params.partition;

  // The attribute strings are attacker-controlled in the threat model this guards
  // against, so overwrite them rather than inspecting what they happen to contain.
  params.webpreferences = "contextIsolation=yes,sandbox=yes,nodeIntegration=no,backgroundThrottling=no";
  params.disablewebsecurity = "off";
  params.nodeintegration = "off";
  params.nodeintegrationinsubframes = "off";
  params.plugins = "off";
  delete params.preload;

  return isAllowedGuestSrc(typeof params.src === "string" ? params.src : undefined);
}
