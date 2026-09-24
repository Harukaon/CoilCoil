import assert from "node:assert/strict";
import test from "node:test";
import { agentTabsToRecycle, isAgentTabUse } from "../src/main/browser-agent-tabs.ts";

const tab = (id: string, owner: "agent" | "user", lastUsedAt: number) => ({ id, owner, lastUsedAt });

test("没超上限就一张都不收", () => {
  const tabs = [tab("a", "agent", 1), tab("b", "agent", 2), tab("u", "user", 0)];
  assert.deepEqual(agentTabsToRecycle(tabs, new Set(), 5), []);
});

test("超上限时只收 Agent 的、最久没用的那张；用户的再老也不动", () => {
  const tabs = [tab("u", "user", 0), ...[1, 2, 3, 4, 5, 6].map((n) => tab(`p${n}`, "agent", n))];
  assert.deepEqual(agentTabsToRecycle(tabs, new Set(["p6"]), 5).map((t) => t.id), ["p1"]);
});

test("刚开的和当前显示的那张不收，哪怕它们最老", () => {
  const tabs = [1, 2, 3, 4, 5, 6].map((n) => tab(`p${n}`, "agent", n));
  assert.deepEqual(agentTabsToRecycle(tabs, new Set(["p6", "p1"]), 5).map((t) => t.id), ["p2"]);
});

test("看的是最近一次使用，不是打开的先后", () => {
  const tabs = [tab("p1", "agent", 100), tab("p2", "agent", 2), tab("p3", "agent", 3), tab("p4", "agent", 4), tab("p5", "agent", 5), tab("p6", "agent", 6)];
  assert.deepEqual(agentTabsToRecycle(tabs, new Set(["p6"]), 5).map((t) => t.id), ["p2"]);
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
