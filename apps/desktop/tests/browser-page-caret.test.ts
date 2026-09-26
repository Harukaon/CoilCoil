import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CARET_SCRIPT, CARET_WORLD_ID, parseCaret, readPageCaret } from "../src/main/browser-page-caret";

/** 在一个假页面里跑光标脚本：字宽按每个字 10 像素量，版面数字都是写死的。 */
function runCaret(active: Record<string, unknown> | null, style: Record<string, string> = {}): unknown {
  const computed = {
    paddingLeft: "8px", paddingRight: "8px", paddingTop: "6px", paddingBottom: "6px",
    fontSize: "18px", lineHeight: "24px", font: "18px Arial", letterSpacing: "normal",
    direction: "ltr", textAlign: "start", whiteSpace: "pre-wrap", ...style,
  };
  const view = { getComputedStyle: () => computed };
  const doc: Record<string, unknown> = { activeElement: active, defaultView: view, designMode: "off" };
  if (active) active.ownerDocument = doc;
  class OffscreenCanvas {
    getContext() { return { font: "", measureText: (text: string) => ({ width: [...text].length * 10 }) }; }
  }
  // 沙箱里造的对象原型不同，转一道再比。
  const result: unknown = vm.runInNewContext(CARET_SCRIPT, { document: doc, window: view, OffscreenCanvas });
  return result === null ? null : JSON.parse(JSON.stringify(result));
}

function field(tagName: string, value: string, caret: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tagName, type: tagName === "INPUT" ? "text" : "textarea", value,
    selectionStart: caret, selectionEnd: caret, selectionDirection: "forward",
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
    clientLeft: 1, clientTop: 1, clientWidth: 316, clientHeight: 36, scrollLeft: 0, scrollTop: 0,
    getAttribute: () => null,
    ...extra,
  };
}

test("光标脚本：单行输入框按光标前的字宽算横坐标，竖直居中", () => {
  // 内容区左边 = 100 + 边框 1 + 内边距 8 = 109；光标前 5 个字 = 50。
  assert.deepEqual(runCaret(field("INPUT", "hello world", 5)), { x: 159, y: 57, height: 24 });
  // 反向选中时光标在选区开头。
  assert.deepEqual(runCaret(field("INPUT", "hello world", 0, { selectionStart: 2, selectionEnd: 7, selectionDirection: "backward" })), { x: 129, y: 57, height: 24 });
  // 滚过的部分要减掉：60 个字 600 宽，框里滚到底（300）时光标在右边沿。
  assert.deepEqual(runCaret(field("INPUT", "x".repeat(60), 60, { scrollLeft: 300 })), { x: 409, y: 57, height: 24 });
  // 算出来跑到框外的，贴在框边上。
  assert.deepEqual(runCaret(field("INPUT", "x".repeat(60), 60)), { x: 409, y: 57, height: 24 });
  // 密码框按圆点量，长度一样。
  assert.deepEqual(runCaret(field("INPUT", "secret", 6, { type: "password" })), { x: 169, y: 57, height: 24 });
  // 居中对齐：字比框窄时整段往中间挪。内容宽 300，整段 30。
  assert.deepEqual(runCaret(field("INPUT", "abc", 3), { textAlign: "center" }), { x: 109 + 135 + 30, y: 57, height: 24 });
});

test("光标脚本：多行文本框按宽度折行，算出光标在第几行", () => {
  // 内容宽 300 = 30 个字。"aaaa…" 20 个 + 空格 + 15 个：第二个词放不下，折到第二行。
  const text = `${"a".repeat(20)} ${"b".repeat(15)}`;
  assert.deepEqual(runCaret(field("TEXTAREA", text, text.length, { clientHeight: 200 })), { x: 109 + 150, y: 57 + 24, height: 24 });
  // 换行符另起一行；一个词比一行还长时按字折。
  const long = `x\n${"c".repeat(35)}`;
  assert.deepEqual(runCaret(field("TEXTAREA", long, long.length, { clientHeight: 200 })), { x: 109 + 50, y: 57 + 48, height: 24 });
  // 不折行的文本框（wrap=off）：只数换行符。
  assert.deepEqual(runCaret(field("TEXTAREA", text, text.length, { clientHeight: 200, getAttribute: (name: string) => (name === "wrap" ? "off" : null) })), { x: 109 + 300, y: 57, height: 24 });
  // 滚过的行要减掉，光标滚出去时贴在可见范围里。
  assert.deepEqual(runCaret(field("TEXTAREA", "1\n2\n3\n4", 7, { clientHeight: 200, scrollTop: 48 })), { x: 119, y: 57 + 24, height: 24 });
});

test("光标脚本：没在能打字的地方时交回 null", () => {
  assert.equal(runCaret(null), null);
  assert.equal(runCaret({ tagName: "BUTTON", isContentEditable: false }), null);
  // 日期框这类不是文字输入框，也不算。
  assert.equal(runCaret(field("INPUT", "", 0, { type: "date" })), null);
  // 跨源内嵌页：进不去，交回 null。
  assert.equal(runCaret({ tagName: "IFRAME", get contentDocument() { throw new Error("cross-origin"); } }), null);
});

test("页面回来的光标位置逐项核对", () => {
  assert.deepEqual(parseCaret({ x: 10, y: 20, height: 18 }), { x: 10, y: 20, height: 18 });
  assert.deepEqual(parseCaret({ x: 10, y: 20, height: 5000 }), { x: 10, y: 20, height: 400 });
  assert.equal(parseCaret({ x: "10", y: 20, height: 18 }), null);
  assert.equal(parseCaret({ x: 10, y: Number.NaN, height: 18 }), null);
  assert.equal(parseCaret({ x: 10, y: 20, height: 0 }), null);
  assert.equal(parseCaret({ x: 1e9, y: 20, height: 18 }), null);
  assert.equal(parseCaret(null), null);
});

test("问光标：在隔离环境里跑，出错或页面卡住时交回 null 不等下去", async () => {
  const worlds: number[] = [];
  const ok = await readPageCaret({
    executeJavaScriptInIsolatedWorld: async (world) => { worlds.push(world); return { x: 1, y: 2, height: 3 }; },
  });
  assert.deepEqual(ok, { x: 1, y: 2, height: 3 });
  assert.deepEqual(worlds, [CARET_WORLD_ID]);
  assert.notEqual(CARET_WORLD_ID, 0);
  assert.equal(await readPageCaret({ executeJavaScriptInIsolatedWorld: async () => { throw new Error("gone"); } }), null);
  const started = Date.now();
  assert.equal(await readPageCaret({ executeJavaScriptInIsolatedWorld: () => new Promise(() => undefined) }, 30), null);
  assert.ok(Date.now() - started < 1000);
});
