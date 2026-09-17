import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { BrowserStateSnapshot } from "../src/shared/desktop-api.ts";
import {
  shouldCloseBrowserEntry,
  activeBrowserPaneTabId,
  BROWSER_PLACEHOLDER_TAB_ID,
  browserPaneTabId,
  browserPaneTabs,
  browserTabIdFromPaneId,
  ownBrowserTabCount,
} from "../src/renderer/src/features/inspector/inspectorTabs.ts";

const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");

function source(relativePath: string): string {
  return readFileSync(resolve(rendererRoot, relativePath), "utf8");
}

function page(id: string, title: string, loading = false, foreign = false): BrowserStateSnapshot["tabs"][number] {
  return { id, title, url: `https://example.com/${id}`, loading, canGoBack: false, canGoForward: false, ...(foreign ? { foreign } : {}) };
}

test("每个网页标签都是顶部标签条上的一个标签", () => {
  const state: BrowserStateSnapshot = {
    scopeId: "runtime-1",
    tabs: [page("a", "第一页"), page("b", "第二页", true)],
    activeTabId: "b",
  };

  assert.deepEqual(browserPaneTabs(state), [
    { id: "browser:a", label: "第一页", loading: false, foreign: false },
    { id: "browser:b", label: "第二页", loading: true, foreign: false },
  ]);
  assert.equal(activeBrowserPaneTabId(state), "browser:b");
});

test("还没有网页标签时留一个占位，标签条不会空掉", () => {
  // 空掉的话右侧栏会退回「打开一个面板」的空状态，第一个网页建好又跳回来。
  const empty: BrowserStateSnapshot = { scopeId: "runtime-1", tabs: [] };
  assert.deepEqual(browserPaneTabs(empty), [{ id: BROWSER_PLACEHOLDER_TAB_ID, label: "浏览器", loading: true, foreign: false }]);
  assert.equal(activeBrowserPaneTabId(empty), BROWSER_PLACEHOLDER_TAB_ID);
});

test("主进程说的 activeTabId 失效时退回第一个标签", () => {
  // agent 关掉当前标签、快照还没追上的那一瞬间，标签条不能一个都不选中。
  const state: BrowserStateSnapshot = { scopeId: "s", tabs: [page("a", "第一页")], activeTabId: "gone" };
  assert.equal(activeBrowserPaneTabId(state), "browser:a");
});

test("别的会话开的标签页也画在这一排上，并且标得出来", () => {
  // 这是「应用在背后做的事都要让用户看得见」那一条：agent 在别的 scope 里开的页面
  // 会加载、会跑脚本、会写 cookie，它不能在用户屏幕上不存在。
  const state: BrowserStateSnapshot = {
    scopeId: "runtime-1",
    tabs: [page("mine", "我的页"), page("theirs", "另一个会话的页", false, true)],
    activeTabId: "mine",
  };

  assert.deepEqual(browserPaneTabs(state), [
    { id: "browser:mine", label: "我的页", loading: false, foreign: false },
    { id: "browser:theirs", label: "另一个会话的页", loading: false, foreign: true },
  ]);
  // 「补建一张」和「收起浏览器」都只数自己的那几张。
  assert.equal(ownBrowserTabCount(state), 1);
  assert.equal(ownBrowserTabCount({ scopeId: "runtime-1", tabs: [page("theirs", "只有别人的", false, true)] }), 0);
});

test("标签条 id 认得出哪个是网页标签", () => {
  assert.equal(browserTabIdFromPaneId(browserPaneTabId("tab-9")), "tab-9");
  // 占位标签、终端、文件都不是网页标签，不能被当成主进程的 tab id。
  assert.equal(browserTabIdFromPaneId(BROWSER_PLACEHOLDER_TAB_ID), undefined);
  assert.equal(browserTabIdFromPaneId("terminal:shell-a"), undefined);
  assert.equal(browserTabIdFromPaneId("file:/tmp/a.ts"), undefined);
  assert.equal(browserTabIdFromPaneId("files"), undefined);
});

test("浏览器面板内部不再自带一条标签条", () => {
  const panel = source("features/browser/BrowserPanel.tsx");
  for (const marker of ["browser-tab-strip", "browser-tabs", "browser-new-tab", "browser-tab-select"]) {
    assert.ok(!panel.includes(marker), `BrowserPanel 里还留着 ${marker}`);
  }
  const styles = source("styles.css");
  for (const marker of [".browser-tab-strip", ".browser-tabs", ".browser-new-tab"]) {
    assert.ok(!styles.includes(marker), `styles.css 里还留着 ${marker}`);
  }
  // 面板只剩地址栏和网页两行。
  assert.match(styles, /^\.browser-panel \{[^}]*grid-template-rows: 34px minmax\(0, 1fr\);/m);
});

test("顶部标签条对浏览器的操作还是走原来那几个 IPC", () => {
  // agent 用 MCP 开关标签走的是主进程的 BrowserRuntimeManager，和这里是同一份状态。
  // UI 换位置不能顺手换协议，否则两边会看到不一样的标签集合。
  const inspector = source("features/inspector/WorkspaceInspector.tsx");
  for (const call of ["window.coilcoil.createBrowserTab", "window.coilcoil.selectBrowserTab", "window.coilcoil.closeBrowserTab"]) {
    assert.ok(inspector.includes(call), `WorkspaceInspector 没有调用 ${call}`);
  }
  // 标签集合只来自主进程的快照，右侧栏状态里不会另存一份。
  const state = source("features/inspector/useWorkspaceInspector.ts");
  assert.ok(!state.includes("browserTabId"), "网页标签不应该进 useWorkspaceInspector 的状态");
});

test("只剩别的会话开的标签页时，浏览器面板不能自己折叠", () => {
  const mine = page("mine", "我的页");
  const theirs = page("theirs", "另一个会话的页", false, true);
  // 关掉自己最后一张：标签条上还列着别人的那张，面板就不能撤。
  assert.equal(shouldCloseBrowserEntry({ scopeId: "s", tabs: [theirs], activeTabId: "theirs" }), false);
  // 真的一张都不剩了才撤。
  assert.equal(shouldCloseBrowserEntry({ scopeId: "s", tabs: [], activeTabId: undefined }), true);
  // 自己的还在当然也不撤。
  assert.equal(shouldCloseBrowserEntry({ scopeId: "s", tabs: [mine, theirs], activeTabId: "mine" }), false);
});
