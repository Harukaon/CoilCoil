import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");
const appBinary = join(
  repositoryRoot,
  "apps/desktop/release/mac-arm64/SuoCode.app/Contents/MacOS/SuoCode",
);

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
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!port) throw new Error("Unable to reserve a DevTools port.");
  return port;
}

async function waitForPage(port, timeout = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === "page" && item.title === "SuoCode");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron may still be starting.
    }
    await delay(100);
  }
  throw new Error("Packaged SuoCode did not expose its renderer in time.");
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
    await this.send("Page.enable");
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolveCommand, reject) => {
      this.pending.set(id, { resolve: resolveCommand, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || "Renderer evaluation failed.");
    }
    return response.result.value;
  }

  async waitFor(expression, message, timeout = 30_000) {
    const startedAt = Date.now();
    let lastError;
    while (Date.now() - startedAt < timeout) {
      try {
        const result = await this.evaluate(`(() => { try { return (${expression}); } catch { return false; } })()`);
        if (result) return result;
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(`${message}${lastError ? ` (${lastError.message})` : ""}`);
  }

  close() {
    this.socket.close();
  }
}

async function clickInspector(client, label) {
  await client.evaluate(`(() => {
    const button = [...document.querySelectorAll(".inspector-nav button")]
      .find((item) => item.textContent.includes(${JSON.stringify(label)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function submitPrompt(client, prompt, responseToken, timeout = 120_000) {
  const submitted = await client.evaluate(`(async () => {
    const input = document.querySelector('textarea[aria-label="发送消息给 SuoCode"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    input.form.requestSubmit();
    return true;
  })()`);
  assert.equal(submitted, true);
  await client.waitFor(
    `[...document.querySelectorAll(".assistant-message")].some((item) => item.textContent.includes(${JSON.stringify(responseToken)}))`,
    `The packaged GUI did not render the expected response ${responseToken}.`,
    timeout,
  );
  await client.waitFor(
    `!document.querySelector(".agent-activity")`,
    `The Agent run for ${responseToken} did not settle.`,
    30_000,
  );
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("The current packaged desktop smoke test targets the macOS app bundle.");
  }

  const dataDirectory = await mkdtemp(join(tmpdir(), "suocode-desktop-data-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "suocode-desktop-project-"));
  execFileSync("git", ["init", "--quiet", projectDirectory]);
  const port = await freePort();
  const logs = [];
  const child = spawn(appBinary, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dataDirectory}`,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  let client;
  try {
    const page = await waitForPage(port);
    client = new DevToolsClient(page.webSocketDebuggerUrl);
    await client.open();
    await client.waitFor(
      `document.readyState === "complete" && typeof window.suocode === "object"`,
      "The renderer or preload bridge did not become ready.",
    );

    const isolation = await client.evaluate(`({
      title: document.title,
      bridge: typeof window.suocode,
      nodeRequire: typeof window.require,
      nodeProcess: typeof window.process,
      panes: [".sidebar", ".conversation-pane", ".inspector-pane"].every((selector) => Boolean(document.querySelector(selector))),
      rightClosed: document.querySelector(".app-shell")?.classList.contains("right-collapsed"),
      leftResizer: Boolean(document.querySelector(".left-resizer")),
      rightResizer: Boolean(document.querySelector(".right-resizer")),
      inspector: document.querySelector(".inspector-nav")?.textContent || ""
    })`);
    assert.equal(isolation.title, "SuoCode");
    assert.equal(isolation.bridge, "object");
    assert.equal(isolation.nodeRequire, "undefined");
    assert.equal(isolation.nodeProcess, "undefined");
    assert.equal(isolation.panes, true);
    assert.equal(isolation.rightClosed, true);
    assert.equal(isolation.rightResizer, false);
    for (const label of ["Todo", "变更", "终端", "文件"]) {
      assert.match(isolation.inspector, new RegExp(label));
    }
    const regularToggleSize = await client.evaluate(`(() => {
      const bounds = document.querySelector('button[aria-label="收起侧栏"]')?.getBoundingClientRect();
      return bounds ? { width: bounds.width, height: bounds.height } : null;
    })()`);
    assert.deepEqual(regularToggleSize, { width: 30, height: 30 });

    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 350,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.waitFor(
      `window.innerWidth <= 350`,
      "The packaged desktop window could not shrink to 350px.",
    );
    await client.evaluate(`(async () => {
      if (!document.querySelector(".app-shell")?.classList.contains("left-collapsed")) return true;
      document.querySelector('button[aria-label="展开侧栏"]')?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return true;
    })()`);
    const compactSidebarClosed = await client.evaluate(`(async () => {
      const button = document.querySelector('button[aria-label="收起侧栏"]');
      if (!button) return false;
      const dragRegion = document.querySelector(".sidebar-drag-region");
      const buttonBounds = button.getBoundingClientRect();
      const dragBounds = dragRegion?.getBoundingClientRect();
      if (buttonBounds.width !== 50 || buttonBounds.height !== 50) return false;
      if (getComputedStyle(button).webkitAppRegion !== "no-drag") return false;
      if (dragBounds && buttonBounds.left < dragBounds.right) return false;
      const hitPoints = [
        [buttonBounds.left + 5, buttonBounds.top + 5],
        [buttonBounds.right - 5, buttonBounds.top + 5],
        [buttonBounds.left + 5, buttonBounds.bottom - 5],
        [buttonBounds.right - 5, buttonBounds.bottom - 5],
        [buttonBounds.left + buttonBounds.width / 2, buttonBounds.top + buttonBounds.height / 2],
      ];
      for (const [x, y] of hitPoints) {
        if (document.elementFromPoint(x, y)?.closest("button") !== button) return false;
        if (document.elementsFromPoint(x, y).some((element) => getComputedStyle(element).webkitAppRegion === "drag")) return false;
      }
      if (button.closest(".window-drag")) return false;
      button.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return document.querySelector(".app-shell")?.classList.contains("left-collapsed") ?? false;
    })()`);
    assert.equal(compactSidebarClosed, true);
    const compactSidebarOpened = await client.evaluate(`(async () => {
      const button = document.querySelector('button[aria-label="展开侧栏"]');
      if (!button) return false;
      button.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return !document.querySelector(".app-shell")?.classList.contains("left-collapsed");
    })()`);
    assert.equal(compactSidebarOpened, true);
    await client.send("Emulation.clearDeviceMetricsOverride");

    await client.evaluate(`(() => {
      localStorage.setItem("suocode.selected-project", ${JSON.stringify(JSON.stringify({
        name: basename(projectDirectory),
        path: projectDirectory,
      }))});
      location.reload();
      return true;
    })()`);
    await client.waitFor(
      `Boolean(document.querySelector('textarea[aria-label="发送消息给 SuoCode"]:not([disabled])'))`,
      "The packaged app could not create a project session through IPC.",
      45_000,
    );
    const projectState = await client.evaluate(`({
      status: document.querySelector(".workspace-status")?.textContent || "",
      session: document.querySelector(".conversation-title")?.textContent || ""
    })`);
    assert.match(projectState.status, new RegExp(projectDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(projectState.session.length > 0);

    if (live) {
      await client.evaluate(`(() => {
        window.__suocodeSmokeEvents = [];
        window.__suocodeSmokeUnsubscribe?.();
        window.__suocodeSmokeUnsubscribe = window.suocode.onRuntimeEvent((event) => {
          window.__suocodeSmokeEvents.push({
            type: event.type,
            field: event.type === "message_delta" ? event.field : undefined,
            running: event.type === "run_state" ? event.running : undefined,
          });
        });
        return true;
      })()`);
      const planToken = `DESKTOP_PLAN_OK_${Date.now()}`;
      const fileToken = `DESKTOP_FILE_OK_${Date.now()}`;
      const terminalToken = `DESKTOP_TERMINAL_OK_${Date.now()}`;
      const fileName = "suocode-desktop-smoke.txt";
      await submitPrompt(
        client,
        `You must call the todo tool once before replying. Set exactly two short plan items and mark both completed. Do not call another tool. Then reply exactly ${planToken}.`,
        planToken,
      );
      await submitPrompt(
        client,
        `You must call the write tool before replying. Create ${fileName} in the current project with exactly this content: ${fileToken}. Do not use bash or edit. Then reply exactly ${fileToken}.`,
        fileToken,
      );
      await submitPrompt(
        client,
        `You must execute a shell tool before replying. Run exactly: printf ${terminalToken}. Then reply exactly ${terminalToken}.`,
        terminalToken,
      );

      await client.evaluate(`window.suocode.request({ type: "refresh_project" })`);

      const toolState = await client.evaluate(`({
        count: document.querySelectorAll(".tool-activity-row").length,
        failed: document.querySelectorAll(".tool-activity-row.failed").length,
        text: [...document.querySelectorAll(".tool-activity-row")].map((item) => item.textContent).join("\\n")
      })`);
      assert.ok(toolState.count >= 3, `Expected at least three tool calls, received ${toolState.count}: ${toolState.text}`);
      assert.equal(toolState.failed, 0);
      assert.match(toolState.text, /todo/i);
      assert.match(toolState.text, /write/i);
      assert.match(toolState.text, /bash|terminal/i);

      const eventState = await client.evaluate(`window.__suocodeSmokeEvents`);
      const eventTypes = new Set(eventState.map((event) => event.type));
      for (const eventType of ["message_delta", "tool_started", "tool_finished", "plan_updated", "project_updated", "run_state"]) {
        assert.equal(eventTypes.has(eventType), true, `Missing streamed runtime event: ${eventType}`);
      }
      assert.equal(eventState.some((event) => event.type === "message_delta" && event.field === "text"), true);
      assert.equal(eventState.some((event) => event.type === "run_state" && event.running === true), true);
      assert.equal(eventState.some((event) => event.type === "run_state" && event.running === false), true);

      await clickInspector(client, "Todo");
      await client.waitFor(
        `document.querySelectorAll(".plan-list li.completed").length >= 2`,
        "Completed todo state was not projected into Plan.",
      );

      await clickInspector(client, "变更");
      await client.waitFor(
        `[...document.querySelectorAll(".change-path")].some((item) => item.textContent.includes(${JSON.stringify(fileName)}))`,
        "The Agent-written file was not projected into Changes.",
      );

      await clickInspector(client, "终端");
      await client.waitFor(
        `[...document.querySelectorAll(".terminal-card")].some((item) => item.textContent.includes(${JSON.stringify(terminalToken)}))`,
        "Bash output was not projected into Terminal.",
      );

      await clickInspector(client, "文件");
      await client.waitFor(
        `[...document.querySelectorAll(".file-leaf")].some((item) => item.textContent.includes(${JSON.stringify(fileName)}))`,
        "The Agent-written file was not projected into Files.",
      );
      await client.evaluate(`(() => {
        const file = [...document.querySelectorAll(".file-leaf")]
          .find((item) => item.textContent.includes(${JSON.stringify(fileName)}));
        file?.click();
        return Boolean(file);
      })()`);
      await client.waitFor(
        `document.querySelector(".file-preview")?.textContent.includes(${JSON.stringify(fileToken)})`,
        "The Files panel could not read the Agent-written file through IPC.",
      );
      assert.equal((await readFile(join(projectDirectory, fileName), "utf8")).trim(), fileToken);

      await client.send("Page.reload", { ignoreCache: true });
      await client.waitFor(
        `[...document.querySelectorAll(".assistant-message")].some((item) => item.textContent.includes(${JSON.stringify(terminalToken)}))`,
        "The completed conversation was not restored after a renderer restart.",
        60_000,
      );
      await client.waitFor(
        `document.querySelector(".conversation-row")?.textContent.length > 0`,
        "The persisted session was not listed after restart.",
      );
    }

    process.stdout.write(`SuoCode Desktop smoke passed${live ? " (live Agent + tools + restored session)" : ""}.\n`);
  } catch (error) {
    if (logs.length) process.stderr.write(`\nPackaged application logs:\n${logs.join("")}\n`);
    throw error;
  } finally {
    client?.close();
    await stopProcess(child);
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(projectDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
