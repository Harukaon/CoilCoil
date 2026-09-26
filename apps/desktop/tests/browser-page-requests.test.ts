import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import type { WebContents } from "electron";
import { isPrintRequest, PageRequests, PRINT_REQUEST_URL, PRINT_SCRIPT } from "../src/main/browser-page-requests.ts";

/** files 为 null 表示用户在面板里点了取消。 */
function fixture({ userActed = false, files = ["/tmp/a.txt"] as string[] | null } = {}) {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const debug = Object.assign(new EventEmitter(), {
    sendCommand: async (method: string, params?: Record<string, unknown>) => { commands.push({ method, params }); return {}; },
  });
  const contents = { debugger: debug, isDestroyed: () => false } as unknown as WebContents;
  const chosen: boolean[] = [];
  const printed: WebContents[] = [];
  const requests = new PageRequests({
    userJustActed: () => userActed,
    chooseFiles: async (multiple) => { chosen.push(multiple); return files ?? undefined; },
    printAsPdf: async (page) => { printed.push(page); },
  });
  const emit = (method: string, params: Record<string, unknown>) => debug.emit("message", {}, method, params);
  return { commands, contents, requests, chosen, printed, emit };
}

test("装上时：开选文件拦截、装打印替身，都在页面加载真正网址之前；不碰和 Agent 共用的 Runtime 域", async () => {
  const f = fixture();
  await f.requests.install("tab", f.contents);
  assert.deepEqual(f.commands.map((command) => command.method), [
    "Page.enable", "Page.setInterceptFileChooserDialog", "Page.addScriptToEvaluateOnNewDocument",
  ]);
  assert.deepEqual(f.commands[1].params, { enabled: true });
});

test("Agent 点到上传按钮：不弹选文件面板，也不往文件框里放东西", async () => {
  const f = fixture({ userActed: false });
  await f.requests.install("tab", f.contents);
  f.emit("Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 7 });
  await nextTurn();
  assert.deepEqual(f.chosen, []);
  assert.equal(f.commands.some((command) => command.method === "DOM.setFileInputFiles"), false);
});

test("用户刚点的上传按钮：弹面板让他挑，挑好的文件放进那个文件框；多选的就多选", async () => {
  const f = fixture({ userActed: true, files: ["/tmp/a.txt", "/tmp/b.txt"] });
  await f.requests.install("tab", f.contents);
  f.emit("Page.fileChooserOpened", { mode: "selectMultiple", backendNodeId: 7 });
  await nextTurn();
  assert.deepEqual(f.chosen, [true]);
  assert.deepEqual(f.commands.at(-1), { method: "DOM.setFileInputFiles", params: { files: ["/tmp/a.txt", "/tmp/b.txt"], backendNodeId: 7 } });
});

test("用户挑文件时取消了：什么都不放", async () => {
  const f = fixture({ userActed: true, files: null });
  await f.requests.install("tab", f.contents);
  f.emit("Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 7 });
  await nextTurn();
  assert.equal(f.commands.some((command) => command.method === "DOM.setFileInputFiles"), false);
});

test("打印：用户点的存成 PDF 交给系统打开；Agent 点的什么都不做", async () => {
  const agent = fixture({ userActed: false });
  await agent.requests.requestPrint("tab", agent.contents);
  assert.equal(agent.printed.length, 0);
  const user = fixture({ userActed: true });
  await user.requests.requestPrint("tab", user.contents);
  assert.equal(user.printed.length, 1);
});

test("打印替身：页面的 print 换成借 window.open 报信的替身，页面后来改掉 window.open 也不影响", () => {
  const opened: string[] = [];
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  sandbox.open = function (this: unknown, url: string) { opened.push(url); return null; };
  runInNewContext(PRINT_SCRIPT, sandbox);
  sandbox.open = () => { throw new Error("页面自己换掉的 open"); };
  const print = sandbox.print as () => void;
  assert.equal(typeof print, "function");
  assert.equal(print.name, "print");
  assert.match(Function.prototype.toString.call(print), /\[native code\]/);
  print();
  assert.deepEqual(opened, [PRINT_REQUEST_URL]);
  assert.equal(isPrintRequest(opened[0]), true);
  assert.equal(isPrintRequest("about:blank"), false);
});
