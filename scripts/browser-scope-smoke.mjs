import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const appBinary = join(repositoryRoot, "apps/desktop/release/mac-arm64/CoilCoil.app/Contents/MacOS/CoilCoil");

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (typeof address !== "object" || !address?.port) throw new Error("Unable to reserve a DevTools port.");
  return address.port;
}

async function waitForPage(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === "page" && item.title === "CoilCoil");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron is still starting.
    }
    await delay(100);
  }
  throw new Error("CoilCoil did not expose its renderer in time.");
}

class DevToolsClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("DevTools WebSocket failed.")), { once: true });
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
    return new Promise((resolveCommand, reject) => {
      this.pending.set(id, { resolve: resolveCommand, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || "Renderer evaluation failed.");
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function main() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "coilcoil-browser-scope-"));
  const port = await freePort();
  const child = spawn(appBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${dataDirectory}`], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  let client;
  try {
    const page = await waitForPage(port);
    client = new DevToolsClient(page.webSocketDebuggerUrl);
    await client.open();
    const result = await client.evaluate(`(async () => {
      const a = await window.coilcoil.createBrowserTab("scope-a", "data:text/html,<title>Scope A</title><h1>A</h1>");
      const b = await window.coilcoil.createBrowserTab("scope-b", "data:text/html,<title>Scope B</title><h1>B</h1>");
      const aState = await window.coilcoil.getBrowserState("scope-a");
      const bState = await window.coilcoil.getBrowserState("scope-b");
      let crossScopeError = "";
      try { await window.coilcoil.selectBrowserTab("scope-a", b.tabs[0].id); }
      catch (error) { crossScopeError = String(error); }
      await window.coilcoil.closeBrowserTab("scope-a", a.tabs[0].id);
      return {
        aState,
        bState,
        aAfterClose: await window.coilcoil.getBrowserState("scope-a"),
        bAfterClose: await window.coilcoil.getBrowserState("scope-b"),
        crossScopeError,
      };
    })()`);
    assert.equal(result.aState.scopeId, "scope-a");
    assert.equal(result.bState.scopeId, "scope-b");
    assert.equal(result.aState.tabs.length, 1);
    assert.equal(result.bState.tabs.length, 1);
    assert.notEqual(result.aState.tabs[0].id, result.bState.tabs[0].id);
    assert.match(result.crossScopeError, /浏览器标签页不存在/);
    assert.equal(result.aAfterClose.tabs.length, 0);
    assert.equal(result.bAfterClose.tabs.length, 1);
    process.stdout.write("CoilCoil browser scope smoke passed.\n");
  } finally {
    client?.close();
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(2_000)]);
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
