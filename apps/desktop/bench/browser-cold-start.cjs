/**
 * 内置浏览器「第一次打开网页」到底慢在哪 —— 最小复现，不启动 CoilCoil 本体。
 *
 * 复刻 BrowserRuntimeManager.createCdpTab 的真实顺序：
 *   roster -> 渲染进程建 <webview> -> about:blank 的 dom-ready -> 回报 id ->
 *   debugger.attach -> Emulation.setDeviceMetricsOverride -> loadURL(目标页)
 * 页面用本机 http 服务，把网络因素排除掉，量的是浏览器栈自己的开销。
 *
 *   electron bench/browser-cold-start.cjs [--prewarm]
 */
const { app, BrowserWindow, ipcMain, session, webContents } = require("electron");
const http = require("node:http");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PARTITION = "persist:coilcoil-browser";
const VIEWPORT = { width: 1280, height: 720 };
const PREWARM = process.argv.includes("--prewarm");
const TABS = 4;
const argOf = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
/** 播种多少条 Cookie 然后退出——用来复现「从 Chrome 导入过登录状态」的档案。 */
const SEED = Number(argOf("seed") ?? 0);

const userData = argOf("user-data") ?? mkdtempSync(join(tmpdir(), "coilcoil-bench-"));
app.setPath("userData", userData);

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const ms = (value) => `${value.toFixed(1)}ms`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>bench</title>
<link rel="stylesheet" href="/a.css"><h1>bench</h1><p>hello</p>
<img src="/a.png"><script src="/a.js"></script>`;

function startServer() {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const server = http.createServer((request, response) => {
    if (request.url === "/a.css") return response.writeHead(200, { "content-type": "text/css" }).end("h1{color:#333}");
    if (request.url === "/a.js") return response.writeHead(200, { "content-type": "text/javascript" }).end("void 0;");
    if (request.url === "/a.png") return response.writeHead(200, { "content-type": "image/png" }).end(png);
    response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/`)));
}

const hostHtml = join(userData, "host.html");
writeFileSync(hostHtml, `<!doctype html><meta charset="utf-8"><body style="margin:0">
<script>
const { ipcRenderer } = require("electron");
ipcRenderer.on("make-guest", (_event, tabId) => {
  const started = performance.now();
  const guest = document.createElement("webview");
  guest.setAttribute("partition", ${JSON.stringify(PARTITION)});
  guest.setAttribute("src", "about:blank");
  guest.setAttribute("allowpopups", "");
  guest.style.cssText = "position:absolute;left:0;top:0;width:1280px;height:720px";
  guest.addEventListener("dom-ready", function once() {
    guest.removeEventListener("dom-ready", once);
    let id;
    try { id = guest.getWebContentsId(); } catch (error) { ipcRenderer.send("guest-failed", String(error)); return; }
    ipcRenderer.send("guest-ready", { tabId, id, elementToDomReady: performance.now() - started });
  });
  document.body.appendChild(guest);
});
</script></body>`);

function waitForGuest(tabId) {
  return new Promise((resolve, reject) => {
    ipcMain.once("guest-ready", (_event, payload) => (payload.tabId === tabId ? resolve(payload) : reject(new Error("tab 对不上"))));
    ipcMain.once("guest-failed", (_event, reason) => reject(new Error(reason)));
  });
}

/** 走一遍真实的建标签页流程，返回每一段耗时。 */
async function openTab(window, tabId, url) {
  const t0 = now();
  window.webContents.send("make-guest", tabId);
  const report = await waitForGuest(tabId);
  const tGuest = now();
  const guest = webContents.fromId(report.id);
  guest.debugger.attach("1.3");
  const tAttach = now();
  await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
  });
  const tEmulation = now();
  const marks = {};
  for (const event of ["did-start-loading", "dom-ready", "did-frame-finish-load", "did-stop-loading"]) {
    guest.once(event, () => { if (marks[event] === undefined) marks[event] = now(); });
  }
  await guest.loadURL(url);
  const tLoad = now();
  return {
    tabId,
    guest,
    "建元素→about:blank dom-ready": report.elementToDomReady,
    "主进程等 guest 上报": tGuest - t0,
    "debugger.attach": tAttach - tGuest,
    "Emulation.setDeviceMetricsOverride": tEmulation - tAttach,
    "loadURL→did-finish-load": tLoad - tEmulation,
    "其中 dom-ready 提前": marks["dom-ready"] === undefined ? NaN : tLoad - marks["dom-ready"],
    "合计（点下去→页面加载完）": tLoad - t0,
  };
}

async function seedCookies(count) {
  const store = session.fromPartition(PARTITION);
  for (let index = 0; index < count; index += 1) {
    await store.cookies.set({
      url: `https://host-${index % 400}.example.com/`,
      name: `c${index}`,
      value: "x".repeat(64),
      expirationDate: Math.floor(Date.now() / 1000) + 86_400 * 30,
    });
  }
  await store.cookies.flushStore();
  console.log(`已写入 ${count} 条 Cookie 到 ${userData}`);
}

async function main() {
  const url = await startServer();
  await app.whenReady();
  app.dock?.hide();

  if (SEED > 0) {
    await seedCookies(SEED);
    app.exit(0);
    return;
  }

  const tVault0 = now();
  const { safeStorage } = require("electron");
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  const sealed = encryptionAvailable ? safeStorage.encryptString(JSON.stringify([{ origin: "https://a.example", username: "u", password: "p", importedAt: 0 }])) : undefined;
  const tVault1 = now();
  if (sealed) safeStorage.decryptString(sealed);
  const tVault2 = now();

  const t0 = now();
  const store = session.fromPartition(PARTITION);
  const tPartition = now();
  await store.cookies.get({});
  const tCookies = now();

  const window = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false },
  });
  await window.loadFile(hostHtml);
  const tWindow = now();

  const rows = [];
  if (PREWARM) {
    // 预热：app 空闲时先建好一个 guest（这一次的开销不算进用户那一次）。
    const warm = await openTab(window, "prewarm", "about:blank");
    rows.push({ ...warm, tabId: "prewarm（不计入）" });
  }
  for (let index = 0; index < TABS; index += 1) rows.push(await openTab(window, `tab-${index + 1}`, url));

  console.log(`\n== 内置浏览器冷启动 ${PREWARM ? "（已预热）" : "（未预热）"} ==`);
  console.log(`session.fromPartition(${PARTITION})  ${ms(tPartition - t0)}`);
  console.log(`第一次读 cookie 库                    ${ms(tCookies - tPartition)}`);
  console.log(`宿主窗口 loadFile                     ${ms(tWindow - tCookies)}`);
  console.log(`safeStorage 首次加密（keychain）        ${ms(tVault1 - tVault0)}`);
  console.log(`safeStorage 解密一条（每次 dom-ready）  ${ms(tVault2 - tVault1)}`);
  for (const row of rows) {
    console.log(`\n-- ${row.tabId} --`);
    for (const [label, value] of Object.entries(row)) {
      if (label === "tabId" || label === "guest") continue;
      console.log(`  ${label.padEnd(34)} ${ms(value)}`);
    }
  }
  console.log("");
  app.exit(0);
}

main().catch((error) => { console.error(error); app.exit(1); });
