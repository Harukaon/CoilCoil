import assert from "node:assert/strict";
import test from "node:test";
import {
  cdpModifiers,
  clampToPage,
  cssCursor,
  electronModifiers,
  keyEventParams,
  keyText,
  macEditingCommands,
  mouseInputEvent,
  parsePageInput,
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

test("网页要的光标换成 CSS 写法，认不出来的当默认箭头", () => {
  assert.equal(cssCursor("hand"), "pointer");
  assert.equal(cssCursor("text"), "text");
  assert.equal(cssCursor("nodrop"), "no-drop");
  assert.equal(cssCursor("something-new"), "default");
});
