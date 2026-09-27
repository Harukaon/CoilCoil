import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_PARTITION, browserPagePreferences, browserPartitionFor, sharedTextureFrames } from "../src/main/browser-page-policy.ts";

test("每个工作区一份 cookie，换文件夹就换一个 jar", () => {
  const one = browserPartitionFor("/Users/hao/work/alpha");
  const other = browserPartitionFor("/Users/hao/work/beta");
  assert.notEqual(one, other, "两个工作区不能共用一份登录状态");
  assert.equal(browserPartitionFor("/Users/hao/work/alpha/"), one, "同一个文件夹就是同一份");
  assert.match(one, /^persist:coilcoil-browser-[0-9a-f]{12}$/, "名字里不出现路径本身");
  assert.equal(browserPartitionFor(undefined), BROWSER_PARTITION, "没有工作区时用默认那份");
  assert.equal(browserPartitionFor("   "), BROWSER_PARTITION);
});

test("网页页面一律沙箱、隔离，没有 Node、没有预加载，不许再嵌网页，后台照常渲染", () => {
  const partition = browserPartitionFor("/Users/hao/work/alpha");
  const preferences = browserPagePreferences({ partition, deviceScaleFactor: 2, sharedTexture: true });
  assert.deepEqual(preferences, {
    offscreen: { useSharedTexture: true, deviceScaleFactor: 2 },
    partition,
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
  });
  assert.equal("preload" in preferences, false);
});

test("关掉 GPU 画面时页面照样离屏渲染，只是不出共享纹理", () => {
  const preferences = browserPagePreferences({ partition: BROWSER_PARTITION, deviceScaleFactor: 1, sharedTexture: false });
  assert.deepEqual(preferences.offscreen, { useSharedTexture: false, deviceScaleFactor: 1 });
});

test("GPU 画面只在实测过的 macOS 上默认打开；Windows、Linux 先用 JPEG；开关能强制开、关", () => {
  assert.equal(sharedTextureFrames("darwin", undefined), true);
  assert.equal(sharedTextureFrames("win32", undefined), false);
  assert.equal(sharedTextureFrames("linux", undefined), false);
  assert.equal(sharedTextureFrames("win32", "1"), true, "Windows 真机上验证时强制打开");
  assert.equal(sharedTextureFrames("darwin", "0"), false, "出问题时退回 JPEG");
  assert.equal(sharedTextureFrames("darwin", "yes"), true, "看不懂的值不改变默认");
  assert.equal(sharedTextureFrames("win32", "yes"), false);
});
