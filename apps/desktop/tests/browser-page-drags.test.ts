import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WebContents } from "electron";
import { modifierBits, PageDrags, parseDragData, parseFileDrop } from "../src/main/browser-page-drags";

const NO_MODS = { shift: false, control: false, alt: false, meta: false };
const DATA = { items: [{ mimeType: "text/plain", data: "from-a" }], dragOperationsMask: -1 };

/** 假页面：记下送进去的拖拽事件，能假装「页面开始拖了」和「换页了」。 */
function fakePage(): { contents: WebContents; sent: Array<{ type: string; x: number; y: number }>; startDrag(): void; navigate(): void } {
  const debug = new EventEmitter() as EventEmitter & { isAttached(): boolean; sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> };
  const sent: Array<{ type: string; x: number; y: number }> = [];
  debug.isAttached = () => true;
  debug.sendCommand = async (method, params) => {
    if (method === "Input.dispatchDragEvent") sent.push({ type: String(params?.type), x: Number(params?.x), y: Number(params?.y) });
    return {};
  };
  const contents = Object.assign(new EventEmitter(), { debugger: debug, isDestroyed: () => false }) as unknown as WebContents;
  return {
    contents,
    sent,
    startDrag: () => debug.emit("message", {}, "Input.dragIntercepted", { data: DATA }),
    navigate: () => (contents as unknown as EventEmitter).emit("did-start-navigation", {}, "https://next.example/", false, true),
  };
}

const mouse = (type: string, x: number, y: number, buttons: number, button = "left") => ({ type, x, y, button, buttons, modifiers: NO_MODS });

test("修饰键换成 CDP 的位", () => {
  assert.equal(modifierBits(NO_MODS), 0);
  assert.equal(modifierBits({ shift: true, control: true, alt: true, meta: true }), 15);
  assert.equal(modifierBits({ ...NO_MODS, meta: true }), 4);
});

test("页面交来的拖拽内容逐项核对", () => {
  assert.deepEqual(parseDragData(DATA), DATA);
  assert.deepEqual(parseDragData({ items: [{ mimeType: "text/plain", data: "x" }, { mimeType: 1 }, null], files: ["/a", 2], dragOperationsMask: 1 }),
    { items: [{ mimeType: "text/plain", data: "x" }], files: ["/a"], dragOperationsMask: 1 });
  assert.equal(parseDragData({ items: "x", dragOperationsMask: 1 }), undefined);
  assert.equal(parseDragData(undefined), undefined);
});

test("拖进来的文件：只收磁盘上真有的绝对路径，位置贴进页面", () => {
  const folder = mkdtempSync(join(tmpdir(), "drop-test-"));
  const file = join(folder, "a.txt");
  writeFileSync(file, "a");
  const size = { width: 400, height: 300 };
  assert.deepEqual(parseFileDrop({ x: 10, y: 20, modifiers: { alt: true } }, [file, "relative.txt", join(folder, "missing.txt"), 42], size),
    { point: { x: 10, y: 20 }, modifiers: { ...NO_MODS, alt: true }, files: [file] });
  assert.deepEqual(parseFileDrop({ x: 900, y: -5 }, [folder], size)?.point, { x: 399, y: 0 });
  assert.equal(parseFileDrop({ x: 10, y: 20 }, ["relative.txt"], size), undefined);
  assert.equal(parseFileDrop({ x: "10", y: 20 }, [file], size), undefined);
  assert.equal(parseFileDrop({ x: 10, y: 20 }, file, size), undefined);
  assert.equal(parseFileDrop({ x: 10, y: 20 }, Array.from({ length: 150 }, () => file), size)?.files.length, 100);
});

test("用户拖：页面开始拖以后，移动换成「进入、经过」，松手换成「放下」，不再当鼠标送", async () => {
  const page = fakePage();
  const drags = new PageDrags();
  await drags.install(page.contents);
  assert.equal(await drags.userMouse(page.contents, mouse("down", 10, 10, 1)), false);
  assert.equal(await drags.userMouse(page.contents, mouse("move", 20, 10, 1)), false);
  page.startDrag();
  assert.equal(await drags.userMouse(page.contents, mouse("move", 50, 40, 1)), true);
  assert.equal(await drags.userMouse(page.contents, mouse("move", 60, 40, 1)), true);
  assert.equal(await drags.userMouse(page.contents, mouse("up", 70, 45, 0)), true);
  assert.deepEqual(page.sent.map((event) => event.type), ["dragEnter", "dragOver", "dragOver", "dragOver", "drop"]);
  assert.deepEqual(page.sent.at(-1), { type: "drop", x: 70, y: 45 });
  // 拖完了：之后的鼠标照常送。
  assert.equal(await drags.userMouse(page.contents, mouse("move", 80, 45, 0)), false);
});

test("用户手快：页面开始拖时已经松手，就在松手的地方放下", async () => {
  const page = fakePage();
  const drags = new PageDrags();
  await drags.install(page.contents);
  await drags.userMouse(page.contents, mouse("down", 10, 10, 1));
  await drags.userMouse(page.contents, mouse("move", 40, 10, 1));
  await drags.userMouse(page.contents, mouse("up", 44, 12, 0));
  page.startDrag();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(page.sent, [
    { type: "dragEnter", x: 44, y: 12 }, { type: "dragOver", x: 44, y: 12 }, { type: "drop", x: 44, y: 12 },
  ]);
});

test("用户按 Esc：取消这次拖拽，这一下不送进页面；没在拖时 Esc 照常送", async () => {
  const page = fakePage();
  const drags = new PageDrags();
  await drags.install(page.contents);
  assert.equal(await drags.userEscape(page.contents), false);
  await drags.userMouse(page.contents, mouse("down", 10, 10, 1));
  await drags.userMouse(page.contents, mouse("move", 30, 10, 1));
  page.startDrag();
  await drags.userMouse(page.contents, mouse("move", 40, 20, 1));
  assert.equal(await drags.userEscape(page.contents), true);
  assert.equal(page.sent.at(-1)?.type, "dragCancel");
  assert.equal(await drags.userMouse(page.contents, mouse("up", 50, 20, 0)), false);
});

test("Agent 拖：它的鼠标移动、松手换成拖拽；用户那边的鼠标不受影响", async () => {
  const page = fakePage();
  const drags = new PageDrags();
  await drags.install(page.contents);
  assert.equal(await drags.agentMouse(page.contents, { type: "mousePressed", x: 10, y: 10, button: "left", buttons: 1 }), false);
  assert.equal(await drags.agentMouse(page.contents, { type: "mouseMoved", x: 200, y: 50, button: "left", buttons: 1 }), false);
  page.startDrag();
  assert.equal(drags.relayToAgent(page.contents), false, "Agent 没说要自己接：不转给它");
  assert.equal(await drags.userMouse(page.contents, mouse("move", 5, 5, 0)), false);
  assert.equal(await drags.agentMouse(page.contents, { type: "mouseMoved", x: 200, y: 50, button: "left", buttons: 1 }), true);
  assert.equal(await drags.agentMouse(page.contents, { type: "mouseReleased", x: 200, y: 50, button: "left", buttons: 0 }), true);
  assert.deepEqual(page.sent.map((event) => event.type), ["dragEnter", "dragOver", "dragOver", "drop"]);
  assert.equal(await drags.agentMouse(page.contents, { type: "mouseMoved", x: 1, y: 1, button: "none", buttons: 0 }), false);
});

test("Agent 说它自己接拖拽：它拖的交给它（转事件、不换鼠标），用户拖的还是这边办", async () => {
  const page = fakePage();
  const drags = new PageDrags();
  await drags.install(page.contents);
  drags.setAgentIntercepts(page.contents, true);
  await drags.agentMouse(page.contents, { type: "mousePressed", x: 10, y: 10, button: "left", buttons: 1 });
  await drags.agentMouse(page.contents, { type: "mouseMoved", x: 90, y: 10, button: "left", buttons: 1 });
  page.startDrag();
  assert.equal(drags.relayToAgent(page.contents), true);
  assert.equal(await drags.agentMouse(page.contents, { type: "mouseReleased", x: 90, y: 10, button: "left", buttons: 0 }), false);
  assert.deepEqual(page.sent, []);
  await drags.userMouse(page.contents, mouse("down", 10, 10, 1));
  await drags.userMouse(page.contents, mouse("move", 40, 10, 1));
  page.startDrag();
  assert.equal(drags.relayToAgent(page.contents), false);
  assert.equal(await drags.userMouse(page.contents, mouse("up", 44, 12, 0)), true);
  assert.equal(page.sent.at(-1)?.type, "drop");
});

test("换页丢掉没拖完的；拖到一半丢了松手，下次按下先取消", async () => {
  const page = fakePage();
  const drags = new PageDrags();
  await drags.install(page.contents);
  await drags.userMouse(page.contents, mouse("down", 10, 10, 1));
  await drags.userMouse(page.contents, mouse("move", 30, 10, 1));
  page.startDrag();
  page.navigate();
  assert.equal(await drags.userMouse(page.contents, mouse("move", 40, 10, 1)), false);
  await drags.userMouse(page.contents, mouse("down", 10, 10, 1));
  await drags.userMouse(page.contents, mouse("move", 30, 10, 1));
  page.startDrag();
  // 松手那一下丢了，用户又按下：先取消上一次，这次按下照常送。
  assert.equal(await drags.userMouse(page.contents, mouse("down", 100, 100, 1)), false);
  assert.equal(page.sent.at(-1)?.type, "dragCancel");
});

test("拖文件进页面：进入、经过、放下，带着文件和允许的操作", async () => {
  const page = fakePage();
  const calls: Array<Record<string, unknown>> = [];
  const debug = page.contents.debugger as unknown as { sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> };
  const original = debug.sendCommand;
  debug.sendCommand = async (method, params) => {
    if (params) calls.push(params);
    return original(method, params);
  };
  await new PageDrags().dropFiles(page.contents, { x: 12, y: 34 }, ["/tmp/a.txt"], { ...NO_MODS, shift: true });
  assert.deepEqual(calls.map((call) => call.type), ["dragEnter", "dragOver", "drop"]);
  assert.deepEqual(calls[2], { type: "drop", x: 12, y: 34, data: { items: [], files: ["/tmp/a.txt"], dragOperationsMask: 19 }, modifiers: 8 });
});

test("Agent 拖着东西时按 Esc：取消这次拖拽，这一下不送进页面；别的时候的 Esc、别的键照常送", async () => {
  const page = fakePage();
  const drags = new PageDrags();
  await drags.install(page.contents);
  const escape = { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
  assert.equal(await drags.agentKey(page.contents, escape), false, "没在拖：照常送");
  await drags.agentMouse(page.contents, { type: "mousePressed", x: 10, y: 10, button: "left", buttons: 1 });
  await drags.agentMouse(page.contents, { type: "mouseMoved", x: 90, y: 10, button: "left", buttons: 1 });
  page.startDrag();
  assert.equal(await drags.agentKey(page.contents, { type: "keyDown", key: "a", code: "KeyA" }), false, "别的键照常送");
  assert.equal(await drags.agentKey(page.contents, { ...escape, type: "keyUp" }), false, "抬起不算");
  assert.equal(await drags.agentKey(page.contents, escape), true);
  assert.equal(page.sent.at(-1)?.type, "dragCancel");
  assert.equal(await drags.agentMouse(page.contents, { type: "mouseReleased", x: 90, y: 10, button: "left", buttons: 0 }), false, "取消以后松手照常送");
  // 用户在拖时 Agent 按 Esc：不动用户的拖拽。
  await drags.userMouse(page.contents, mouse("down", 10, 10, 1));
  await drags.userMouse(page.contents, mouse("move", 40, 10, 1));
  page.startDrag();
  assert.equal(await drags.agentKey(page.contents, escape), false);
  assert.equal(await drags.userMouse(page.contents, mouse("up", 44, 12, 0)), true, "用户的拖拽照常放下");
});
