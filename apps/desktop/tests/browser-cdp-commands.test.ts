import assert from "node:assert/strict";
import test from "node:test";
import { isDirectPageTargetInfoRequest, routePageCommand } from "../src/main/browser-cdp-commands.ts";

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
