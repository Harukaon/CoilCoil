import assert from "node:assert/strict";
import test from "node:test";

import { applicationMenuTemplate, windowChromeOptions } from "../src/main/window-chrome.ts";

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

test("Linux 与 Windows 同样处理", () => {
  assert.deepEqual(windowChromeOptions("linux"), windowChromeOptions("win32"));
});

test("菜单本身保留下来，Ctrl/Cmd 的编辑快捷键靠它绑定", () => {
  const windows = applicationMenuTemplate("win32").map((item) => item.role);
  assert.deepEqual(windows, ["editMenu", "viewMenu"]);
  // macOS 少了 appMenu 就没有 Cmd+Q / Cmd+W。
  assert.deepEqual(applicationMenuTemplate("darwin").map((item) => item.role), [
    "appMenu", "editMenu", "viewMenu", "windowMenu",
  ]);
});
