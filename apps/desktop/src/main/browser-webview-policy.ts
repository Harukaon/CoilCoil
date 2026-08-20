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

export const BROWSER_PARTITION = "persist:coilcoil-browser";

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
  return ALLOWED_SRC.has(src.trim().toLowerCase());
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
): boolean {
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
  webPreferences.partition = BROWSER_PARTITION;

  // The attribute strings are attacker-controlled in the threat model this guards
  // against, so overwrite them rather than inspecting what they happen to contain.
  params.webpreferences = "contextIsolation=yes,sandbox=yes,nodeIntegration=no,backgroundThrottling=no";
  params.disablewebsecurity = "off";
  params.nodeintegration = "off";
  params.nodeintegrationinsubframes = "off";
  params.plugins = "off";
  delete params.preload;

  if (params.partition !== BROWSER_PARTITION) return false;
  return isAllowedGuestSrc(typeof params.src === "string" ? params.src : undefined);
}
