import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The renderer nominates the tabId -> webContentsId mapping for every browser
 * guest, which makes registration the one place a renderer bug could bind one
 * agent's CDP target to another agent's page. Scope checks downstream cannot
 * catch that: they validate the scope recorded on the tab, not the identity of
 * the WebContents behind it. This asserts the registry refuses everything except
 * the exact guest it is waiting for, and that the app's own renderer is never
 * reachable through the CDP bridge.
 */

const repositoryRoot = resolve(import.meta.dirname, "..");
const appBinary = join(repositoryRoot, "apps/desktop/release/mac-arm64/CoilCoil.app/Contents/MacOS/CoilCoil");

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

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
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || "Renderer evaluation failed.");
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function main() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "coilcoil-guest-security-"));
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
      const attempt = async (run) => {
        try { await run(); return "ACCEPTED"; }
        catch (error) { return String(error?.message ?? error); }
      };

      // A tab main is not waiting for.
      const unknownTab = await attempt(() => window.coilcoil.registerBrowserGuest("not-a-tab", "nonce", 2));

      const created = await window.coilcoil.createBrowserTab("security", "data:text/html,<title>S</title>");
      const tabId = created.tabs[0].id;
      const liveGuest = document.querySelector(".browser-guest-layer > webview");
      const liveId = liveGuest ? liveGuest.getWebContentsId() : -1;

      // A tab that already has its guest cannot be rebound, with any id.
      const rebind = await attempt(() => window.coilcoil.registerBrowserGuest(tabId, "nonce", liveId));

      // Sweep low webContents ids: the app renderer and every other contents in
      // the process must be refused, whatever the caller claims.
      const sweep = [];
      for (let id = 1; id <= 30; id++) {
        const outcome = await attempt(() => window.coilcoil.registerBrowserGuest(tabId, "nonce", id));
        if (outcome === "ACCEPTED") sweep.push(id);
      }

      await window.coilcoil.closeBrowserTab("security", tabId);
      return { unknownTab, rebind, acceptedIds: sweep };
    })()`);

    assert.notEqual(result.unknownTab, "ACCEPTED", "Registration succeeded for a tab main was not waiting for.");
    assert.notEqual(result.rebind, "ACCEPTED", "An already-bound tab accepted a second guest.");
    assert.deepEqual(result.acceptedIds, [], `Registration accepted foreign webContents ids: ${JSON.stringify(result.acceptedIds)}`);

    console.log("CoilCoil browser guest security smoke passed.");
  } finally {
    client?.close();
    child.kill("SIGKILL");
    await delay(300);
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

await main();
