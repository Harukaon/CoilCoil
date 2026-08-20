import assert from "node:assert/strict";
import test from "node:test";
import { isDirectPageTargetInfoRequest, isTabActivationCommand, routePageCommand } from "../src/main/browser-cdp-commands.ts";

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
