import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const appBinary = join(repositoryRoot, "apps/desktop/release/mac-arm64/SuoCode.app/Contents/MacOS/SuoCode");

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
      const page = pages.find((item) => item.type === "page" && item.title === "SuoCode");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron is still starting.
    }
    await delay(100);
  }
  throw new Error("SuoCode did not expose its renderer in time.");
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

  async waitFor(expression, message, timeout = 30_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (await this.evaluate(`(() => { try { return (${expression}); } catch { return false; } })()`)) return;
      await delay(100);
    }
    throw new Error(message);
  }

  close() {
    this.socket.close();
  }
}

async function main() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "suocode-layout-data-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "suocode-layout-project-"));
  await writeFile(join(projectDirectory, "layout-preview.html"), "<!doctype html><style>body{height:2400px}</style><h1>layout smoke</h1>", "utf8");
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
    await client.waitFor(`document.readyState === "complete" && typeof window.suocode === "object"`, "Renderer did not become ready.");
    await client.waitFor(`Boolean(document.querySelector('textarea[aria-label="发送消息给 SuoCode"]'))`, "Composer did not render.", 45_000);
    if (await client.evaluate(`Boolean(document.querySelector('button[aria-label="返回工作区"]'))`)) {
      await client.evaluate(`document.querySelector('button[aria-label="返回工作区"]')?.click()`);
      await client.waitFor(`Boolean(document.querySelector(".conversation-pane"))`, "Workspace did not open.");
    }

    const conversation = await client.evaluate(`(() => {
      const pane = document.querySelector(".conversation-pane");
      const body = document.querySelector(".conversation-body");
      return {
        hasActivity: pane?.classList.contains("has-composer-activity") ?? true,
        paddingBottom: body ? Number.parseFloat(getComputedStyle(body).paddingBottom) : Infinity,
      };
    })()`);
    assert.deepEqual(conversation, { hasActivity: false, paddingBottom: 76 });

    await client.evaluate(`document.querySelector('button[aria-label="展开作业栏"]')?.click()`);
    await client.waitFor(`Boolean(document.querySelector(".inspector-pane"))`, "Inspector did not open.");
    await client.evaluate(`document.querySelector('.inspector-nav button[aria-label="运行时"]')?.click()`);
    const tabs = await client.evaluate(`(() => {
      const runtime = document.querySelector('.inspector-nav button[aria-label="运行时"]');
      const label = runtime?.querySelector("span");
      return {
        buttonWidth: runtime?.getBoundingClientRect().width ?? 0,
        labelWidth: label?.getBoundingClientRect().width ?? 0,
        labelScrollWidth: label?.scrollWidth ?? Infinity,
        contextComposition: document.body.textContent.includes("上下文构成"),
      };
    })()`);
    assert.ok(tabs.buttonWidth > 45);
    assert.ok(tabs.labelWidth >= tabs.labelScrollWidth);
    assert.equal(tabs.contextComposition, false);

    await client.evaluate(`(() => {
      const project = { name: "layout-project", path: ${JSON.stringify(projectDirectory)}, kind: "workspace" };
      localStorage.setItem("suocode.mounted-projects", JSON.stringify([project]));
      localStorage.setItem("suocode.active-project", project.path);
      location.reload();
    })()`);
    await client.waitFor(`Boolean(document.querySelector('textarea[aria-label="发送消息给 SuoCode"]'))`, "Mounted project did not open.", 45_000);
    if (await client.evaluate(`Boolean(document.querySelector('button[aria-label="返回工作区"]'))`)) {
      await client.evaluate(`document.querySelector('button[aria-label="返回工作区"]')?.click()`);
    }
    await client.evaluate(`document.querySelector('button[aria-label="展开作业栏"]')?.click()`);
    await client.waitFor(`Boolean(document.querySelector(".inspector-pane"))`, "Inspector did not reopen.");
    await client.evaluate(`document.querySelector('.inspector-nav button[aria-label="文件"]')?.click()`);
    await client.waitFor(`[...document.querySelectorAll(".file-leaf")].some((item) => item.textContent.includes("layout-preview.html"))`, "Fixture file did not appear.");
    await client.evaluate(`[...document.querySelectorAll(".file-leaf")].find((item) => item.textContent.includes("layout-preview.html"))?.click()`);
    await client.waitFor(`Boolean(document.querySelector(".inline-preview-content.embedded iframe.html-preview"))`, "HTML preview did not render.");
    const preview = await client.evaluate(`(() => {
      const workspace = document.querySelector(".files-workspace.has-preview")?.getBoundingClientRect();
      const handle = document.querySelector(".files-split-resizer")?.getBoundingClientRect();
      const pane = document.querySelector(".inline-file-preview")?.getBoundingClientRect();
      const content = document.querySelector(".inline-preview-content.embedded");
      return workspace && handle && pane && content ? {
        workspaceLeft: workspace.left,
        workspaceWidth: workspace.width,
        handleX: handle.left + handle.width / 2,
        handleY: handle.top + handle.height / 2,
        paneWidth: pane.width,
        overflowX: getComputedStyle(content).overflowX,
        overflowY: getComputedStyle(content).overflowY,
        outerScrollable: content.scrollHeight > content.clientHeight + 1,
      } : null;
    })()`);
    assert.ok(preview);
    assert.deepEqual({ overflowX: preview.overflowX, overflowY: preview.overflowY, outerScrollable: preview.outerScrollable }, {
      overflowX: "hidden",
      overflowY: "hidden",
      outerScrollable: false,
    });
    const targetX = preview.workspaceLeft + preview.workspaceWidth * 0.55;
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: preview.handleX, y: preview.handleY, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: targetX, y: preview.handleY, button: "left", buttons: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: targetX, y: preview.handleY, button: "left", buttons: 0, clickCount: 1 });
    await client.waitFor(`Math.abs((document.querySelector(".inline-file-preview")?.getBoundingClientRect().width ?? 0) - ${preview.paneWidth}) > 20`, "Preview divider did not resize panes.");

    process.stdout.write("SuoCode desktop layout smoke passed.\n");
  } finally {
    client?.close();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(2_000),
    ]);
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(projectDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
