/**
 * 内置浏览器在页面眼里得像一台普通 Chrome。
 *
 * 这些事单元测试验不到：UA 拼出来是对的，不代表它真的那样发出去；客户端提示头设
 * 了，不代表 Chromium 真的带上；`window.chrome` 注进去了，不代表页面里真的看得见。
 * 所以这里起一台真的应用，开一张真的标签页，让页面自己把看到的东西报回来。
 *
 * 每一条断言背后都有一次实测。2026-09-11 那次对比（我们 vs 本机真 Chrome）查出：
 * UA 里带着一个孤零零的 `@`（包名带作用域，老正则只删了一半）、一条 `sec-ch-ua`
 * 都没发、`window.chrome` 是个空对象、`navigator.languages` 报 `zh-Hans-CN`、屏幕
 * 尺寸和视口一模一样、窗口比页面还小。这几条现在都在下面钉着。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const appBinary = join(repositoryRoot, "apps/desktop/release/mac-arm64/CoilCoil.app/Contents/MacOS/CoilCoil");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = createTcpServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/** 探针页：把页面里能被站点看到的那些东西收齐，POST 回来。 */
const PROBE = `<!doctype html><meta charset="utf-8"><title>probe</title><script>
const toStr = (f) => { try { return Function.prototype.toString.call(f); } catch { return "throw"; } };
const r = {};
r.userAgent = navigator.userAgent;
r.webdriver = navigator.webdriver;
r.languages = navigator.languages;
r.chromeKeys = window.chrome ? Object.keys(window.chrome) : null;
r.loadTimesNative = /\\[native code\\]/.test(toStr(window.chrome && window.chrome.loadTimes));
r.electronLeaks = ["process", "require", "module", "__dirname"].filter((k) => k in window);
r.screen = { w: screen.width, h: screen.height };
r.viewport = { w: innerWidth, h: innerHeight };
r.outer = { w: outerWidth, h: outerHeight };
r.notification = (() => { try { return Notification.permission; } catch { return "none"; } })();
navigator.userAgentData.getHighEntropyValues(["fullVersionList"]).then((high) => {
  r.brands = navigator.userAgentData.brands;
  r.uaFullVersion = high.uaFullVersion;
  return fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) });
});
</script>`;

async function waitForRenderer(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = pages.find((item) => item.type === "page" && item.title === "CoilCoil");
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* still starting */ }
    await delay(120);
  }
  throw new Error("CoilCoil did not expose its renderer in time.");
}

async function evaluate(wsUrl, expression) {
  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => fail(new Error("DevTools WebSocket failed.")), { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const send = (method, params) => new Promise((done) => {
    const id = ++sequence;
    pending.set(id, done);
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable", {});
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  socket.close();
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
}

async function main() {
  let report;
  let requestHeaders;
  const sitePort = await freePort();
  const site = createServer((request, response) => {
    if (request.url === "/report") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { report = JSON.parse(body); response.writeHead(204).end(); });
      return;
    }
    requestHeaders = request.headers;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PROBE);
  });
  await new Promise((done, fail) => { site.once("error", fail); site.listen(sitePort, "127.0.0.1", done); });

  const dataDirectory = await mkdtemp(join(tmpdir(), "coilcoil-fingerprint-"));
  const port = await freePort();
  const child = spawn(appBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${dataDirectory}`], { stdio: "ignore" });
  try {
    const page = await waitForRenderer(port);
    const url = `http://127.0.0.1:${sitePort}/probe`;
    await evaluate(page.webSocketDebuggerUrl, `(async () => {
      await window.coilcoil.setBrowserScope("fingerprint", ${JSON.stringify(dataDirectory)});
      await window.coilcoil.createBrowserTab("fingerprint", ${JSON.stringify(url)});
    })()`);
    for (let i = 0; i < 120 && !report; i += 1) await delay(250);
    assert.ok(report, "探针页没有把结果报回来");

    // UA：不带外壳标记，不带任何多出来的词，版本按 Chrome 的规矩只报大版本。
    assert.match(report.userAgent, /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/, `UA 不像一条普通 Chrome：${report.userAgent}`);
    assert.ok(!/electron|coilcoil|@/i.test(report.userAgent), `UA 里还留着我们自己的痕迹：${report.userAgent}`);

    // 客户端提示：真 Chrome 每个请求都带这三个，我们曾经一条都没发。
    assert.ok(requestHeaders["sec-ch-ua"], "请求没带 sec-ch-ua");
    assert.equal(requestHeaders["sec-ch-ua-mobile"], "?0");
    assert.ok(requestHeaders["sec-ch-ua-platform"], "请求没带 sec-ch-ua-platform");
    assert.match(requestHeaders["sec-ch-ua"], /"Google Chrome";v="\d+"/, "提示头里没有 Google Chrome");
    assert.ok(!/electron/i.test(requestHeaders["sec-ch-ua"]), "提示头里还有 Electron");
    assert.match(requestHeaders["accept-language"], /,.+;q=/, `Accept-Language 只报了一项：${requestHeaders["accept-language"]}`);

    // 页面里读到的和发出去的说的是同一句话。
    assert.ok(report.languages.length >= 2, `navigator.languages 太短：${report.languages}`);
    assert.ok(!report.languages.some((tag) => /Hans|Hant/.test(tag)), `languages 里有浏览器几乎不会报的写法：${report.languages}`);
    assert.ok(report.brands.some((brand) => brand.brand === "Google Chrome"), "品牌列表里没有 Google Chrome");
    assert.ok(!report.brands.some((brand) => /electron/i.test(brand.brand)), "品牌列表里还有 Electron");

    // 自动化痕迹。
    assert.equal(report.webdriver, false, "navigator.webdriver 是 true");
    assert.deepEqual(report.electronLeaks, [], `页面里能摸到 Electron 的东西：${report.electronLeaks}`);

    // 真 Chrome 身上有的东西。
    assert.deepEqual(report.chromeKeys, ["loadTimes", "csi", "app"], `window.chrome 不对：${JSON.stringify(report.chromeKeys)}`);
    assert.equal(report.loadTimesNative, true, "chrome.loadTimes 的自述不像原生函数");

    // 屏幕不能等于视口，窗口不能比页面还小——这两条都是真机上不可能出现的。
    assert.ok(report.screen.w !== report.viewport.w || report.screen.h !== report.viewport.h, `屏幕和视口一模一样：${JSON.stringify(report.screen)}`);
    assert.ok(report.outer.w >= report.viewport.w, `窗口比页面还窄：${JSON.stringify(report.outer)} < ${JSON.stringify(report.viewport)}`);
    assert.ok(report.outer.h > report.viewport.h, `窗口比页面还矮：${JSON.stringify(report.outer)} <= ${JSON.stringify(report.viewport)}`);

    // 权限：从来没弹过窗却已经授权，真浏览器里不会发生。
    assert.notEqual(report.notification, "granted", "通知权限凭空是 granted");

    process.stdout.write(`内置浏览器指纹：UA、客户端提示、window.chrome、屏幕与窗口、权限，全部像一台普通 Chrome（${report.userAgent.match(/Chrome\/(\d+)/)[1]}）。\n`);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((done) => child.once("exit", done)), delay(3_000)]);
    await new Promise((done) => site.close(done));
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
