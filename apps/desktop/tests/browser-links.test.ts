import assert from "node:assert/strict";
import test from "node:test";
import { routableHostUrl } from "../src/main/host-navigation.ts";
import {
  inAppBrowserModifierLabel,
  markdownBrowserUrl,
  wantsInAppBrowser,
} from "../src/renderer/src/features/browser/useInAppBrowserLinks.ts";

test("只有 http/https 的链接才当成网页链接", () => {
  assert.equal(markdownBrowserUrl("https://example.com/docs?q=1"), "https://example.com/docs?q=1");
  assert.equal(markdownBrowserUrl("http://127.0.0.1:8765/test"), "http://127.0.0.1:8765/test");
});

test("非网页链接不能拿去替换应用自己的页面", () => {
  assert.equal(markdownBrowserUrl("file:///tmp/report.html"), undefined);
  assert.equal(markdownBrowserUrl("javascript:alert(1)"), undefined);
  assert.equal(markdownBrowserUrl("not a url"), undefined);
});

test("the host navigation fallback only forwards HTTP URLs", () => {
  assert.equal(routableHostUrl("https://example.com"), "https://example.com/");
  assert.equal(routableHostUrl("file:///tmp/report.html"), undefined);
});

/** 渲染进程里这个值来自 preload；测试里按平台伪造。 */
function onPlatform<T>(platform: string, run: () => T): T {
  const globals = globalThis as { window?: { coilcoil?: { platform?: string } } };
  const previous = globals.window;
  globals.window = { coilcoil: { platform } };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  }
}

test("macOS 上是 Command，而且 Control 不算", () => {
  onPlatform("darwin", () => {
    assert.equal(wantsInAppBrowser({ metaKey: true, ctrlKey: false }), true);
    // macOS 上 Control + 单击就是右键；当成修饰键的话，每次开右键菜单都会跳转。
    assert.equal(wantsInAppBrowser({ metaKey: false, ctrlKey: true }), false);
    assert.equal(inAppBrowserModifierLabel(), "⌘");
  });
});

test("其他平台上是 Control", () => {
  for (const platform of ["win32", "linux"]) {
    onPlatform(platform, () => {
      assert.equal(wantsInAppBrowser({ metaKey: false, ctrlKey: true }), true);
      assert.equal(wantsInAppBrowser({ metaKey: true, ctrlKey: false }), false);
      assert.equal(inAppBrowserModifierLabel(), "Ctrl");
    });
  }
});

test("不按修饰键就是普通点击，走用户自己的浏览器", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    onPlatform(platform, () => {
      assert.equal(wantsInAppBrowser({ metaKey: false, ctrlKey: false }), false);
    });
  }
});
