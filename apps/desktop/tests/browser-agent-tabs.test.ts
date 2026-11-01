import assert from "node:assert/strict";
import test from "node:test";
import { assertBrowserTabCapacity, isAgentTabUse, isSettledAgentBlank, SESSION_TAB_LIMIT } from "../src/main/browser-agent-tabs.ts";

test("eight tabs is a hard session cap; rejection tells callers to reuse or close, never evicts", () => {
  assert.equal(SESSION_TAB_LIMIT, 8);
  for (let count = 0; count < 8; count += 1) assert.doesNotThrow(() => assertBrowserTabCapacity(count));
  assert.throws(() => assertBrowserTabCapacity(8), /8 browser tabs.*Reuse.*close/);
  assert.throws(() => assertBrowserTabCapacity(9), /8 browser tabs/);
});

test("settled blank cleanup keeps user pages, interacted pages, loading pages and real content", () => {
  const agent = { owner: "agent" as const, phase: "ready" };
  assert.equal(isSettledAgentBlank(agent, "about:blank", false), true);
  assert.equal(isSettledAgentBlank({ ...agent, owner: "user" }, "about:blank", false), false);
  assert.equal(isSettledAgentBlank({ ...agent, userInputAt: 0 }, "about:blank", false), false);
  for (const phase of ["creating", "loading", "closing"]) assert.equal(isSettledAgentBlank({ ...agent, phase }, "about:blank", false), false);
  assert.equal(isSettledAgentBlank(agent, "about:blank", true), false);
  assert.equal(isSettledAgentBlank(agent, "https://example.com", false), false);
  assert.equal(isSettledAgentBlank(agent, "", false), false);
});

test("只有有意图的动作才算用过这张页", () => {
  for (const method of ["Page.navigate", "Page.reload", "Input.dispatchMouseEvent", "Input.insertText", "Accessibility.getFullAXTree", "Page.captureScreenshot"]) {
    assert.equal(isAgentTabUse(method), true, method);
  }
  // chrome-devtools-mcp 每次列页面都会给所有页面发这些，它们不算。
  for (const method of ["Runtime.callFunctionOn", "Runtime.enable", "Network.enable", "Storage.getStorageKey", "Debugger.setBlackboxExecutionContexts"]) {
    assert.equal(isAgentTabUse(method), false, method);
  }
});
