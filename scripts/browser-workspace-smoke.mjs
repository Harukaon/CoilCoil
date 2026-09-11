/**
 * 每个工作区一份登录状态，端到端跑一遍真的应用。
 *
 * 这套改动的三条承诺，单元测试都验不到——它们只在真的 Electron 会话、真的 cookie
 * jar 上才成立：
 *
 *   1. 两个工作区的 cookie 互不可见；
 *   2. 界面切走再切回来，原来的标签页还在，cookie 还是自己那份；
 *   3. 界面切走之后，后台那个会话（Agent 干活的地方）新开的标签页，用的仍然是它
 *      自己工作区的登录状态，不是界面此刻看着的那个。
 *
 * 第三条是这次返工的起因：上一版换工作区会把所有页面丢掉重建，Agent 手里的页面被
 * 连带拔掉。
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
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  await new Promise((done) => server.close(done));
  if (typeof address !== "object" || !address?.port) throw new Error("Unable to reserve a port.");
  return address.port;
}

/**
 * 一个只做两件事的站点：种 cookie，和把收到的 cookie 记下来。
 *
 * 判断隔离有没有生效，看的是「服务端这次收到了谁的 cookie」——在渲染层里读
 * document.cookie 是读不到 guest 页面的，而这一条恰恰是整件事的关键。
 */
function cookieSite() {
  const seen = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const cookie = request.headers.cookie ?? "";
    seen.push({ path: url.pathname, cookie });
    const who = url.searchParams.get("who");
    if (url.pathname === "/set" && who) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": `who=${who}; Path=/; Max-Age=3600`,
      });
      response.end(`<title>set ${who}</title><h1>${who}</h1>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<title>seen</title><pre>${cookie}</pre>`);
  });
  return { server, seen, lastCookie: () => seen.at(-1)?.cookie ?? "" };
}

async function waitForRenderer(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = pages.find((item) => item.type === "page" && item.title === "CoilCoil");
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* still starting */ }
    await delay(100);
  }
  throw new Error("CoilCoil did not expose its renderer in time.");
}

class Renderer {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((done, fail) => {
      this.socket.addEventListener("open", done, { once: true });
      this.socket.addEventListener("error", () => fail(new Error("DevTools WebSocket failed.")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await this.send("Runtime.enable");
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || "Renderer evaluation failed.");
    }
    return response.result.value;
  }

  close() { this.socket.close(); }
}

async function main() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "coilcoil-workspace-cookies-"));
  const workspaceA = join(dataDirectory, "workspace-a");
  const workspaceB = join(dataDirectory, "workspace-b");
  const site = cookieSite();
  const sitePort = await freePort();
  await new Promise((done, fail) => {
    site.server.once("error", fail);
    site.server.listen(sitePort, "127.0.0.1", done);
  });
  const origin = `http://127.0.0.1:${sitePort}`;

  const port = await freePort();
  const child = spawn(appBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${dataDirectory}`], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  let renderer;
  try {
    const page = await waitForRenderer(port);
    renderer = new Renderer(page.webSocketDebuggerUrl);
    await renderer.open();

    const run = async (expression) => renderer.evaluate(`(async () => { ${expression} })()`);
    const navigate = async (scope, url) => {
      await run(`await window.coilcoil.navigateBrowser(${JSON.stringify(scope)}, ${JSON.stringify(url)});`);
      await delay(700);
    };

    // 工作区 A：种下 who=alpha。
    await run(`await window.coilcoil.setBrowserScope("scope-a", ${JSON.stringify(workspaceA)});`);
    await run(`await window.coilcoil.createBrowserTab("scope-a", ${JSON.stringify(`${origin}/set?who=alpha`)});`);
    await delay(900);

    // 工作区 B：另一个会话、另一个文件夹。第一次访问必须看不到 A 的 cookie。
    await run(`await window.coilcoil.setBrowserScope("scope-b", ${JSON.stringify(workspaceB)});`);
    await run(`await window.coilcoil.createBrowserTab("scope-b", ${JSON.stringify(`${origin}/whoami`)});`);
    await delay(900);
    assert.equal(site.lastCookie(), "", `工作区 B 看到了 A 的 cookie：${site.lastCookie()}`);

    await navigate("scope-b", `${origin}/set?who=beta`);

    // 切回 A：标签页还在，cookie 还是 alpha。
    const backToA = await run(`
      await window.coilcoil.setBrowserScope("scope-a", ${JSON.stringify(workspaceA)});
      return {
        a: await window.coilcoil.getBrowserState("scope-a"),
        b: await window.coilcoil.getBrowserState("scope-b"),
      };
    `);
    assert.equal(backToA.a.tabs.length, 1, "切回来之后 A 的标签页没了");
    assert.equal(backToA.b.tabs.length, 1, "切走之后 B 的标签页被丢掉了——后台 Agent 的页面就是这样没的");
    assert.match(backToA.a.tabs[0].url, /127\.0\.0\.1/, "A 的标签页地址丢了");

    await navigate("scope-a", `${origin}/whoami`);
    assert.equal(site.lastCookie(), "who=alpha", `切回 A 之后 cookie 不对：${site.lastCookie()}`);

    // 界面停在 A，后台那个会话（Agent 干活的地方）新开一张：必须还是 B 的身份。
    await run(`await window.coilcoil.createBrowserTab("scope-b", ${JSON.stringify(`${origin}/whoami`)});`);
    await delay(900);
    assert.equal(
      site.lastCookie(),
      "who=beta",
      `界面在 A 时，后台会话开的页面用错了登录状态：${site.lastCookie()}`,
    );

    // 而界面这边再开一张，还是 A 的身份。
    await run(`await window.coilcoil.createBrowserTab("scope-a", ${JSON.stringify(`${origin}/whoami`)});`);
    await delay(900);
    assert.equal(site.lastCookie(), "who=alpha", `界面所在工作区开的页面身份不对：${site.lastCookie()}`);

    process.stdout.write("每个工作区一份登录状态：隔离、切换保留、后台会话身份，三条都通过。\n");
  } finally {
    renderer?.close();
    child.kill("SIGTERM");
    await Promise.race([new Promise((done) => child.once("exit", done)), delay(3_000)]);
    await new Promise((done) => site.server.close(done));
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
