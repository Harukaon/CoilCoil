import assert from "node:assert/strict";
import test from "node:test";
import { isDirectPageTargetInfoRequest, isSharedStateReset, isTabActivationCommand, routePageCommand } from "../src/main/browser-cdp-commands.ts";

test("Page.reload is routed through Page.navigate without changing target identity", () => {
  assert.deepEqual(routePageCommand("Page.reload", { ignoreCache: true }, "http://127.0.0.1:8765/test"), {
    method: "Page.navigate",
    params: { url: "http://127.0.0.1:8765/test", transitionType: "reload" },
    resetCache: true,
  });
});

test("ordinary page commands pass through unchanged", () => {
  const params = { expression: "document.title" };
  assert.deepEqual(routePageCommand("Runtime.evaluate", params, "about:blank"), {
    method: "Runtime.evaluate",
    params,
    resetCache: false,
  });
});

test("direct Lighthouse sessions receive the synthetic page target", () => {
  assert.equal(isDirectPageTargetInfoRequest("Target.getTargetInfo", {}, "page-1"), true);
  assert.equal(isDirectPageTargetInfoRequest("Target.getTargetInfo", { targetId: "page-1" }, "page-1"), true);
  assert.equal(isDirectPageTargetInfoRequest("Target.getTargetInfo", { targetId: "page-2" }, "page-1"), false);
  assert.equal(isDirectPageTargetInfoRequest("Runtime.evaluate", {}, "page-1"), false);
});

test("bringing a tab to the front never reaches the guest", () => {
  // Forwarded, Chromium activates the embedder and raises the whole app — even
  // out of the dock, while the agent works in the background. The bridge answers
  // it by switching the visible tab instead.
  assert.equal(isTabActivationCommand("Page.bringToFront"), true);
  assert.equal(isTabActivationCommand("Page.navigate"), false);
  assert.equal(isTabActivationCommand("Input.dispatchMouseEvent"), false);
  // Routing must not quietly turn it into something forwardable either.
  assert.equal(routePageCommand("Page.bringToFront", {}, "about:blank").method, "Page.bringToFront");
});

test("Agent 关不掉页面上共用的开关：Page.disable 和关掉选文件拦截不往下传；Runtime 照常", () => {
  assert.equal(isSharedStateReset("Page.disable", {}), true);
  assert.equal(isSharedStateReset("Runtime.disable", {}), false);
  assert.equal(isSharedStateReset("Page.setInterceptFileChooserDialog", { enabled: false }), true);
  assert.equal(isSharedStateReset("Page.setInterceptFileChooserDialog", {}), true);
  // 打开拦截、其余命令照常转：Agent 自己等着接文件选择（upload_file）要用。
  assert.equal(isSharedStateReset("Page.setInterceptFileChooserDialog", { enabled: true }), false);
  assert.equal(isSharedStateReset("Page.enable", {}), false);
  assert.equal(isSharedStateReset("Network.disable", {}), false);
});
