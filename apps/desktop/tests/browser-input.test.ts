import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { WebContents } from "electron";
import {
  cdpModifiers,
  clampToPage,
  cssCursor,
  electronModifiers,
  keyEventParams,
  keyText,
  macEditingCommands,
  mouseInputEvent,
  parseFindRequest,
  parsePageInput,
  PageInputForwarder,
  wheelInputEvent,
} from "../src/main/browser-input.ts";

const none = { shift: false, control: false, alt: false, meta: false };
const key = (over: Record<string, unknown> = {}) => ({
  kind: "key" as const,
  type: "down" as const,
  key: "a",
  code: "KeyA",
  keyCode: 65,
  location: 0,
  repeat: false,
  modifiers: none,
  ...over,
});

test("普通字母、Shift 大写、Mac 上 ⌥ 打出的特殊字符都要打字", () => {
  assert.equal(keyText(key()), "a");
  assert.equal(keyText(key({ key: "A", modifiers: { ...none, shift: true } })), "A");
  assert.equal(keyText(key({ key: "å", modifiers: { ...none, alt: true } })), "å");
  assert.equal(keyText(key({ key: "😀" })), "😀");
});

test("⌘、Ctrl 组合和功能键不打字；Ctrl+Alt（Windows 的 AltGr）照打；回车打 \\r", () => {
  assert.equal(keyText(key({ modifiers: { ...none, meta: true } })), undefined);
  assert.equal(keyText(key({ modifiers: { ...none, control: true } })), undefined);
  assert.equal(keyText(key({ key: "@", modifiers: { ...none, control: true, alt: true } })), "@");
  assert.equal(keyText(key({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 })), undefined);
  assert.equal(keyText(key({ key: "Tab", code: "Tab", keyCode: 9 })), undefined);
  assert.equal(keyText(key({ key: "Enter", code: "Enter", keyCode: 13 })), "\r");
});

test("打字的键发 keyDown 带字；不打字的发 rawKeyDown；抬起发 keyUp", () => {
  const typed = keyEventParams(key(), "darwin");
  assert.equal(typed.type, "keyDown");
  assert.equal(typed.text, "a");
  assert.equal(typed.windowsVirtualKeyCode, 65);
  const arrow = keyEventParams(key({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }), "win32");
  assert.equal(arrow.type, "rawKeyDown");
  assert.equal(arrow.text, undefined);
  const up = keyEventParams(key({ type: "up" }), "darwin");
  assert.equal(up.type, "keyUp");
  assert.equal(up.text, undefined);
});

test("Mac 上的编辑快捷键带上编辑命令：⌘A 全选、⌥← 按词移动、⌘⌫ 删到行首", () => {
  const meta = { ...none, meta: true };
  const alt = { ...none, alt: true };
  assert.deepEqual(macEditingCommands("KeyA", meta), ["selectAll"]);
  assert.deepEqual(macEditingCommands("ArrowLeft", alt), ["moveWordLeft"]);
  assert.deepEqual(macEditingCommands("Backspace", meta), ["deleteToBeginningOfLine"]);
  assert.deepEqual(macEditingCommands("ArrowUp", alt), ["moveBackward", "moveToBeginningOfParagraph"]);
  // 回车本身打出换行，插入类命令不带，免得换两次行。
  assert.deepEqual(macEditingCommands("Enter", none), []);
  assert.deepEqual(keyEventParams(key({ modifiers: meta }), "darwin").commands, ["selectAll"]);
});

test("Windows、Linux 上不带编辑命令：Ctrl+C 这些由网页内核自己处理", () => {
  const params = keyEventParams(key({ key: "c", code: "KeyC", keyCode: 67, modifiers: { ...none, control: true } }), "win32");
  assert.equal(params.commands, undefined);
  assert.equal(params.type, "rawKeyDown");
  assert.equal(params.modifiers, 2);
});

test("修饰键位和 CDP 一致；拖动时带上按着的键", () => {
  assert.equal(cdpModifiers({ shift: true, control: true, alt: true, meta: true }), 15);
  assert.equal(cdpModifiers({ ...none, meta: true }), 4);
  assert.deepEqual(electronModifiers({ ...none, shift: true }, 1), ["shift", "leftbuttondown"]);
  assert.deepEqual(electronModifiers(none, 2 | 4), ["rightbuttondown", "middlebuttondown"]);
});

test("鼠标按下带点击次数和按键；移动时不带按键名", () => {
  const down = mouseInputEvent({ kind: "mouse", type: "down", x: 10.6, y: 20.2, button: "left", clickCount: 2, buttons: 1, modifiers: none });
  assert.deepEqual(down, { type: "mouseDown", x: 11, y: 20, button: "left", clickCount: 2, modifiers: ["leftbuttondown"] });
  const move = mouseInputEvent({ kind: "mouse", type: "move", x: 1, y: 1, button: "none", clickCount: 0, buttons: 0, modifiers: none });
  assert.equal(move.type, "mouseMove");
  assert.equal("button" in move, false);
});

test("滚轮方向和网页里的相反：DOM 往下滚是正，送进去是负", () => {
  const wheel = wheelInputEvent({ kind: "wheel", x: 5, y: 5, deltaX: 3, deltaY: 120, modifiers: none });
  assert.equal(wheel.deltaY, -120);
  assert.equal(wheel.deltaX, -3);
  assert.equal(wheel.hasPreciseScrollingDeltas, true);
});

test("坐标只落在页面里", () => {
  assert.deepEqual(clampToPage({ x: -5, y: 900 }, { width: 800, height: 600 }), { x: 0, y: 599 });
});

test("界面送来的操作要逐项核对：结构不对、数字不对的一律丢掉", () => {
  assert.equal(parsePageInput(undefined), undefined);
  assert.equal(parsePageInput({ kind: "mouse", type: "down", x: Number.NaN, y: 0, button: "left", clickCount: 1, buttons: 1, modifiers: none }), undefined);
  assert.equal(parsePageInput({ kind: "mouse", type: "drag", x: 0, y: 0, button: "left", clickCount: 1, buttons: 1, modifiers: none }), undefined);
  assert.equal(parsePageInput({ kind: "key", type: "down", key: "a", code: "KeyA", keyCode: 65, location: 0, repeat: false, modifiers: {} }), undefined);
  assert.equal(parsePageInput({ kind: "edit", command: "delete" }), undefined);
  assert.equal(parsePageInput({ kind: "eval", code: "alert(1)" }), undefined);
  // 点击次数、按键位收在合理范围里；滚轮一次最多滚这么远。
  const mouse = parsePageInput({ kind: "mouse", type: "down", x: 1, y: 2, button: "left", clickCount: 99, buttons: 255, modifiers: none });
  assert.deepEqual(mouse, { kind: "mouse", type: "down", x: 1, y: 2, button: "left", clickCount: 3, buttons: 7, modifiers: none });
  const wheel = parsePageInput({ kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 1e9, modifiers: none });
  assert.equal(wheel && wheel.kind === "wheel" ? wheel.deltaY : 0, 5000);
  assert.deepEqual(parsePageInput({ kind: "ime", type: "update", text: "ni", selectionStart: 2, selectionEnd: 2 }), { kind: "ime", type: "update", text: "ni", selectionStart: 2, selectionEnd: 2 });
  assert.deepEqual(parsePageInput({ kind: "ime", type: "cancel", text: 5 }), { kind: "ime", type: "cancel" });
  assert.deepEqual(parsePageInput({ kind: "focus", focused: true }), { kind: "focus", focused: true });
});

function inputFixture(intercept?: () => Promise<boolean>) {
  const sent: string[] = [];
  const contents = {
    isDestroyed: () => false,
    sendInputEvent: (event: { type: string }) => { sent.push(event.type); },
    paste: () => { sent.push("paste"); },
    debugger: { isAttached: () => true, sendCommand: async (method: string) => { sent.push(method); } },
  } as unknown as WebContents;
  return { sent, contents, forwarder: new PageInputForwarder(contents, "darwin", intercept) };
}
const size = { width: 800, height: 600 };
const down = { kind: "mouse", type: "down", x: 10, y: 10, button: "left", clickCount: 1, buttons: 1, modifiers: none } as const;

test("下拉命中检查未完成时，紧跟的打字、粘贴不会越过鼠标按下", async () => {
  let resolve!: (value: boolean) => void;
  const { sent, forwarder } = inputFixture(() => new Promise<boolean>((done) => { resolve = done; }));
  forwarder.forward(down, size);
  forwarder.forward(key(), size);
  forwarder.forward({ kind: "edit", command: "paste" }, size);
  await nextTurn();
  assert.deepEqual(sent, []);
  resolve(false);
  await nextTurn();
  assert.deepEqual(sent, ["mouseDown", "Input.dispatchKeyEvent", "paste"]);
});

test("下拉框截住左键按下，只吞配对的左键抬起，不误吞右键", async () => {
  const { sent, forwarder } = inputFixture(async () => true);
  forwarder.forward(down, size);
  forwarder.forward({ ...down, type: "up", button: "right", buttons: 1 }, size);
  forwarder.forward({ ...down, type: "up", buttons: 0 }, size);
  await nextTurn();
  assert.deepEqual(sent, ["mouseUp"]);
});

test("被下拉框接走的按压，抬起丢了也不会冻结悬停：左键松开后的移动照常送", async () => {
  const { sent, forwarder } = inputFixture(async () => true);
  forwarder.forward(down, size);
  forwarder.forward({ ...down, type: "move", button: "none", clickCount: 0, buttons: 1 }, size);
  forwarder.forward({ ...down, type: "move", button: "none", clickCount: 0, buttons: 0 }, size);
  forwarder.forward({ ...down, type: "move", button: "none", clickCount: 0, buttons: 0 }, size);
  await nextTurn();
  assert.deepEqual(sent, ["mouseMove", "mouseMove"]);
});

test("双击、三击的第二下以后不再问下拉框，选词选段不多等", async () => {
  let asked = 0;
  const { sent, forwarder } = inputFixture(async () => { asked++; return false; });
  forwarder.forward(down, size);
  forwarder.forward({ ...down, clickCount: 2 }, size);
  forwarder.forward({ ...down, clickCount: 3 }, size);
  await nextTurn();
  assert.equal(asked, 1);
  assert.deepEqual(sent, ["mouseDown", "mouseDown", "mouseDown"]);
});

test("一次鼠标发送失败不会毒死后续键盘与鼠标队列", async (t) => {
  const { sent, contents, forwarder } = inputFixture();
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(contents, "sendInputEvent", () => { throw new Error("navigation"); }, { times: 1 });
  forwarder.forward(down, size);
  forwarder.forward(key(), size);
  forwarder.forward({ ...down, type: "up", buttons: 0 }, size);
  await nextTurn();
  assert.deepEqual(sent, ["Input.dispatchKeyEvent", "mouseUp"]);
});

test("导航中止正在等待的命中检查和排队的旧输入", async () => {
  let resolve!: (value: boolean) => void;
  const { sent, forwarder } = inputFixture(() => new Promise<boolean>((done) => { resolve = done; }));
  forwarder.forward(down, size);
  forwarder.forward(key(), size);
  await nextTurn();
  forwarder.reset();
  resolve(false);
  await nextTurn();
  assert.deepEqual(sent, []);
  forwarder.forward(key(), size);
  await nextTurn();
  assert.deepEqual(sent, ["Input.dispatchKeyEvent"]);
});

test("网页要的光标换成 CSS 写法，Electron 的 pointer 是箭头而 hand 才是小手", () => {
  assert.equal(cssCursor("pointer"), "default");
  assert.equal(cssCursor("hand"), "pointer");
  assert.equal(cssCursor("text"), "text");
  assert.equal(cssCursor("nodrop"), "no-drop");
  assert.equal(cssCursor("something-new"), "default");
});

test("查找栏送来的请求逐项核对", () => {
  assert.deepEqual(parseFindRequest({ text: "apple", forward: true, newSearch: true }), { text: "apple", forward: true, newSearch: true });
  assert.deepEqual(parseFindRequest({ stop: true, text: "ignored" }), { stop: true });
  assert.equal(parseFindRequest({ text: 42, forward: true, newSearch: true }), undefined);
  assert.equal(parseFindRequest({ text: "a", forward: "yes", newSearch: true }), undefined);
  assert.equal(parseFindRequest({ text: "x".repeat(1001), forward: true, newSearch: true }), undefined);
  assert.equal(parseFindRequest(undefined), undefined);
});
