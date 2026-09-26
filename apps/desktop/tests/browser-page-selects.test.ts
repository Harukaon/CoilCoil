import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import type { WebContents } from "electron";
import { PageSelects } from "../src/main/browser-page-selects.ts";
import type { BrowserPageEvent } from "../src/shared/desktop-api.ts";

function fixture(budgetMs = 150) {
  const events: BrowserPageEvent[] = [];
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  let current = true;
  let connected = true;
  let gate: Promise<void> | undefined;
  const fired: string[] = [];
  let focused = 0;
  const select = {
    nodeType: 1, tagName: "SELECT", size: 0, multiple: false, disabled: false, selectedIndex: 0,
    get isConnected() { return connected; },
    options: [
      { label: "苹果", value: "a", disabled: false },
      { label: "香蕉", value: "b", disabled: false },
    ],
    ownerDocument: { defaultView: null },
    closest: () => select,
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 30 }),
    dispatchEvent: (event: Event) => { fired.push(event.type); },
    focus: () => { focused++; },
  };
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    debugger: {
      isAttached: () => true,
      sendCommand: async (method: string, params: Record<string, any>) => {
        calls.push({ method, params });
        if (method === "DOM.getNodeForLocation") { await gate; return { backendNodeId: 42 }; }
        if (method === "DOM.resolveNode") return { object: { objectId: "select" } };
        if (method === "Runtime.callFunctionOn") {
          const fn = new Function(`return (${params.functionDeclaration});`)();
          const value = fn.apply(select, (params.arguments ?? []).map((a: { value: unknown }) => a.value));
          // CDP 的 byValue 结果可能按键名排序，不能靠 JSON 属性顺序比较选项。
          if (value?.options) value.options = value.options.map((option: Record<string, unknown>) =>
            Object.fromEntries(Object.keys(option).sort().map((key) => [key, option[key]])));
          return { result: { value } };
        }
        return {};
      },
    },
  });
  const manager = new PageSelects((event) => events.push(event), () => current, budgetMs);
  return { events, calls, contents: contents as unknown as WebContents, manager, fired, select,
    focused: () => focused,
    setCurrent: (value: boolean) => { current = value; },
    setConnected: (value: boolean) => { connected = value; },
    setGate: (promise: Promise<void>) => { gate = promise; },
  };
}
const point = { x: 20, y: 30 };
const openedId = (events: BrowserPageEvent[]) => {
  const event = events.find((item) => item.kind === "select" && item.picker);
  assert.ok(event?.kind === "select" && event.picker);
  return event.picker.id;
};

test("选择只生效一次，并触发 input/change", async () => {
  const f = fixture();
  assert.equal(await f.manager.intercept("tab", f.contents, point), true);
  assert.equal(f.focused(), 1, "像真的点下拉框一样，焦点给它");
  const id = openedId(f.events);
  await f.manager.choose("tab", id, 1);
  await f.manager.choose("tab", id, 0);
  assert.equal(f.select.selectedIndex, 1);
  assert.deepEqual(f.fired, ["input", "change"]);
  assert.deepEqual(f.events.at(-1), { tabId: "tab", kind: "select", picker: null });
});

test("选项变化、控件已删除或分组被禁用，旧选择不能覆盖页面", async () => {
  for (const changed of ["options", "disconnected", "disabled-group"]) {
    const f = fixture();
    await f.manager.intercept("tab", f.contents, point);
    const id = openedId(f.events);
    if (changed === "options") f.select.options[1].value = "changed";
    if (changed === "disconnected") f.setConnected(false);
    if (changed === "disabled-group") Object.assign(f.select.options[1], { parentElement: { tagName: "OPTGROUP", label: "group", disabled: true } });
    await f.manager.choose("tab", id, 1);
    assert.equal(f.select.selectedIndex, 0, changed);
    assert.deepEqual(f.fired, [], changed);
  }
});

test("导航关掉菜单，旧卡片的回答不写回网页", async () => {
  const f = fixture();
  await f.manager.intercept("tab", f.contents, point);
  const id = openedId(f.events);
  f.contents.emit("did-start-navigation", {}, "https://next.test", false, true);
  await f.manager.choose("tab", id, 1);
  assert.deepEqual(f.fired, []);
  assert.deepEqual(f.events.at(-1), { tabId: "tab", kind: "select", picker: null });
});

test("超时命中结果不补弹菜单、不改变焦点，临时 DOM 引用照常释放", async () => {
  const f = fixture(5);
  let release!: () => void;
  f.setGate(new Promise<void>((resolve) => { release = resolve; }));
  assert.equal(await f.manager.intercept("tab", f.contents, point), false);
  release();
  await nextTurn();
  assert.deepEqual(f.events, []);
  assert.equal(f.focused(), 0);
  assert.equal(f.calls.some((call) => call.method === "Runtime.releaseObject"), true);
});

test("命中期间切到另一页，旧点击作废且不弹列表", async () => {
  const f = fixture();
  let release!: () => void;
  f.setGate(new Promise<void>((resolve) => { release = resolve; }));
  const pending = f.manager.intercept("tab", f.contents, point);
  f.setCurrent(false);
  release();
  assert.equal(await pending, true);
  assert.deepEqual(f.events, []);
  assert.equal(f.focused(), 0);
});

test("命中的是下拉框里的文字节点时，读、聚焦、写回都落在下拉框本身", async () => {
  const f = fixture();
  const text = { nodeType: 3, parentElement: f.select };
  const calls = f.calls;
  // 让 resolveNode 之后的脚本以文字节点为 this 执行。
  const original = (f.contents as any).debugger.sendCommand;
  (f.contents as any).debugger.sendCommand = async (method: string, params: Record<string, any>) => {
    if (method === "Runtime.callFunctionOn") {
      calls.push({ method, params });
      const fn = new Function(`return (${params.functionDeclaration});`)();
      return { result: { value: fn.apply(text, (params.arguments ?? []).map((a: { value: unknown }) => a.value)) } };
    }
    return original(method, params);
  };
  assert.equal(await f.manager.intercept("tab", f.contents, point), true);
  await f.manager.choose("tab", openedId(f.events), 1);
  assert.equal(f.focused(), 1);
  assert.equal(f.select.selectedIndex, 1);
  assert.deepEqual(f.fired, ["input", "change"]);
});

test("选项文字过长时截断，异常页面撑不爆消息", async () => {
  const f = fixture();
  f.select.options[0].label = "x".repeat(10_000);
  await f.manager.intercept("tab", f.contents, point);
  const event = f.events.find((item) => item.kind === "select" && item.picker);
  assert.ok(event?.kind === "select" && event.picker);
  assert.equal(event.picker.options[0].label.length, 500);
});
