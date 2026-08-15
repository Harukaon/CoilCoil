import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_PARTITION, hardenGuestPreferences, isAllowedGuestSrc } from "../src/main/browser-webview-policy.ts";

const params = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  partition: BROWSER_PARTITION,
  src: "about:blank",
  ...overrides,
});

test("webview policy strips every spelling of a preload script", () => {
  const preferences: Record<string, unknown> = {
    preload: "/tmp/evil.js",
    preloadURL: "file:///tmp/evil.js",
    preloadURLs: ["file:///tmp/evil.js"],
  };
  assert.equal(hardenGuestPreferences(preferences, params({ preload: "/tmp/evil.js" })), true);
  assert.equal("preload" in preferences, false);
  assert.equal("preloadURL" in preferences, false);
  assert.equal("preloadURLs" in preferences, false);
});

test("webview policy forces the sandbox even when the guest asks to disable it", () => {
  const preferences: Record<string, unknown> = {
    nodeIntegration: true,
    nodeIntegrationInWorker: true,
    nodeIntegrationInSubFrames: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    experimentalFeatures: true,
    webviewTag: true,
    backgroundThrottling: true,
  };
  assert.equal(hardenGuestPreferences(preferences, params()), true);
  assert.deepEqual(preferences, {
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    enableBlinkFeatures: "",
    webviewTag: false,
    backgroundThrottling: false,
    partition: BROWSER_PARTITION,
  });
});

test("webview policy overwrites hostile attribute strings instead of reading them", () => {
  const attributes = params({
    webpreferences: "nodeIntegration=yes,contextIsolation=no,sandbox=no",
    disablewebsecurity: "on",
    nodeintegration: "on",
    nodeintegrationinsubframes: "on",
    plugins: "on",
    preload: "file:///tmp/evil.js",
  });
  assert.equal(hardenGuestPreferences({}, attributes), true);
  assert.equal(attributes.webpreferences, "contextIsolation=yes,sandbox=yes,nodeIntegration=no,backgroundThrottling=no");
  assert.equal(attributes.disablewebsecurity, "off");
  assert.equal(attributes.nodeintegration, "off");
  assert.equal(attributes.nodeintegrationinsubframes, "off");
  assert.equal(attributes.plugins, "off");
  assert.equal("preload" in attributes, false);
});

test("webview policy rejects a guest that asks for a different session", () => {
  assert.equal(hardenGuestPreferences({}, params({ partition: "persist:somewhere-else" })), false);
  assert.equal(hardenGuestPreferences({}, params({ partition: undefined })), false);
  assert.equal(hardenGuestPreferences({}, params({ partition: "" })), false);
});

test("webview policy rejects a guest that names its own destination", () => {
  for (const src of [
    "https://evil.example",
    "file:///etc/passwd",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "data:text/html,<script>alert(1)</script>",
    "javascript:alert(1)",
  ]) {
    assert.equal(hardenGuestPreferences({}, params({ src })), false, `expected ${src} to be rejected`);
  }
});

test("webview policy allows only the blank start page", () => {
  assert.equal(isAllowedGuestSrc(undefined), true);
  assert.equal(isAllowedGuestSrc(""), true);
  assert.equal(isAllowedGuestSrc("about:blank"), true);
  assert.equal(isAllowedGuestSrc("  About:Blank  "), true);
  assert.equal(isAllowedGuestSrc("about:blank#x"), false);
  assert.equal(isAllowedGuestSrc("https://example.com"), false);
});

test("webview policy hardens preferences even on a rejected attachment", () => {
  // preventDefault() is the caller's job; the object must still be safe if a
  // future refactor ever lets a rejected guest through.
  const preferences: Record<string, unknown> = { preload: "/tmp/evil.js", nodeIntegration: true };
  assert.equal(hardenGuestPreferences(preferences, params({ src: "https://evil.example" })), false);
  assert.equal("preload" in preferences, false);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
});
