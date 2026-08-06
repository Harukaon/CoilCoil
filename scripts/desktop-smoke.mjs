import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function waitForPreviewPage(port, timeout = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
    const page = pages.find((item) => item.type === "page" && String(item.url).includes("preview="));
    if (page?.webSocketDebuggerUrl) return page;
    await delay(100);
  }
  throw new Error("The independent file preview window did not open.");
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

async function submitPrompt(client, prompt, expectedTool, timeout = 120_000) {
  const eventStart = await client.evaluate(`window.__suocodeSmokeEvents?.length ?? 0`);
  const submitted = await client.evaluate(`(async () => {
    const input = document.querySelector('textarea[aria-label="发送消息给 SuoCode"]');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    input.closest("form")?.requestSubmit();
    return true;
  })()`);
  assert.equal(submitted, true);
  await client.waitFor(
    `window.__suocodeSmokeEvents?.slice(${eventStart}).some((event) => event.type === "tool_finished" && event.toolName === ${JSON.stringify(expectedTool)}) && window.__suocodeSmokeEvents?.slice(${eventStart}).some((event) => event.type === "run_state" && event.running === false)`,
    `The packaged GUI did not complete the expected ${expectedTool} tool run.`,
    timeout,
  );
  await client.waitFor(
    `!document.querySelector(".agent-activity")`,
    `The Agent run for ${expectedTool} did not settle.`,
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
  const concurrentDirectoryA = await mkdtemp(join(tmpdir(), "suocode-concurrent-a-"));
  const concurrentDirectoryB = await mkdtemp(join(tmpdir(), "suocode-concurrent-b-"));
  execFileSync("git", ["init", "--quiet", projectDirectory]);
  await mkdir(join(projectDirectory, "lazy-folder"));
  await writeFile(join(projectDirectory, "lazy-folder", "lazy-child.txt"), "lazy\n", "utf8");
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
    await client.waitFor(
      `document.querySelector(".project-row span")?.textContent === "Home" && Boolean(document.querySelector('textarea[aria-label="发送消息给 SuoCode"]'))`,
      "The desktop app did not initialize its private Home workspace.",
      45_000,
    );
    const homeState = await client.evaluate(`(async () => {
      const home = await window.suocode.homeProject();
      return {
        home,
        projectName: document.querySelector(".project-row span")?.textContent || "",
        status: document.querySelector(".workspace-status")?.textContent || "",
      };
    })()`);
    assert.equal(homeState.home.name, "Home");
    assert.equal(homeState.home.kind, "home");
    assert.match(homeState.home.path, /\/Home$/);
    assert.equal(homeState.projectName, "Home");
    assert.match(homeState.status, /Home/);
    const expandedHomePath = await client.evaluate(`(async () => {
      document.querySelector(".workspace-path")?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return document.querySelector(".path-popover")?.textContent || "";
    })()`);
    assert.match(expandedHomePath, new RegExp(homeState.home.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

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
    assert.match(isolation.inspector, /文件/);
    assert.doesNotMatch(isolation.inspector, /Todo|变更|终端/);
    const metricControlOrder = await client.evaluate(`(() => {
      const performance = document.querySelector(".performance-trigger");
      const context = document.querySelector(".context-trigger");
      return Boolean(performance && context && (performance.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`);
    assert.equal(metricControlOrder, true);
    const inspectorDragSurface = await client.evaluate(`(() => {
      const surface = document.querySelector(".inspector-drag-surface");
      const bounds = surface?.getBoundingClientRect();
      if (!surface || !bounds) return null;
      const center = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return { region: getComputedStyle(surface).webkitAppRegion, width: bounds.width, hit: center === surface };
    })()`);
    assert.equal(inspectorDragSurface?.region, "drag");
    const runtimeIsolation = await client.evaluate(`(async () => {
      const first = await window.suocode.request({ type: "create_session", cwd: ${JSON.stringify(concurrentDirectoryA)} });
      const second = await window.suocode.request({ type: "create_session", cwd: ${JSON.stringify(concurrentDirectoryB)} });
      return { first: first.runtimeId, second: second.runtimeId };
    })()`);
    assert.ok(runtimeIsolation.first);
    assert.ok(runtimeIsolation.second);
    assert.notEqual(runtimeIsolation.first, runtimeIsolation.second);
    const regularToggleSize = await client.evaluate(`(() => {
      const bounds = document.querySelector('button[aria-label="收起侧栏"]')?.getBoundingClientRect();
      return bounds ? { width: bounds.width, height: bounds.height } : null;
    })()`);
    assert.deepEqual(regularToggleSize, { width: 30, height: 30 });
    const macTrafficLightSpacing = await client.evaluate(`(async () => {
      document.querySelector('button[aria-label="收起侧栏"]')?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      const header = document.querySelector(".conversation-header");
      const openButton = document.querySelector('button[aria-label="展开侧栏"]');
      const result = {
        platform: window.suocode.platform,
        paddingLeft: header ? Number.parseFloat(getComputedStyle(header).paddingLeft) : 0,
        buttonLeft: openButton?.getBoundingClientRect().left ?? 0,
      };
      openButton?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return result;
    })()`);
    if (macTrafficLightSpacing.platform === "darwin") {
      assert.ok(macTrafficLightSpacing.paddingLeft >= 82);
      assert.ok(macTrafficLightSpacing.buttonLeft >= 82);
    }

    const panelWidthBeforeWindowResize = await client.evaluate(`({
      sidebar: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      conversation: document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0
    })`);
    await client.evaluate(`(() => { window.resizeTo(1_000, 700); return true; })()`);
    await client.waitFor(`window.innerWidth <= 1_000`, "The window did not resize for the panel preservation test.");
    const panelWidthAfterWindowResize = await client.evaluate(`({
      sidebar: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      conversation: document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0
    })`);
    assert.equal(panelWidthAfterWindowResize.sidebar, panelWidthBeforeWindowResize.sidebar);
    assert.ok(panelWidthAfterWindowResize.conversation < panelWidthBeforeWindowResize.conversation);

    await client.evaluate(`(() => { window.resizeTo(395, 700); return true; })()`);
    await client.waitFor(`window.innerWidth <= 700`, "The window did not enter its compact layout.");
    await client.evaluate(`(() => { window.resizeTo(395, 700); return true; })()`);
    await client.waitFor(
      `window.innerWidth <= 395`,
      "The packaged desktop window could not shrink to 395px.",
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
    const compactInspectorLayout = await client.evaluate(`(async () => {
      document.querySelector('button[aria-label="展开作业栏"]')?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      const shell = document.querySelector(".app-shell");
      const conversation = document.querySelector(".conversation-pane");
      const inspector = document.querySelector(".inspector-pane");
      const conversationBounds = conversation?.getBoundingClientRect();
      const inspectorBounds = inspector?.getBoundingClientRect();
      const result = {
        shellTransition: shell ? getComputedStyle(shell).transitionDuration : "",
        sidebarTransition: getComputedStyle(document.querySelector(".sidebar")).transitionDuration,
        inspectorPosition: inspector ? getComputedStyle(inspector).position : "",
        conversationWidth: conversationBounds?.width ?? 0,
        conversationRight: conversationBounds?.right ?? 0,
        inspectorLeft: inspectorBounds?.left ?? 0,
        inspectorWidth: inspectorBounds?.width ?? 0,
        rightResizer: Boolean(document.querySelector(".right-resizer")),
      };
      document.querySelector('button[aria-label="收起右侧栏"]')?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return result;
    })()`);
    assert.equal(compactInspectorLayout.shellTransition, "0s");
    assert.equal(compactInspectorLayout.sidebarTransition, "0s");
    assert.notEqual(compactInspectorLayout.inspectorPosition, "absolute");
    assert.ok(compactInspectorLayout.conversationWidth >= 315);
    assert.ok(compactInspectorLayout.inspectorWidth >= 40);
    assert.ok(compactInspectorLayout.inspectorLeft >= compactInspectorLayout.conversationRight - 1);
    assert.equal(compactInspectorLayout.rightResizer, true);
    await client.evaluate(`(() => { window.resizeTo(1440, 900); return true; })()`);
    await client.waitFor(`window.innerWidth >= 1400`, "The window did not return to its regular test size.");
    await client.evaluate(`document.querySelector('button[aria-label="展开作业栏"]')?.click()`);
    await client.waitFor(`Boolean(document.querySelector(".right-resizer"))`, "The right panel did not open for resize priority testing.");
    const preferredPanelWidths = await client.evaluate(`({
      left: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      right: document.querySelector(".inspector-pane")?.getBoundingClientRect().width ?? 0
    })`);
    await client.evaluate(`window.resizeTo(500, 700)`);
    await client.waitFor(`window.innerWidth <= 500`, "The window did not shrink through the panel priority range.");
    await client.waitFor(
      `document.querySelector(".conversation-pane")?.getBoundingClientRect().width <= 316 && document.querySelector(".inspector-pane")?.getBoundingClientRect().width <= 41`,
      "The right panel did not compress after the conversation reached its minimum.",
    );
    const compressedPanelWidths = await client.evaluate(`({
      left: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      center: document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0,
      right: document.querySelector(".inspector-pane")?.getBoundingClientRect().width ?? 0,
      tiled: document.querySelector(".app-shell")?.classList.contains("keep-tiled") ?? false
    })`);
    assert.equal(compressedPanelWidths.tiled, true);
    assert.ok(compressedPanelWidths.center <= 316 && compressedPanelWidths.center >= 314);
    assert.ok(compressedPanelWidths.right <= 41 && compressedPanelWidths.right >= 39);
    assert.ok(compressedPanelWidths.left > 40 && compressedPanelWidths.left < preferredPanelWidths.left);
    await client.evaluate(`window.resizeTo(395, 700)`);
    await client.waitFor(`window.innerWidth <= 395`, "The window did not reach the three-pane minimum width.");
    await client.waitFor(
      `document.querySelector(".sidebar")?.getBoundingClientRect().width <= 41 && document.querySelector(".inspector-pane")?.getBoundingClientRect().width <= 41`,
      "The left panel did not compress after the right panel reached its minimum.",
    );
    const minimumPanelWidths = await client.evaluate(`({
      left: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      center: document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0,
      right: document.querySelector(".inspector-pane")?.getBoundingClientRect().width ?? 0
    })`);
    assert.ok(minimumPanelWidths.center <= 316 && minimumPanelWidths.center >= 314);
    assert.ok(minimumPanelWidths.left <= 41 && minimumPanelWidths.left >= 39);
    assert.ok(minimumPanelWidths.right <= 41 && minimumPanelWidths.right >= 39);
    const narrowConversationLayout = await client.evaluate(`(() => {
      const body = document.querySelector(".conversation-body");
      if (!body) return null;
      const probe = document.createElement("div");
      probe.className = "agent-turn-content";
      probe.innerHTML = '<details class="tool-activity"><summary><span>思考了 7 次，编辑了 1 个文件，查看了 2 个文件，搜索 1 次，运行了 4 个命令，调用了 3 个工具</span><svg width="14"></svg></summary></details><div class="assistant-segment"><div class="markdown"><p>测试过程中的长中文内容必须在很窄的聊天窗口中正确换行而不能被右侧文件栏遮挡。<code>very-long-inline-token-without-natural-breaks-0123456789</code></p></div></div>';
      body.append(probe);
      const result = {
        paddingBottom: Number.parseFloat(getComputedStyle(body).paddingBottom),
        clientWidth: body.clientWidth,
        scrollWidth: body.scrollWidth,
        probeRight: probe.getBoundingClientRect().right,
        probeScrollWidth: probe.scrollWidth,
        probeClientWidth: probe.clientWidth,
        bodyRight: body.getBoundingClientRect().right,
      };
      probe.remove();
      return result;
    })()`);
    assert.ok((narrowConversationLayout?.paddingBottom ?? 0) >= 175);
    assert.ok((narrowConversationLayout?.scrollWidth ?? 1) <= (narrowConversationLayout?.clientWidth ?? 0) + 1);
    assert.ok((narrowConversationLayout?.probeScrollWidth ?? 1) <= (narrowConversationLayout?.probeClientWidth ?? 0) + 1);
    assert.ok((narrowConversationLayout?.probeRight ?? 1) <= (narrowConversationLayout?.bodyRight ?? 0) + 1);
    await client.evaluate(`window.resizeTo(1440, 900)`);
    await client.waitFor(`window.innerWidth >= 1400`, "The window did not expand after panel compression.");
    await client.waitFor(
      `Math.abs((document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0) - ${preferredPanelWidths.left}) <= 1 && Math.abs((document.querySelector(".inspector-pane")?.getBoundingClientRect().width ?? 0) - ${preferredPanelWidths.right}) <= 1`,
      "The panels did not restore their preferred widths after the window expanded.",
    );
    const restoredPanelWidths = await client.evaluate(`({
      left: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      right: document.querySelector(".inspector-pane")?.getBoundingClientRect().width ?? 0
    })`);
    assert.ok(
      Math.abs(restoredPanelWidths.left - preferredPanelWidths.left) <= 1,
      `Left panel did not restore: preferred ${preferredPanelWidths.left}px, restored ${restoredPanelWidths.left}px.`,
    );
    assert.ok(
      Math.abs(restoredPanelWidths.right - preferredPanelWidths.right) <= 1,
      `Right panel did not restore: preferred ${preferredPanelWidths.right}px, restored ${restoredPanelWidths.right}px.`,
    );
    const openInspectorDragSurface = await client.evaluate(`(() => {
      const surface = document.querySelector(".inspector-drag-surface");
      const bounds = surface?.getBoundingClientRect();
      if (!surface || !bounds) return null;
      const center = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return { width: bounds.width, hit: center === surface };
    })()`);
    assert.ok((openInspectorDragSurface?.width ?? 0) > 100);
    assert.equal(openInspectorDragSurface?.hit, true);
    const rightHandle = await client.evaluate(`(() => {
      const bounds = document.querySelector(".right-resizer")?.getBoundingClientRect();
      return bounds ? { x: bounds.left + bounds.width / 2, y: bounds.height / 2 } : null;
    })()`);
    assert.ok(rightHandle);
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rightHandle.x, y: rightHandle.y, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: rightHandle.y, button: "left", buttons: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: rightHandle.y, button: "left", buttons: 0, clickCount: 1 });
    const narrowConversation = await client.evaluate(`({
      conversation: document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0,
      inspector: document.querySelector(".inspector-pane")?.getBoundingClientRect().width ?? 0
    })`);
    assert.ok(narrowConversation.conversation <= 316, `Conversation pane stopped at ${narrowConversation.conversation}px instead of 315px.`);
    assert.ok(narrowConversation.inspector >= 800);
    const expandedHandle = await client.evaluate(`(() => {
      const bounds = document.querySelector(".right-resizer")?.getBoundingClientRect();
      return bounds ? { x: bounds.left + bounds.width / 2, y: bounds.height / 2 } : null;
    })()`);
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: expandedHandle.x, y: expandedHandle.y, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1_088, y: expandedHandle.y, button: "left", buttons: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1_088, y: expandedHandle.y, button: "left", buttons: 0, clickCount: 1 });
    await client.evaluate(`document.querySelector('button[aria-label="收起右侧栏"]')?.click()`);

    const todoOverlayLayout = await client.evaluate(`(() => {
      const stack = document.querySelector(".composer-stack");
      if (!stack) return null;
      const before = stack.getBoundingClientRect().height;
      const plan = document.createElement("section");
      plan.className = "composer-plan expanded";
      plan.innerHTML = '<button class="composer-plan-toggle"><span>Todo</span></button><div class="composer-plan-body"><ol><li>测试</li></ol></div>';
      stack.prepend(plan);
      const after = stack.getBoundingClientRect().height;
      const position = getComputedStyle(plan).position;
      plan.remove();
      return { before, after, position };
    })()`);
    assert.equal(todoOverlayLayout?.position, "absolute");
    assert.equal(todoOverlayLayout?.after, todoOverlayLayout?.before);

    await client.evaluate(`(() => {
      const project = ${JSON.stringify({
        name: basename(projectDirectory),
        path: projectDirectory,
        kind: "workspace",
      })};
      localStorage.setItem("suocode.mounted-projects", JSON.stringify([project]));
      localStorage.setItem("suocode.active-project", project.path);
      location.reload();
      return true;
    })()`);
    await client.waitFor(
      `Boolean(document.querySelector('textarea[aria-label="发送消息给 SuoCode"]')) && [...document.querySelectorAll(".project-row span")].some((item) => item.textContent === ${JSON.stringify(basename(projectDirectory))}) && Boolean(document.querySelector(".conversation-header"))`,
      "The packaged app could not create a project session through IPC.",
      45_000,
    );
    const projectState = await client.evaluate(`({
      status: document.querySelector(".workspace-status")?.textContent || "",
      session: document.querySelector(".conversation-title")?.textContent || "",
      projects: [...document.querySelectorAll(".project-row span")].map((item) => item.textContent || ""),
      headerBorder: getComputedStyle(document.querySelector(".conversation-header")).borderBottomWidth,
      inspectorTitle: document.querySelector(".inspector-header")?.textContent || "",
      filePreview: Boolean(document.querySelector(".file-preview"))
    })`);
    assert.match(projectState.status, new RegExp(basename(projectDirectory)));
    assert.ok(projectState.session.length > 0);
    assert.deepEqual(projectState.projects, ["Home", basename(projectDirectory)]);
    assert.equal(projectState.headerBorder, "0px");
    assert.doesNotMatch(projectState.inspectorTitle, /项目作业/);
    assert.equal(projectState.filePreview, false);
    await client.evaluate(`document.querySelector('button[aria-label="展开作业栏"]')?.click()`);
    await clickInspector(client, "文件");
    await client.waitFor(
      `[...document.querySelectorAll(".file-tree-node > button")].some((item) => item.textContent.includes("lazy-folder"))`,
      "The file tree did not render the project root entries.",
    );
    const lazyBeforeExpand = await client.evaluate(`({
      folder: [...document.querySelectorAll(".file-tree-node > button")].some((item) => item.textContent.includes("lazy-folder")),
      child: [...document.querySelectorAll(".file-leaf")].some((item) => item.textContent.includes("lazy-child.txt"))
    })`);
    assert.equal(lazyBeforeExpand.folder, true);
    assert.equal(lazyBeforeExpand.child, false);
    await client.evaluate(`[...document.querySelectorAll(".file-tree-node > button")].find((item) => item.textContent.includes("lazy-folder"))?.click()`);
    await client.waitFor(
      `[...document.querySelectorAll(".file-leaf")].some((item) => item.textContent.includes("lazy-child.txt"))`,
      "The file tree did not load an expanded folder on demand.",
    );
    const draggedPaths = await client.evaluate(`(async () => {
      const folder = [...document.querySelectorAll(".file-tree-node > button")].find((item) => item.textContent.includes("lazy-folder"));
      const file = [...document.querySelectorAll(".file-leaf")].find((item) => item.textContent.includes("lazy-child.txt"));
      const conversation = document.querySelector(".conversation-pane");
      if (!folder || !file || !conversation) return null;
      for (const source of [folder, file]) {
        const transfer = new DataTransfer();
        source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
        conversation.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }));
        conversation.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        conversation.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      }
      const editor = document.querySelector('[aria-label="发送消息给 SuoCode"]');
      return {
        value: editor?.value || "",
        overlay: document.querySelector(".conversation-pane")?.classList.contains("file-drag-active") ?? true,
      };
    })()`);
    assert.match(draggedPaths?.value ?? "", /'\/[^']+\/lazy-folder'/);
    assert.match(draggedPaths?.value ?? "", /'\/[^']+\/lazy-folder\/lazy-child\.txt'/);
    assert.equal(draggedPaths?.overlay, false);
    await client.evaluate(`(() => {
      const editor = document.querySelector('textarea[aria-label="发送消息给 SuoCode"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, "");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await client.evaluate(`[...document.querySelectorAll(".file-leaf")].find((item) => item.textContent.includes("lazy-child.txt"))?.click()`);
    const previewPage = await waitForPreviewPage(port);
    const previewClient = new DevToolsClient(previewPage.webSocketDebuggerUrl);
    await previewClient.open();
    await previewClient.waitFor(
      `document.querySelector(".text-preview")?.textContent.includes("lazy")`,
      "The text preview window did not render the selected file.",
    );
    const previewLayout = await previewClient.evaluate(`(() => {
      const content = document.querySelector(".preview-window-content")?.getBoundingClientRect();
      const footer = document.querySelector(".preview-window-status")?.getBoundingClientRect();
      return { contentBottom: content?.bottom ?? 0, footerTop: footer?.top ?? 0, footerBottom: footer?.bottom ?? 0, viewport: window.innerHeight };
    })()`);
    assert.ok(Math.abs(previewLayout.contentBottom - previewLayout.footerTop) <= 1);
    assert.ok(Math.abs(previewLayout.footerBottom - previewLayout.viewport) <= 1);
    await writeFile(join(projectDirectory, "lazy-folder", "lazy-child.txt"), "live preview update\n", "utf8");
    await previewClient.waitFor(
      `document.querySelector(".text-preview")?.textContent.includes("live preview update")`,
      "The preview window did not update after the file changed on disk.",
    );
    previewClient.close();
    await client.evaluate(`document.querySelector('button[aria-label="收起右侧栏"]')?.click()`);

    if (live) {
      await client.evaluate(`(() => {
        window.__suocodeSmokeEvents = [];
        window.__suocodeSmokeUnsubscribe?.();
        window.__suocodeSmokeUnsubscribe = window.suocode.onRuntimeEvent((event) => {
          window.__suocodeSmokeEvents.push({
            type: event.type,
            field: event.type === "message_delta" ? event.field : undefined,
            running: event.type === "run_state" ? event.running : undefined,
            toolName: event.type === "tool_started" || event.type === "tool_finished" ? event.tool.name : undefined,
            toolOutput: event.type === "tool_finished" ? event.tool.output : undefined,
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
        "todo",
      );
      const historyEditInteraction = await client.evaluate(`(async () => {
        const bubble = document.querySelector(".user-bubble-button");
        if (!bubble) return { error: "missing bubble" };
        bubble.click();
        await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
        const editor = document.querySelector(".user-message-editor");
        if (!editor) return { error: "missing editor" };
        const edited = editor.value + " 已编辑";
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, edited);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
        const warning = document.querySelector(".history-edit-warning")?.textContent || "";
        document.querySelector(".conversation-header")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
        const retainedBubble = document.querySelector(".user-bubble-button");
        const retained = retainedBubble?.dataset.promptValue || "";
        document.querySelector(".user-bubble-button")?.click();
        await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
        document.querySelector(".user-message-editor")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
        const dialog = document.querySelector(".rewind-dialog")?.textContent || "";
        [...document.querySelectorAll(".rewind-dialog button")].find((button) => button.textContent === "取消")?.click();
        await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
        return { warning, retained, edited, dialog, editorAfterCancel: Boolean(document.querySelector(".user-message-editor")) };
      })()`);
      assert.match(historyEditInteraction.warning, /提示缓存命中率/);
      assert.equal(historyEditInteraction.retained, historyEditInteraction.edited);
      assert.match(historyEditInteraction.dialog, /工作区中已经产生的文件修改不会被恢复/);
      assert.equal(historyEditInteraction.editorAfterCancel, true);
      await client.evaluate(`document.querySelector(".conversation-header")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
      await submitPrompt(
        client,
        `You must call the write tool before replying. Create ${fileName} in the current project with exactly this content: ${fileToken}. Do not use bash or edit. Then reply exactly ${fileToken}.`,
        "write",
      );
      await submitPrompt(
        client,
        `You must execute a shell tool before replying. Run exactly: printf ${terminalToken}. Then reply exactly ${terminalToken}.`,
        "bash",
      );

      await client.evaluate(`document.querySelector('button[aria-label="刷新项目"]')?.click()`);

      const toolState = await client.evaluate(`({
        count: document.querySelectorAll(".tool-activity-row").length,
        failed: document.querySelectorAll(".tool-activity-row.failed").length
      })`);
      assert.ok(toolState.count >= 1, "The GUI did not render any tool activity details.");
      assert.equal(toolState.failed, 0);

      const eventState = await client.evaluate(`window.__suocodeSmokeEvents`);
      const eventTypes = new Set(eventState.map((event) => event.type));
      const toolNames = new Set(eventState.map((event) => event.toolName).filter(Boolean));
      for (const eventType of ["message_delta", "tool_started", "tool_finished", "plan_updated", "project_updated", "metrics_updated", "run_state"]) {
        assert.equal(eventTypes.has(eventType), true, `Missing streamed runtime event: ${eventType}`);
      }
      assert.equal(eventState.some((event) => event.type === "message_delta" && event.field === "text"), true);
      assert.equal(eventState.some((event) => event.type === "run_state" && event.running === true), true);
      assert.equal(eventState.some((event) => event.type === "run_state" && event.running === false), true);
      assert.equal(toolNames.has("todo"), true, "The live Agent did not emit the todo tool lifecycle.");
      assert.equal(toolNames.has("write"), true, "The live Agent did not emit the write tool lifecycle.");
      assert.equal([...toolNames].some((name) => name === "bash" || name.startsWith("terminal")), true, "The live Agent did not emit a terminal tool lifecycle.");
      assert.equal(eventState.some((event) => event.toolName === "bash" && event.toolOutput?.includes(terminalToken)), true, "The terminal tool did not return the expected output.");

      await clickInspector(client, "文件");
      await client.waitFor(
        `[...document.querySelectorAll(".file-leaf")].some((item) => item.textContent.includes(${JSON.stringify(fileName)}))`,
        "The Agent-written file was not projected into Files.",
      );
      assert.equal(await client.evaluate(`Boolean(document.querySelector(".file-preview"))`), false);
      assert.equal((await readFile(join(projectDirectory, fileName), "utf8")).trim(), fileToken);

      await client.send("Page.reload", { ignoreCache: true });
      await client.waitFor(
        `document.querySelectorAll(".user-bubble-button").length >= 3 && document.querySelector(".timeline")?.textContent.includes(${JSON.stringify(terminalToken)})`,
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
    await rm(concurrentDirectoryA, { recursive: true, force: true });
    await rm(concurrentDirectoryB, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
