/**
 * 「同一个网页，CoilCoil 的 <webview> 路子 vs 直接用 WebContentsView」谁更快。
 *
 * CoilCoil 把网页画在 app 渲染进程里的 <webview> 客体上；很多别的内置浏览器
 * （包括用户拿来比的 codex）用的是 WebContentsView，由浏览器进程直接合成。
 * 这个脚本在同一个 Electron 进程、同一个全新档案里只跑其中一种，测从「开始建」
 * 到 did-finish-load 的时间，两种各跑两轮对比。
 *
 *   electron bench/browser-render-path.cjs --mode=webview --url=https://...
 *   electron bench/browser-render-path.cjs --mode=view    --url=https://...
 */
const { app, BrowserWindow, WebContentsView, ipcMain, webContents } = require("electron");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PARTITION = "persist:coilcoil-browser";
const argOf = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const MODE = argOf("mode", "webview");
const URLS = argOf("url", "https://example.com/").split(",");
const ROUNDS = Number(argOf("rounds", 0)) || 2;
const BOX = { x: 0, y: 0, width: 520, height: 760 };

const userData = mkdtempSync(join(tmpdir(), "coilcoil-render-"));
app.setPath("userData", userData);

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const ms = (value) => `${value.toFixed(0)}ms`;

const hostHtml = join(userData, "host.html");
writeFileSync(hostHtml, `<!doctype html><meta charset="utf-8"><body style="margin:0">
<script>
const { ipcRenderer } = require("electron");
ipcRenderer.on("make-guest", (_event, tabId) => {
  const guest = document.createElement("webview");
  guest.setAttribute("partition", ${JSON.stringify(PARTITION)});
  guest.setAttribute("src", "about:blank");
  guest.style.cssText = "position:absolute;left:0;top:0;width:${BOX.width}px;height:${BOX.height}px";
  guest.addEventListener("dom-ready", function once() {
    guest.removeEventListener("dom-ready", once);
    ipcRenderer.send("guest-ready", { tabId, id: guest.getWebContentsId() });
  });
  document.body.appendChild(guest);
});
</script></body>`);

/** 以 did-finish-load 为准，而不是 loadURL 的 promise：客体上那个 promise 会被
 *  about:blank 那一轮的 did-stop-loading 提前兑现，量出来是 1ms。 */
function timeLoad(contents, url) {
  const marks = {};
  const t0 = now();
  for (const event of ["did-start-loading", "dom-ready"]) {
    contents.once(event, () => { marks[event] ??= now() - t0; });
  }
  return new Promise((resolve) => {
    const finish = () => resolve({ ...marks, total: now() - t0 });
    contents.once("did-finish-load", finish);
    contents.once("did-fail-load", finish);
    void contents.loadURL(url).catch(() => {});
  });
}

async function runWebview(window, round) {
  const t0 = now();
  const ready = new Promise((resolve) => ipcMain.once("guest-ready", (_event, payload) => resolve(payload)));
  window.webContents.send("make-guest", `tab-${round}`);
  const { id } = await ready;
  const guest = webContents.fromId(id);
  const setup = now() - t0;
  guest.debugger.attach("1.3");
  const load = await timeLoad(guest, URLS[round - 1] ?? URLS[0]);
  return { setup, ...load };
}

async function runView(window, round) {
  const t0 = now();
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true } });
  window.contentView.addChildView(view);
  view.setBounds({ ...BOX, y: BOX.y + round });
  const setup = now() - t0;
  const load = await timeLoad(view.webContents, URLS[round - 1] ?? URLS[0]);
  return { setup, ...load };
}

async function main() {
  await app.whenReady();
  app.dock?.hide();
  const window = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false },
  });
  await window.loadFile(hostHtml);

  console.log(`\n== ${MODE}（全新档案） ==`);
  for (let round = 1; round <= ROUNDS; round += 1) {
    const result = MODE === "view" ? await runView(window, round) : await runWebview(window, round);
    console.log(`第 ${round} 次 ${(URLS[round - 1] ?? URLS[0]).padEnd(30)} 建视图 ${ms(result.setup)} | 开始加载 ${ms(result["did-start-loading"] ?? NaN)}`
      + ` | dom-ready ${ms(result["dom-ready"] ?? NaN)} | 加载完 ${ms(result.total)}`);
  }
  console.log("");
  app.exit(0);
}

main().catch((error) => { console.error(error); app.exit(1); });
