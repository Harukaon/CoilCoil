/**
 * 内置浏览器元素选择器的真实 Electron/CDP 冒烟测试。
 *
 * 验证 Overlay.setInspectMode 能在 <webview> guest 中拦截一次点击，
 * 并通过 Overlay.inspectNodeRequested 返回可读取的 DOM 节点。
 *
 *   electron bench/browser-element-picker.cjs
 */
const { app, BrowserWindow, ipcMain, webContents } = require("electron");
const http = require("node:http");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const userData = mkdtempSync(join(tmpdir(), "coilcoil-element-picker-"));
app.setPath("userData", userData);

const PAGE = `<!doctype html><meta charset="utf-8"><title>Element picker smoke</title>
<style>body{margin:0}button{position:absolute;left:40px;top:40px;width:180px;height:72px}</style>
<button id="save" data-testid="save-button">Save changes</button>`;

function startServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

function waitForGuest() {
  return new Promise((resolve, reject) => {
    ipcMain.once("guest-ready", (_event, id) => resolve(webContents.fromId(id)));
    ipcMain.once("guest-failed", (_event, reason) => reject(new Error(reason)));
  });
}

function waitForSelectedNode(debuggerApi) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      debuggerApi.off("message", onMessage);
      reject(new Error("Timed out waiting for Overlay.inspectNodeRequested"));
    }, 5_000);
    function onMessage(_event, method, params) {
      if (method !== "Overlay.inspectNodeRequested") return;
      clearTimeout(timeout);
      debuggerApi.off("message", onMessage);
      resolve(params.backendNodeId);
    }
    debuggerApi.on("message", onMessage);
  });
}

async function main() {
  const { server, url } = await startServer();
  await app.whenReady();
  app.dock?.hide();

  const hostHtml = join(userData, "host.html");
  writeFileSync(hostHtml, `<!doctype html><meta charset="utf-8"><body style="margin:0">
<script>
const { ipcRenderer } = require("electron");
const guest = document.createElement("webview");
guest.src = ${JSON.stringify(url)};
guest.style.cssText = "position:absolute;inset:0;width:800px;height:600px";
guest.addEventListener("dom-ready", () => {
  try { ipcRenderer.send("guest-ready", guest.getWebContentsId()); }
  catch (error) { ipcRenderer.send("guest-failed", String(error)); }
}, { once: true });
document.body.appendChild(guest);
</script></body>`);

  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false },
  });
  const guestPromise = waitForGuest();
  await window.loadFile(hostHtml);
  const guest = await guestPromise;
  guest.debugger.attach("1.3");
  await guest.debugger.sendCommand("DOM.enable");
  await guest.debugger.sendCommand("Overlay.enable");

  const selectedNodePromise = waitForSelectedNode(guest.debugger);
  await guest.debugger.sendCommand("Overlay.setInspectMode", {
    mode: "searchForNode",
    highlightConfig: {
      showInfo: true,
      showStyles: true,
      contentColor: { r: 34, g: 197, b: 94, a: 0.2 },
      borderColor: { r: 34, g: 197, b: 94, a: 1 },
    },
  });
  await guest.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 70 });
  await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
    type: "mousePressed", x: 100, y: 70, button: "left", buttons: 1, clickCount: 1,
  });
  await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: 100, y: 70, button: "left", buttons: 0, clickCount: 1,
  });

  const backendNodeId = await selectedNodePromise;
  const { outerHTML } = await guest.debugger.sendCommand("DOM.getOuterHTML", { backendNodeId });
  if (!outerHTML.includes('id="save"') || !outerHTML.includes("Save changes")) {
    throw new Error(`Selected the wrong node: ${outerHTML}`);
  }
  console.log(`Element picker smoke passed: backendNodeId=${backendNodeId} ${outerHTML}`);

  server.close();
  window.destroy();
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
