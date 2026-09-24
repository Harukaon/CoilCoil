import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_PARTITION, browserPartitionFor, hardenGuestPreferences, isAllowedGuestSrc, restoreGuestSrc, restoreTabIdFromSrc } from "../src/main/browser-webview-policy.ts";

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

test("每个工作区一份 cookie，换文件夹就换一个 jar", () => {
  const one = browserPartitionFor("/Users/hao/work/alpha");
  const other = browserPartitionFor("/Users/hao/work/beta");
  assert.notEqual(one, other, "两个工作区不能共用一份登录状态");
  assert.equal(browserPartitionFor("/Users/hao/work/alpha/"), one, "同一个文件夹就是同一份");
  assert.match(one, /^persist:coilcoil-browser-[0-9a-f]{12}$/, "名字里不出现路径本身");
  assert.equal(browserPartitionFor(undefined), BROWSER_PARTITION, "没有工作区时用默认那份");
  assert.equal(browserPartitionFor("   "), BROWSER_PARTITION);
});

test("guest 只能落在主进程认的那几份 jar 里", () => {
  const alpha = browserPartitionFor("/Users/hao/work/alpha");
  const beta = browserPartitionFor("/Users/hao/work/beta");
  const preferences: Record<string, unknown> = {};
  assert.equal(hardenGuestPreferences(preferences, params({ partition: alpha }), alpha), true);
  assert.equal(preferences.partition, alpha, "元素报什么分区，就按什么分区建，但必须是认的");
  assert.equal(hardenGuestPreferences({}, params({ partition: beta }), alpha), false, "没听说过的 jar 一律拒");
});

test("一个窗口同时认几份 jar——切工作区时老标签页还活着", () => {
  // 界面切到 beta 之后，alpha 的标签页照常留着：后台会话的 Agent 还在操作它们。
  // 所以这里问的是「这份在不在我认的那几份里」，不是「是不是当前那一份」。
  const alpha = browserPartitionFor("/Users/hao/work/alpha");
  const beta = browserPartitionFor("/Users/hao/work/beta");
  const expects = (value: unknown) => value === alpha || value === beta;
  assert.equal(hardenGuestPreferences({}, params({ partition: alpha }), expects), true);
  assert.equal(hardenGuestPreferences({}, params({ partition: beta }), expects), true);
  assert.equal(hardenGuestPreferences({}, params({ partition: BROWSER_PARTITION }), expects), false);
  assert.equal(hardenGuestPreferences({}, params({ partition: undefined }), expects), false);
  assert.equal(hardenGuestPreferences({}, params({ partition: "persist:somewhere-else" }), expects), false);
});

test("接管标记：只认 about:blank 加一个 tab id，别的地址、别的片段一律不认", () => {
  const id = "0e0d54c6-dd68-4752-8631-7c49e1a670cc";
  assert.equal(restoreTabIdFromSrc(restoreGuestSrc(id)), id);
  assert.equal(isAllowedGuestSrc(restoreGuestSrc(id)), true);
  for (const src of [`https://evil.example/#coilcoil-restore=${id}`, "about:blank#coilcoil-restore=nope", `about:blank#coilcoil-restore=${id}x`, "about:blank#other"]) {
    assert.equal(restoreTabIdFromSrc(src), undefined, src);
    assert.equal(isAllowedGuestSrc(src), false, src);
  }
});
