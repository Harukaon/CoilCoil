import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCdpBridge, type BrowserCdpHost } from "../src/main/browser-cdp-bridge.ts";
import { detachDebuggerListener } from "../src/main/browser-cdp-teardown.ts";
import type { BrowserTab } from "../src/main/browser-runtime-types.ts";

function guest(options: {
  destroyed?: boolean;
  off?: () => void;
} = {}) {
  let destroyed = options.destroyed ?? false;
  return {
    isDestroyed: () => destroyed,
    debugger: {
      off: () => {
        options.off?.();
      },
    },
    destroy: () => { destroyed = true; },
  };
}

test("debugger listener teardown ignores an already destroyed guest", () => {
  let called = false;
  assert.doesNotThrow(() => detachDebuggerListener(guest({ destroyed: true, off: () => { called = true; } }), () => {}));
  assert.equal(called, false);
});

test("debugger listener teardown tolerates destruction during off", () => {
  let called = false;
  let destroyedDuringOff: ReturnType<typeof guest>;
  destroyedDuringOff = guest({
    off: () => {
      called = true;
      destroyedDuringOff.destroy();
      throw new Error("Object has been destroyed");
    },
  });
  assert.doesNotThrow(() => detachDebuggerListener(destroyedDuringOff, () => {}));
  assert.equal(called, true);
});

test("debugger listener teardown preserves unrelated errors", () => {
  const failure = new Error("unexpected debugger failure");
  assert.throws(() => detachDebuggerListener(guest({ off: () => { throw failure; } }), () => {}), failure);
});

test("debugger listener teardown detaches a live guest", () => {
  let called = false;
  detachDebuggerListener(guest({ off: () => { called = true; } }), () => {});
  assert.equal(called, true);
});

// ---- Agent 的哪些动作算「正在操作」（面板亮提示、上限收页时不算久没用）----


/** 桥里这几个方法是私有的，测试直接调。 */
type BridgeInternals = {
  executeRootCommand(client: unknown, method: string, params: Record<string, unknown>): Promise<unknown>;
  executeCdp(client: unknown, request: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }): Promise<unknown>;
};

function fakeTab(id: string, extra: Record<string, unknown> = {}): BrowserTab {
  return { id, scopeId: "scope", partition: "p", owner: "user", lastUsedAt: 0, tabTargetId: `tab-${id}`, pageTargetId: `page-${id}`, phase: "ready", announced: true, ...extra } as unknown as BrowserTab;
}

function fakeHost(tabs: BrowserTab[], blank?: BrowserTab) {
  const noted: string[] = [];
  const selected: string[] = [];
  const created: BrowserTab[] = [];
  const host = {
    noteAgentUse: (tab: BrowserTab) => { noted.push(tab.id); },
    selectTab: (id: string) => { selected.push(id); },
    createTab: async (_url: string | undefined, _activate: boolean, scopeId: string) => {
      const tab = fakeTab(`new${created.length + 1}`, { owner: "agent", scopeId });
      created.push(tab);
      tabs.push(tab);
      return tab;
    },
    blankPlaceholder: () => blank,
    cdpTabs: () => tabs,
    tabById: (id: string) => tabs.find((tab) => tab.id === id),
    guestOf: () => ({ loadURL: async () => undefined, debugger: { sendCommand: async () => ({ product: "Chrome/test" }) } }),
    anyReadyTab: () => undefined,
    ensureActiveTab: async () => {
      const tab = fakeTab("implicit", { owner: "agent", implicit: true });
      tabs.push(tab);
      return tab;
    },
  } as unknown as BrowserCdpHost;
  return { bridge: new BrowserCdpBridge(host) as unknown as BridgeInternals, noted, selected, created };
}

function fakeClient(sessions: Array<[string, { tabSessionId: string; pageSessionId: string; pageAttached: boolean }]> = []) {
  return {
    id: "client-1", scopeId: "scope", socket: { send: () => undefined }, discover: false, autoAttach: false,
    sessions: new Map(sessions), directSessions: new Map(), childSessions: new Map(), debuggerListeners: new Map(),
  };
}

test("Agent 开新页（Target.createTarget）：算它在操作，只开空页也算", async () => {
  const f = fakeHost([]);
  const result = await f.bridge.executeRootCommand(fakeClient(), "Target.createTarget", { url: "about:blank" });
  assert.deepEqual(result, { targetId: f.created[0].pageTargetId });
  assert.deepEqual(f.noted, [f.created[0].id]);
});

test("Agent 开新页时复用了垫着的空白页：一样算它在操作", async () => {
  const blank = fakeTab("blank", { owner: "agent", implicit: true });
  const f = fakeHost([blank], blank);
  await f.bridge.executeRootCommand(fakeClient(), "Target.createTarget", { url: "https://example.com/" });
  assert.deepEqual(f.noted, ["blank"]);
  assert.equal(f.created.length, 0, "没有另开一张");
});

test("Agent 切到某张（Target.activateTarget、Page.bringToFront）：算它在操作，面板切过去；找不到的不算", async () => {
  const user = fakeTab("user");
  const f = fakeHost([user]);
  await f.bridge.executeRootCommand(fakeClient(), "Target.activateTarget", { targetId: user.pageTargetId });
  assert.deepEqual(f.noted, ["user"]);
  assert.deepEqual(f.selected, ["user"]);
  await f.bridge.executeRootCommand(fakeClient(), "Target.activateTarget", { targetId: "page-missing" });
  assert.deepEqual(f.noted, ["user"], "找不到的目标不记");
  const client = fakeClient([["user", { tabSessionId: "tab-session", pageSessionId: "page-session", pageAttached: true }]]);
  assert.deepEqual(await f.bridge.executeCdp(client, { id: 1, method: "Page.bringToFront", sessionId: "page-session" }), {});
  assert.deepEqual(f.noted, ["user", "user"]);
  assert.deepEqual(f.selected, ["user", "user"]);
});

test("桥自己为了答浏览器版本垫的空白页：不算 Agent 在操作", async () => {
  const f = fakeHost([]);
  await f.bridge.executeRootCommand(fakeClient(), "Browser.getVersion", {});
  assert.deepEqual(f.noted, []);
});
