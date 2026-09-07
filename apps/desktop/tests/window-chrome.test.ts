import assert from "node:assert/strict";
import test from "node:test";

import { applicationMenuTemplate, windowBackgroundColor, windowBlursBackdrop, windowChromeOptions } from "../src/main/window-chrome.ts";

test("macOS 保留原有的 hiddenInset 与红绿灯位置", () => {
  const options = windowChromeOptions("darwin");
  assert.equal(options.titleBarStyle, "hiddenInset");
  assert.deepEqual(options.trafficLightPosition, { x: 18, y: 18 });
  // 菜单栏是 macOS 系统级的，不能在这里藏。
  assert.equal(options.autoHideMenuBar, undefined);
  assert.equal(options.titleBarOverlay, undefined);
});

test("Windows 拿到无边框、无系统按钮的窗口，按钮由界面自己画", () => {
  const options = windowChromeOptions("win32");
  assert.equal(options.titleBarStyle, "hidden");
  // 有 titleBarOverlay 就会让系统把按钮画回来，正是要避免的。
  assert.equal(options.titleBarOverlay, undefined);
  assert.equal(options.autoHideMenuBar, true);
  assert.equal(options.trafficLightPosition, undefined);
});

test("Linux 的窗口装饰和 Windows 一样，只是没有那层毛玻璃", () => {
  const linux = windowChromeOptions("linux");
  const { backgroundMaterial, ...windows } = windowChromeOptions("win32");
  assert.equal(backgroundMaterial, "acrylic");
  assert.deepEqual(linux, windows);
  // 合成器画不画模糊问不出来，所以 Linux 上一律当作不画。
  assert.equal(linux.backgroundMaterial, undefined);
});

test("只有系统会画模糊的平台才把窗口底色留出透明度", () => {
  assert.equal(windowChromeOptions("darwin").vibrancy, "under-window");
  assert.equal(windowBlursBackdrop("darwin"), true);
  assert.equal(windowBlursBackdrop("win32"), true);
  assert.equal(windowBlursBackdrop("linux"), false);
  // 实心底色会把模糊整个盖掉，所以那两个平台上要跟着留同样的一点透明度。
  assert.equal(windowBackgroundColor("#1f1f1f", "darwin"), "#1f1f1fe6");
  assert.equal(windowBackgroundColor("#1f1f1f", "win32"), "#1f1f1fe6");
  assert.equal(windowBackgroundColor("#1f1f1f", "linux"), "#1f1f1f");
  // 读不懂的写法原样传下去，交给 Electron 自己判断，不要凑出一个坏色值。
  assert.equal(windowBackgroundColor("rgb(31 31 31)", "darwin"), "rgb(31 31 31)");
});

test("菜单本身保留下来，Ctrl/Cmd 的编辑快捷键靠它绑定", () => {
  const windows = applicationMenuTemplate("win32").map((item) => item.role);
  assert.deepEqual(windows, ["editMenu", "viewMenu"]);
  // macOS 少了 appMenu 就没有 Cmd+Q / Cmd+W。
  assert.deepEqual(applicationMenuTemplate("darwin").map((item) => item.role), [
    "appMenu", "editMenu", "viewMenu", "windowMenu",
  ]);
});
