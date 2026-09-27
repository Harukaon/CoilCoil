import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CARET_WORLD_ID } from "../src/main/browser-page-caret.ts";
import { parseTooltip, readPageTooltip, TOOLTIP_SCRIPT } from "../src/main/browser-page-tooltip.ts";

type Fake = Record<string, any>;

/** 假元素：只有脚本要用的那几样。 */
function element(tagName: string, attributes: Record<string, string> = {}, extra: Fake = {}): Fake {
  const node: Fake = {
    nodeType: 1, tagName, namespaceURI: "http://www.w3.org/1999/xhtml", children: [], parentElement: null,
    getAttribute: (name: string) => (name in attributes ? attributes[name] : null),
    getRootNode: () => ({}),
    ...extra,
  };
  return node;
}
function nest(parent: Fake, child: Fake): Fake {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}
/** 在假网页里跑提示脚本：点 (x, y)，看拿回什么。 */
function tooltipAt(document: Fake, x = 10, y = 20): unknown {
  const view = { getComputedStyle: () => ({ paddingLeft: "2px", paddingTop: "3px" }) };
  return vm.runInNewContext(`${TOOLTIP_SCRIPT}(${x}, ${y})`, { document, window: view });
}
const page = (hit: Fake): Fake => ({ elementFromPoint: () => hit });

test("从指到的元素往上找第一个带 title 的；title 是空的挡住外层的提示", () => {
  const outer = element("DIV", { title: "外层提示" });
  const inner = nest(outer, element("SPAN"));
  assert.equal(tooltipAt(page(inner)), "外层提示");
  const blank = nest(outer, element("SPAN", { title: "" }));
  assert.equal(tooltipAt(page(blank)), null);
  const spaces = nest(outer, element("SPAN", { title: "   " }));
  assert.equal(tooltipAt(page(spaces)), null);
  assert.equal(tooltipAt(page(element("DIV"))), null, "没有 title 就没有提示");
  assert.equal(tooltipAt({ elementFromPoint: () => null }), null);
});

test("SVG 用它里面的 <title>，保留网页写的换行", () => {
  const svg = element("svg", {}, { namespaceURI: "http://www.w3.org/2000/svg" });
  const rect = nest(svg, element("rect", {}, { namespaceURI: "http://www.w3.org/2000/svg" }));
  nest(rect, element("title", {}, { namespaceURI: "http://www.w3.org/2000/svg", textContent: "  红色方块  " }));
  assert.equal(tooltipAt(page(rect)), "红色方块");
  assert.equal(tooltipAt(page(element("DIV", { title: "第一行\n第二行" }))), "第一行\n第二行");
});

test("同源内嵌页往里找（坐标减去内嵌页的位置）；跨源的看不进去就不出提示", () => {
  const points: Array<[number, number]> = [];
  const target = element("BUTTON", { title: "内嵌页里的按钮" });
  const inner = { elementFromPoint: (x: number, y: number) => { points.push([x, y]); return target; } };
  const frame = element("IFRAME", {}, {
    contentDocument: inner, clientLeft: 1, clientTop: 1,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ paddingLeft: "2px", paddingTop: "3px" }) } },
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
  });
  assert.equal(tooltipAt(page(frame), 150, 90), "内嵌页里的按钮");
  assert.deepEqual(points, [[150 - 103, 90 - 54]]);
  // 读 contentDocument 就报错（跨源）：属性要在建好以后装上，展开语法拷的时候就会去读它。
  const crossOrigin = element("IFRAME");
  Object.defineProperty(crossOrigin, "contentDocument", { get() { throw new Error("cross-origin"); } });
  assert.equal(tooltipAt(page(crossOrigin)), null);
});

test("打开的 shadow DOM 往里找；里面没有 title 时顺着宿主往外找", () => {
  const host = element("MY-BUTTON", { title: "宿主的提示" });
  const shadowRoot: Fake = { host };
  const withTitle = element("SPAN", { title: "里面的提示" }, { getRootNode: () => shadowRoot });
  host.shadowRoot = { elementFromPoint: () => withTitle };
  assert.equal(tooltipAt(page(host)), "里面的提示");
  const plain = element("SPAN", {}, { getRootNode: () => shadowRoot });
  host.shadowRoot = { elementFromPoint: () => plain };
  assert.equal(tooltipAt(page(host)), "宿主的提示");
});

test("页面回来的提示逐项核对", () => {
  assert.equal(parseTooltip("保存"), "保存");
  assert.equal(parseTooltip("a\r\nb\rc"), "a\nb\nc");
  assert.equal(parseTooltip("x".repeat(5000))?.length, 1000);
  assert.equal(parseTooltip("   "), null);
  assert.equal(parseTooltip(42), null);
  assert.equal(parseTooltip(null), null);
});

test("问提示：在隔离环境里跑，坐标按页面缩放换算；页面卡住时不等下去", async () => {
  const calls: Array<{ world: number; code: string }> = [];
  const text = await readPageTooltip({
    getZoomFactor: () => 2,
    executeJavaScriptInIsolatedWorld: async (world, scripts) => { calls.push({ world, code: scripts[0].code }); return "提示"; },
  }, { x: 100, y: 60 });
  assert.equal(text, "提示");
  assert.equal(calls[0].world, CARET_WORLD_ID);
  assert.match(calls[0].code, /\(50, 30\)$/);
  const started = Date.now();
  assert.equal(await readPageTooltip({ getZoomFactor: () => 1, executeJavaScriptInIsolatedWorld: () => new Promise(() => undefined) }, { x: 1, y: 1 }, 30), null);
  assert.ok(Date.now() - started < 1000);
});
