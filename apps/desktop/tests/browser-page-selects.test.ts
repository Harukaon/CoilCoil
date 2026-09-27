import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import type { WebContents } from "electron";
import { PageSelects, parseReadResult } from "../src/main/browser-page-selects.ts";
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

/** 日期、时间、颜色框：假的输入框、假的浏览器内部结构（小日历图标 99 号，在输入框右边 186..206）。 */
function valueFixture(type: string, options: { iconHidden?: boolean; focusedByKeyboard?: boolean } = {}) {
  const events: BrowserPageEvent[] = [];
  const fired: string[] = [];
  let current = true;
  const input: Record<string, any> = {
    nodeType: 1, tagName: "INPUT", type, value: type === "color" ? "#336699" : "2026-09-26", min: "", max: "", step: "",
    disabled: false, readOnly: false, isConnected: true,
    ownerDocument: { defaultView: null },
    closest: () => null,
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 200, height: 30 }),
    dispatchEvent: (event: Event) => { fired.push(`${event.type}:${input.value}`); },
    focus: () => undefined,
  };
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    debugger: {
      isAttached: () => true,
      sendCommand: async (method: string, params: Record<string, any>) => {
        if (method === "DOM.getNodeForLocation") return { backendNodeId: 42 };
        if (method === "Runtime.evaluate") return { result: { objectId: "focused" } };
        if (method === "DOM.describeNode" && params.objectId) return { node: { backendNodeId: 42 } };
        if (method === "DOM.describeNode") {
          return { node: { backendNodeId: 42, shadowRoots: [{ children: [{ backendNodeId: 7, attributes: ["pseudo", "-webkit-datetime-edit"] },
            { backendNodeId: 99, attributes: ["pseudo", "-webkit-calendar-picker-indicator"] }] }] } };
        }
        if (method === "DOM.getBoxModel") {
          if (params.backendNodeId === 42) return { model: { border: [10, 20, 210, 20, 210, 50, 10, 50] } };
          if (options.iconHidden) throw new Error("Could not compute box model.");
          return { model: { border: [186, 24, 206, 24, 206, 46, 186, 46] } };
        }
        if (method === "DOM.resolveNode") return { object: { objectId: "input" } };
        if (method === "Runtime.callFunctionOn") {
          const fn = new Function(`return (${params.functionDeclaration});`)();
          return { result: { value: fn.apply(input, (params.arguments ?? []).map((a: { value: unknown }) => a.value)) } };
        }
        return {};
      },
    },
  });
  const manager = new PageSelects((event) => events.push(event), () => current);
  return { events, fired, input, contents: contents as unknown as WebContents, manager, setCurrent: (value: boolean) => { current = value; } };
}
const valueOpened = (events: BrowserPageEvent[]) => {
  const event = events.find((item) => item.kind === "value-picker" && item.picker);
  assert.ok(event?.kind === "value-picker" && event.picker);
  return event.picker;
};

test("日期框：点在小日历图标上才打开，点在年月日上照常送进页面", async () => {
  const text = valueFixture("date");
  assert.equal(await text.manager.intercept("tab", text.contents, { x: 40, y: 35 }), false);
  assert.equal(text.events.length, 0);
  const icon = valueFixture("date");
  assert.equal(await icon.manager.intercept("tab", icon.contents, { x: 196, y: 35 }), true);
  const picker = valueOpened(icon.events);
  assert.equal(picker.type, "date");
  assert.equal(picker.value, "2026-09-26");
  assert.deepEqual(picker.rect, { x: 10, y: 20, width: 200, height: 30 });
});

test("网页把小日历图标藏起来了：点右边也不打开（和 Chrome 一样）", async () => {
  const f = valueFixture("date", { iconHidden: true });
  assert.equal(await f.manager.intercept("tab", f.contents, { x: 196, y: 35 }), false);
  assert.equal(f.events.length, 0);
});

test("颜色框点哪儿都打开；键盘：颜色框按空格/回车，日期类按 Alt+↓", async () => {
  const color = valueFixture("color");
  assert.equal(await color.manager.intercept("tab", color.contents, { x: 40, y: 35 }), true);
  assert.equal(valueOpened(color.events).type, "color");
  const colorKey = valueFixture("color");
  assert.equal(await colorKey.manager.intercept("tab", colorKey.contents, undefined, { key: " ", alt: false }), true);
  const dateSpace = valueFixture("date");
  assert.equal(await dateSpace.manager.intercept("tab", dateSpace.contents, undefined, { key: " ", alt: false }), false, "空格在日期框里是改那一格");
  const dateAltDown = valueFixture("time");
  assert.equal(await dateAltDown.manager.intercept("tab", dateAltDown.contents, undefined, { key: "ArrowDown", alt: true }), true);
});

test("选的值写回：中间值只发 input，选完发 change 并收起；收起后再来的不收", async () => {
  const f = valueFixture("color");
  await f.manager.intercept("tab", f.contents, { x: 40, y: 35 });
  const { id } = valueOpened(f.events);
  await f.manager.chooseValue("tab", id, "#112233", false);
  await f.manager.chooseValue("tab", id, "#ff0000", true);
  await f.manager.chooseValue("tab", id, "#00ff00", true);
  assert.equal(f.input.value, "#ff0000");
  assert.deepEqual(f.fired, ["input:#112233", "input:#ff0000", "change:#ff0000"]);
  assert.deepEqual(f.events.at(-1), { tabId: "tab", kind: "value-picker", picker: null });
});

test("没选就关、别的选择器的回答、类型被网页改了、切走了：都不写页面", async () => {
  const closed = valueFixture("date");
  await closed.manager.intercept("tab", closed.contents, { x: 196, y: 35 });
  const first = valueOpened(closed.events).id;
  await closed.manager.chooseValue("tab", "someone-else", "2026-01-01", true);
  await closed.manager.chooseValue("tab", first, null, false);
  await closed.manager.chooseValue("tab", first, "2026-01-01", true);
  assert.equal(closed.input.value, "2026-09-26");
  assert.deepEqual(closed.fired, []);

  const retyped = valueFixture("date");
  await retyped.manager.intercept("tab", retyped.contents, { x: 196, y: 35 });
  retyped.input.type = "text";
  await retyped.manager.chooseValue("tab", valueOpened(retyped.events).id, "2026-01-01", true);
  assert.equal(retyped.input.value, "2026-09-26");

  const away = valueFixture("date");
  await away.manager.intercept("tab", away.contents, { x: 196, y: 35 });
  away.setCurrent(false);
  await away.manager.chooseValue("tab", valueOpened(away.events).id, "2026-01-01", true);
  assert.equal(away.input.value, "2026-09-26");
});

test("禁用、只读的日期框不接", async () => {
  for (const flag of ["disabled", "readOnly"]) {
    const f = valueFixture("date");
    f.input[flag] = true;
    assert.equal(await f.manager.intercept("tab", f.contents, { x: 196, y: 35 }), false, flag);
  }
});

test("跨站内嵌页里的下拉框：按排第几个找到那个框架，在里面读选项、写回，收起时清掉引用", async () => {
  const vm = await import("node:vm");
  const events: BrowserPageEvent[] = [];
  const fired: string[] = [];
  const points: Array<[number, number]> = [];
  const select: Record<string, any> = {
    nodeType: 1, tagName: "SELECT", multiple: false, size: 0, disabled: false, isConnected: true, selectedIndex: 1,
    options: ["alpha", "beta", "gamma"].map((label) => ({ label, value: label, disabled: false, parentElement: null })),
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 20 }),
    dispatchEvent: (event: { type: string }) => { fired.push(event.type); },
    focus: () => undefined,
  };
  select.closest = () => select;
  // 内嵌页那个进程：在沙箱里跑真的页面脚本。
  const frameWindow: Record<string, unknown> = {};
  const sandbox = vm.createContext({
    document: { elementFromPoint: (x: number, y: number) => { points.push([x, y]); return select; } },
    frames: { length: 0 },
    window: frameWindow,
    getComputedStyle: () => ({}),
    Event: class { constructor(public type: string) {} },
  });
  // Electron 从别的进程拿回结果时是拷一份过来的：这里也拷一份。
  const frame = {
    detached: false, isDestroyed: () => false, frames: [],
    executeJavaScript: async (code: string) => {
      const result: unknown = vm.runInContext(code, sandbox);
      return result === undefined ? result : JSON.parse(JSON.stringify(result));
    },
  };
  // 主页面：点到的是一个 iframe（边框 3，左上角在 50,40），它是整页的第 0 个框架。
  const childWindow = {};
  const topWindow: Record<string, any> = { frames: { length: 1, 0: childWindow }, getComputedStyle: () => ({ paddingLeft: "0px", paddingTop: "0px" }) };
  topWindow.top = topWindow;
  const iframe = {
    nodeType: 1, tagName: "IFRAME", contentWindow: childWindow, ownerDocument: { defaultView: topWindow },
    clientLeft: 3, clientTop: 3, closest: () => null, getBoundingClientRect: () => ({ x: 50, y: 40, width: 300, height: 200 }),
  };
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    mainFrame: { frames: [frame] },
    debugger: {
      isAttached: () => true,
      sendCommand: async (method: string, params: Record<string, any>) => {
        if (method === "DOM.getNodeForLocation") return { backendNodeId: 5 };
        if (method === "DOM.resolveNode") return { object: { objectId: "iframe" } };
        if (method === "Runtime.callFunctionOn") {
          const fn = new Function(`return (${params.functionDeclaration});`)();
          return { result: { value: fn.apply(iframe, (params.arguments ?? []).map((a: { value: unknown }) => a.value)) } };
        }
        return {};
      },
    },
  }) as unknown as WebContents;
  const manager = new PageSelects((event) => events.push(event));
  assert.equal(await manager.intercept("tab", contents, { x: 80, y: 62 }), true);
  assert.deepEqual(points, [[27, 19]], "在内嵌页里按它自己的坐标找");
  const opened = events.find((event) => event.kind === "select" && event.picker);
  assert.ok(opened?.kind === "select" && opened.picker);
  assert.deepEqual(opened.picker.options.map((option) => option.label), ["alpha", "beta", "gamma"]);
  assert.deepEqual(opened.picker.rect, { x: 63, y: 53, width: 80, height: 20 }, "位置加上内嵌页在整页上的偏移");
  // 存成不可枚举的：网页脚本遍历 window 时碰不到它。
  assert.equal(Object.getOwnPropertyNames(frameWindow).length, 1, "控件引用存在内嵌页的 window 上");
  assert.equal(Object.keys(frameWindow).length, 0);
  await manager.choose("tab", opened.picker.id, 2);
  assert.equal(select.selectedIndex, 2);
  assert.deepEqual(fired, ["input", "change"]);
  await nextTurn();
  assert.equal(Object.getOwnPropertyNames(frameWindow).length, 0, "收起后引用拿掉了");
});

test("网页读回来的控件信息逐项核对：正常的照收，被篡改的（太多、类型不对、太长、数字不正常）一律不弹", () => {
  const rect = { x: 10, y: 20, width: 100, height: 30 };
  const option = (label: string) => ({ label, value: label, disabled: false, group: "" });
  const select = { kind: "select", positioned: true, rect, selectedIndex: 1, options: [option("a"), option("b")] };
  assert.deepEqual(parseReadResult(select), select);
  assert.equal(parseReadResult({ ...select, selectedIndex: 9 })?.kind === "select" && (parseReadResult({ ...select, selectedIndex: 9 }) as { selectedIndex: number }).selectedIndex, -1);
  assert.equal(parseReadResult({ ...select, options: Array.from({ length: 2001 }, (_, i) => option(String(i))) }), undefined, "超过 2000 项");
  assert.equal(parseReadResult({ ...select, options: [] }), undefined);
  assert.equal(parseReadResult({ ...select, options: [{ ...option("a"), label: 42 }] }), undefined, "类型不对");
  assert.equal(parseReadResult({ ...select, options: [option("x".repeat(501))] }), undefined, "字太长");
  assert.equal(parseReadResult({ ...select, options: [{ ...option("a"), disabled: "no" }] }), undefined);
  assert.equal(parseReadResult({ ...select, rect: { ...rect, x: Number.NaN } }), undefined, "数字不正常");
  assert.equal(parseReadResult({ ...select, rect: { ...rect, width: -1 } }), undefined);
  assert.equal(parseReadResult({ ...select, rect: { ...rect, y: 1e9 } }), undefined);
  const value = { kind: "value", positioned: false, rect, type: "date", value: "2026-09-26", min: "", max: "", step: "" };
  assert.deepEqual(parseReadResult(value), value);
  assert.equal(parseReadResult({ ...value, type: "text" }), undefined, "不认识的类型");
  assert.equal(parseReadResult({ ...value, value: "x".repeat(65) }), undefined);
  assert.equal(parseReadResult({ ...value, min: 3 }), undefined);
  assert.equal(parseReadResult({ kind: "other", rect }), undefined);
  assert.equal(parseReadResult(null), undefined);
  assert.equal(parseReadResult("select"), undefined);
});
