import assert from "node:assert/strict";
import test from "node:test";
import { installHostNavigationGuard, routableHostUrl } from "../src/main/host-navigation.ts";

/** 够这道守卫跑起来的最小窗口。 */
function fakeWindow(currentUrl: string): {
  window: unknown;
  navigate: (url: string) => { prevented: boolean };
} {
  let onNavigate: ((event: { preventDefault: () => void }, url: string) => void) | undefined;
  let onLoaded: (() => void) | undefined;
  const webContents = {
    getURL: () => currentUrl,
    once: (name: string, handler: () => void) => { if (name === "did-finish-load") onLoaded = handler; },
    on: (name: string, handler: (event: { preventDefault: () => void }, url: string) => void) => {
      if (name === "will-navigate") onNavigate = handler;
    },
  };
  return {
    window: { webContents },
    navigate: (url: string) => {
      onLoaded?.();
      let prevented = false;
      onNavigate?.({ preventDefault: () => { prevented = true; } }, url);
      return { prevented };
    },
  };
}

const browser = { state: () => ({ scopeId: "s" }), createTab: async () => undefined } as never;

test("链接跳到应用自己那一页，也要拦住——那就是「应用突然重启」的样子", () => {
  // 2026-09-14：AI 写了一条 file:// 链接，地址被 Markdown 清空成 ""，点击时空 href
  // 被解析成当前页地址，于是整个应用重载。日志里 renderer_started 连着出现四次。
  // 这条以前是放行的，理由是「跳到当前地址等于没跳」——恰恰相反，它等于整页重载。
  const app = "file:///Applications/CoilCoil.app/Contents/Resources/app.asar/out/renderer/index.html";
  const host = fakeWindow(app);
  installHostNavigationGuard(host.window as never, browser, () => {});
  assert.equal(host.navigate(app).prevented, true, "同址导航必须拦住");
});

test("任何别的地址也一样拦住，网页则另外开到浏览器里", () => {
  const app = "file:///x/index.html";
  const host = fakeWindow(app);
  const activated: string[] = [];
  installHostNavigationGuard(host.window as never, browser, (scopeId) => activated.push(scopeId));
  assert.equal(host.navigate("file:///Users/hao/note.md").prevented, true, "文件地址不能替换掉应用");
  assert.deepEqual(activated, [], "文件不该跑去开浏览器标签");
  assert.equal(host.navigate("https://example.com").prevented, true);
  assert.deepEqual(activated, ["s"], "网页链接照旧开到浏览器里");
});

test("只有 http/https 才算得上可以打开的网址", () => {
  assert.equal(routableHostUrl("https://example.com/"), "https://example.com/");
  assert.equal(routableHostUrl("file:///x"), undefined);
  assert.equal(routableHostUrl("javascript:alert(1)"), undefined);
  assert.equal(routableHostUrl("不是网址"), undefined);
});
