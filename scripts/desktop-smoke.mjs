import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");
const appBinary = join(
  repositoryRoot,
  "apps/desktop/release/mac-arm64/CoilCoil.app/Contents/MacOS/CoilCoil",
);

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function descendantPids(rootPid) {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parentPid]) => Number.isInteger(pid) && Number.isInteger(parentPid));
  const descendants = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of rows) {
      if (pid === rootPid || descendants.has(pid)) continue;
      if (parentPid === rootPid || descendants.has(parentPid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return descendants;
}

function runtimeProcessPids(rootPid) {
  return [...descendantPids(rootPid)].filter((pid) => {
    try {
      const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      return /(?:app\.asar\/)?out\/main\/runtime\.js/.test(command);
    } catch {
      return false;
    }
  });
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

async function startModelFixture() {
  const server = createHttpServer((request, response) => {
    const path = (request.url ?? "").split("?", 1)[0];
    if (request.method !== "GET" || (path !== "/models" && path !== "/v1/models")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      data: [
        { id: "desktop-smoke-id-model" },
        { id: "desktop-smoke-display-model", name: "Desktop Smoke 可读名称" },
      ],
    }));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) throw new Error("Unable to start the model catalog fixture.");
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

async function waitForPage(port, timeout = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === "page" && item.title === "CoilCoil");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron may still be starting.
    }
    await delay(100);
  }
  throw new Error("Packaged CoilCoil did not expose its renderer in time.");
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
    let response;
    try {
      response = await this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
    } catch (error) {
      const summary = expression.replaceAll(/\s+/g, " ").trim().slice(0, 220);
      throw new Error(`${error.message} while evaluating: ${summary}`, { cause: error });
    }
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
  return client.evaluate(`(async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const button = [...document.querySelectorAll(".inspector-nav button")]
        .find((item) => item.textContent.includes(${JSON.stringify(label)}));
      if (button) {
        button.click();
        return true;
      }
      const quick = [...document.querySelectorAll(".inspector-empty-actions button")]
        .find((item) => item.textContent.includes(${JSON.stringify(label)}));
      if (quick) {
        quick.click();
        return true;
      }
      const add = document.querySelector(".inspector-add-tab");
      if (!add || add.disabled) return false;
      add.click();
      await new Promise((resolveWait) => requestAnimationFrame(resolveWait));
      const option = [...document.querySelectorAll(".inspector-add-popover button")]
        .find((item) => item.textContent.includes(${JSON.stringify(label)}));
      if (option && !option.disabled) {
        option.click();
        return true;
      }
    }
    return false;
  })()`);
}

async function dismissFirstRunSettings(client, required) {
  if (!required) return;
  await client.waitFor(`Boolean(document.querySelector('.settings-screen'))`, "The first-run settings screen did not appear after reload.", 45_000);
  await client.evaluate(`document.querySelector('.settings-screen button[aria-label="返回工作区"]')?.click()`);
  await client.waitFor(`Boolean(document.querySelector('.conversation-pane'))`, "The workspace did not return after closing first-run settings.", 10_000);
}

async function fillComposer(client, prompt) {
  const filled = await client.evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="发送消息给 CoilCoil"]');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("keyup", { bubbles: true }));
    return true;
  })()`);
  assert.equal(filled, true);
  await delay(75);
}

async function fillAndSubmitComposer(client, prompt) {
  await fillComposer(client, prompt);
  return client.evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="发送消息给 CoilCoil"]');
    const form = input?.closest("form");
    if (!form) return false;
    form.requestSubmit();
    return true;
  })()`);
}

async function submitPrompt(client, prompt, expectedTool, timeout = 120_000) {
  const eventStart = await client.evaluate(`window.__coilcoilSmokeEvents?.length ?? 0`);
  const submitted = await fillAndSubmitComposer(client, prompt);
  assert.equal(submitted, true);
  try {
    await client.waitFor(
      `window.__coilcoilSmokeEvents?.slice(${eventStart}).some((event) => event.type === "tool_finished" && event.toolName === ${JSON.stringify(expectedTool)}) && window.__coilcoilSmokeEvents?.slice(${eventStart}).some((event) => event.type === "run_state" && event.running === false)`,
      `The packaged GUI did not complete the expected ${expectedTool} tool run.`,
      timeout,
    );
  } catch (error) {
    const diagnostics = await client.evaluate(`({
      events: window.__coilcoilSmokeEvents?.slice(${eventStart}) ?? [],
      conversation: document.querySelector(".conversation-scroll")?.textContent ?? "",
    })`).catch(() => undefined);
    throw new Error(`${error.message}\nDesktop live diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`);
  }
  await client.waitFor(
    `!document.querySelector(".agent-activity")`,
    `The Agent run for ${expectedTool} did not settle.`,
    30_000,
  );
}

async function submitPromptWithScrollPause(client, prompt, expectedTool, timeout = 120_000) {
  const eventStart = await client.evaluate(`window.__coilcoilSmokeEvents?.length ?? 0`);
  assert.equal(await fillAndSubmitComposer(client, prompt), true);
  await client.waitFor(`Boolean(document.querySelector(".agent-activity"))`, "The Agent did not enter a streaming state.");
  const pausedAt = await client.evaluate(`(() => {
    const body = document.querySelector(".conversation-body");
    const timeline = document.querySelector(".timeline");
    timeline.style.paddingTop = "1200px";
    body.scrollTop = body.scrollHeight;
    body.dispatchEvent(new Event("scroll", { bubbles: true }));
    body.scrollTop = Math.max(0, body.scrollTop - 120);
    body.dispatchEvent(new Event("scroll", { bubbles: true }));
    return body.scrollTop;
  })()`);
  await delay(1_200);
  const stayedAt = await client.evaluate(`document.querySelector(".conversation-body")?.scrollTop ?? -1`);
  assert.ok(Math.abs(stayedAt - pausedAt) <= 3, `Streaming forced the conversation from ${pausedAt}px to ${stayedAt}px after the user scrolled up.`);
  await client.evaluate(`(() => {
    const body = document.querySelector(".conversation-body");
    const timeline = document.querySelector(".timeline");
    timeline.style.paddingTop = "";
    body.scrollTop = body.scrollHeight;
    body.dispatchEvent(new Event("scroll", { bubbles: true }));
  })()`);
  await client.waitFor(
    `window.__coilcoilSmokeEvents?.slice(${eventStart}).some((event) => event.type === "tool_finished" && event.toolName === ${JSON.stringify(expectedTool)}) && window.__coilcoilSmokeEvents?.slice(${eventStart}).some((event) => event.type === "run_state" && event.running === false)`,
    `The packaged GUI did not complete the expected ${expectedTool} tool run.`,
    timeout,
  );
  await client.waitFor(`!document.querySelector(".agent-activity")`, `The Agent run for ${expectedTool} did not settle.`, 30_000);
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

function restoreFixtureEntries(snapshot, token) {
  const timestamp = new Date().toISOString();
  const toolId = `desktop-restore-tool-${token}`;
  const userId = `desktop-restore-user-${token}`;
  const callId = `desktop-restore-call-${token}`;
  const resultId = `desktop-restore-result-${token}`;
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  return [
    { type: "session", version: 3, id: snapshot.session.id, timestamp, cwd: snapshot.session.cwd },
    {
      type: "message",
      id: userId,
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [
          { type: "text", text: `会话恢复投影测试 ${token}` },
          { type: "image", mimeType: "image/png", data: pixel },
        ],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: callId,
      parentId: userId,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolId, name: "read", arguments: { path: "README.md" } }],
        api: "openai-responses",
        provider: "smoke",
        model: "smoke",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: resultId,
      parentId: callId,
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: toolId,
        toolName: "read",
        content: [{ type: "text", text: token }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: `desktop-provider-error-${token}`,
      parentId: resultId,
      timestamp,
      message: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "smoke",
        model: "smoke",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        errorMessage: `Connection error. ${token}`,
        timestamp: Date.now(),
      },
    },
  ];
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("The current packaged desktop smoke test targets the macOS app bundle.");
  }

  const dataDirectory = await mkdtemp(join(tmpdir(), "coilcoil-desktop-data-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "coilcoil-desktop-project-"));
  const concurrentDirectoryA = await mkdtemp(join(tmpdir(), "coilcoil-concurrent-a-"));
  const concurrentDirectoryB = await mkdtemp(join(tmpdir(), "coilcoil-concurrent-b-"));
  const modelFixture = await startModelFixture();
  execFileSync("git", ["init", "--quiet", projectDirectory]);
  await mkdir(join(projectDirectory, "lazy-folder"));
  await writeFile(join(projectDirectory, "lazy-folder", "lazy-child.txt"), "lazy\n", "utf8");
  await writeFile(join(projectDirectory, "unknown-format.coilcoil-smoke"), "unknown\n", "utf8");
  const port = await freePort();
  const logs = [];
  const child = spawn(appBinary, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dataDirectory}`,
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      ...(live ? { COILCOIL_LEGACY_AGENT_DIR: join(homedir(), ".pi", "agent") } : {}),
    },
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
      `document.readyState === "complete" && typeof window.coilcoil === "object"`,
      "The renderer or preload bridge did not become ready.",
    );
    await client.waitFor(
      `document.querySelector(".project-name")?.textContent === "Home" && Boolean(document.querySelector('textarea[aria-label="发送消息给 CoilCoil"]'))`,
      "The desktop app did not initialize its private Home workspace.",
      45_000,
    );
    const hasConfiguredProvider = await client.evaluate(`(async () => {
      const configuration = await window.coilcoil.request({ type: "get_configuration" });
      return configuration.configuredProviders.length > 0;
    })()`);
    if (!hasConfiguredProvider) {
      await client.waitFor(`Boolean(document.querySelector('button[aria-label="返回工作区"]'))`, "The first-run model settings screen did not open.");
      await client.evaluate(`document.querySelector('button[aria-label="返回工作区"]')?.click()`);
      await client.waitFor(`Boolean(document.querySelector('.conversation-pane'))`, "The workspace did not return after closing first-run settings.", 10_000);
    }
    const homeState = await client.evaluate(`(async () => {
      const home = await window.coilcoil.homeProject();
      return {
        home,
        projectName: document.querySelector(".project-name")?.textContent || "",
        status: document.querySelector(".workspace-status")?.textContent || "",
      };
    })()`);
    assert.equal(homeState.home.name, "Home");
    assert.equal(homeState.home.kind, "home");
    assert.match(homeState.home.path, /\/Home$/);
    assert.equal(homeState.projectName, "Home");
    assert.match(homeState.status, /Home/);
    const fixedNavSizing = await client.evaluate(`([...document.querySelectorAll(".primary-nav .nav-button")].map((button) => ({
      label: button.querySelector("span")?.textContent || "",
      height: button.getBoundingClientRect().height,
      fontSize: getComputedStyle(button).fontSize,
      iconWidth: button.querySelector("svg")?.getBoundingClientRect().width ?? 0,
    })))`);
    assert.deepEqual(fixedNavSizing, [
      { label: "新建对话", height: 34, fontSize: "13px", iconWidth: 16 },
      { label: "技能", height: 34, fontSize: "13px", iconWidth: 16 },
      { label: "记忆", height: 34, fontSize: "13px", iconWidth: 16 },
    ]);
    // The inspector starts empty and every surface is a tab you open: the old
    // primary-nav 终端 button is gone, and no runtime tab exists up front.
    const openInspectorTab = async (label, ready) => {
      const quoted = JSON.stringify(label);
      if (!(await client.evaluate(`Boolean(document.querySelector(".inspector-pane"))`))) {
        await client.evaluate(`document.querySelector('button[aria-label="展开作业栏"]')?.click()`);
        await client.waitFor(`Boolean(document.querySelector(".inspector-pane"))`, "Inspector did not open.");
      }
      // Either the empty state offers it directly, or it lives behind the + menu.
      await client.evaluate(
        "(() => { const label = " + quoted + ";"
        + " const empty = [...document.querySelectorAll('.inspector-empty-actions button')]"
        + "   .find((button) => button.textContent.includes(label));"
        + " if (empty) return empty.click();"
        + " document.querySelector('.inspector-add-tab')?.click(); })()",
      );
      await client.evaluate(
        "(() => { const label = " + quoted + ";"
        + " [...document.querySelectorAll('.inspector-add-popover button')]"
        + "   .find((button) => button.textContent.includes(label) && !button.disabled)?.click(); })()",
      );
      await client.waitFor(ready, `The ${label} tab did not open.`, 20_000);
    };
    await openInspectorTab("终端", `Boolean(document.querySelector(".terminal-panel"))`);
    // The terminal is a live xterm surface now, not a command box: type into its
    // helper textarea and read the rendered rows back.
    await client.waitFor(`Boolean(document.querySelector(".terminal-panel .xterm-helper-textarea"))`, "The terminal surface did not mount.", 20_000);
    await client.evaluate(`document.querySelector('.terminal-panel .xterm-helper-textarea')?.focus()`);
    // The echoed command must not itself contain the asserted string, or the echo
    // alone would satisfy the wait without the PTY ever running anything.
    await client.send("Input.insertText", { text: "printf 'gui-smoke-%s\\n' ok" });
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...enter });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
    await client.waitFor(`document.querySelector(".terminal-panel .xterm-rows")?.textContent.includes("gui-smoke-ok")`, "The terminal did not execute input through the packaged PTY.", 20_000);
    await client.evaluate(`document.querySelector('.inspector-tab.active .inspector-tab-close')?.click()`);
    await client.waitFor(`!document.querySelector(".terminal-panel")`, "Closing the terminal did not release its session.");
    // Closing the last tab leaves the pane open on its empty state; the checks
    // further down describe a collapsed work bar, so put it back.
    await client.evaluate(`document.querySelector('button[aria-label="收起右侧栏"]')?.click()`);
    await client.waitFor(`document.querySelector(".app-shell")?.classList.contains("right-collapsed") === true`, "The work bar did not collapse again.");
    const globalScrollbar = await client.evaluate(`(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:-100px;top:-100px;width:40px;height:40px;overflow:scroll";
      probe.innerHTML = '<div style="width:120px;height:120px"></div>';
      document.body.append(probe);
      const bar = getComputedStyle(probe, "::-webkit-scrollbar");
      const thumb = getComputedStyle(probe, "::-webkit-scrollbar-thumb");
      const result = {
        width: bar.width,
        height: bar.height,
        thumb: thumb.backgroundColor,
        radius: thumb.borderRadius,
      };
      probe.remove();
      return result;
    })()`);
    assert.equal(globalScrollbar.width, "6px");
    assert.equal(globalScrollbar.height, "6px");
    // 钉死某个透明度会随设计一起过期（#26 把三态整体调淡之后这里就红了半天）。
    // 要守的是「滑块是淡的、不是实心块」这条性质。
    const thumbAlpha = Number(/rgba\([^)]*,\s*([0-9.]+)\)/.exec(globalScrollbar.thumb)?.[1] ?? "1");
    assert.ok(thumbAlpha > 0 && thumbAlpha <= 0.35, `滚动条滑块该是淡的：${globalScrollbar.thumb}`);
    assert.equal(globalScrollbar.radius, "999px");
    if (process.platform === "darwin") {
      const nodeRuntimeLauncher = join(dirname(homeState.home.path), "agent", "runtime-bin", "node");
      const expectedHelper = join(
        repositoryRoot,
        "apps/desktop/release/mac-arm64/CoilCoil.app/Contents/Frameworks/CoilCoil Helper.app/Contents/MacOS/CoilCoil Helper",
      );
      assert.equal((await lstat(nodeRuntimeLauncher)).isSymbolicLink(), false, "The packaged worker launcher must not execute the Electron Helper through a generic node symlink.");
      const launcher = await readFile(nodeRuntimeLauncher, "utf8");
      assert.match(launcher, /^#!\/bin\/sh\n/);
      assert.match(launcher, /ELECTRON_RUN_AS_NODE=1/);
      assert.ok(launcher.includes(expectedHelper), "The packaged worker launcher did not target the background Helper bundle.");
      assert.equal(execFileSync(nodeRuntimeLauncher, ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }), expectedHelper);
      const dockProbes = Array.from({ length: 3 }, () => spawn(nodeRuntimeLauncher, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" }));
      await delay(750);
      for (const dockProbe of dockProbes) assert.equal(dockProbe.exitCode, null, "A packaged background worker launcher exited before the Dock probe.");
      const appRecords = execFileSync("/usr/bin/lsappinfo", ["list"], { encoding: "utf8" }).split(/(?=\s*\d+\)\s)/);
      for (const dockProbe of dockProbes) {
        const workerRecord = appRecords.find((record) => record.includes(`pid = ${dockProbe.pid} `));
        if (workerRecord) {
          assert.doesNotMatch(workerRecord, /^\s*\d+\)\s+"exec"/m, "A packaged worker appeared as a generic exec application.");
          assert.doesNotMatch(workerRecord, /type="Foreground"/, "A packaged worker registered as a foreground Dock application.");
        }
      }
      await Promise.all(dockProbes.map((dockProbe) => stopProcess(dockProbe)));
    }

    const skillSnapshot = await client.evaluate(`(async () => {
      const home = await window.coilcoil.homeProject();
      return window.coilcoil.request({ type: "get_skill_configuration", cwd: home.path });
    })()`);
    assert.equal(skillSnapshot.enableSkillCommands, true, "Skill commands should be enabled by default.");
    assert.ok(Array.isArray(skillSnapshot.skills), "get_skill_configuration did not return skills.");
    await fillComposer(client, "/");
    await client.waitFor(
      `Boolean(document.querySelector('.composer-activity [role="tab"][aria-selected="true"]')) || document.querySelector(".composer-activity-header strong")?.textContent === "命令" || Boolean(document.querySelector(".composer-command-list, .composer-command-empty"))`,
      "Typing / did not open the Activity command layer.",
      10_000,
    );
    const slashUi = await client.evaluate(`(() => ({
      draft: document.querySelector('textarea[aria-label="发送消息给 CoilCoil"]')?.value || "",
      commandsHeader: document.querySelector(".composer-activity-header strong")?.textContent || "",
      commandsTab: [...document.querySelectorAll('.composer-activity [role="tab"]')].some((tab) => tab.textContent.includes("命令") && tab.getAttribute("aria-selected") === "true"),
      commandRows: document.querySelectorAll(".composer-command-list button").length,
      empty: document.querySelector(".composer-command-empty")?.textContent || "",
    }))()`);
    assert.equal(slashUi.draft, "/", `Composer draft should stay at / after opening commands, got ${JSON.stringify(slashUi.draft)}`);
    assert.ok(
      slashUi.commandsTab || slashUi.commandsHeader === "命令" || slashUi.commandRows > 0 || slashUi.empty,
      `Activity command layer did not activate: ${JSON.stringify(slashUi)}`,
    );
    await fillComposer(client, "");

    const openedSettings = await client.evaluate(`(() => {
      const settings = document.querySelector('button[aria-label="设置"]');
      if (!settings) return false;
      settings.click();
      return true;
    })()`);
    assert.equal(openedSettings, true);
    await client.waitFor(`Boolean(document.querySelector(".settings-tabs"))`, "The settings dialog did not open.");
    assert.equal(await client.evaluate(`Boolean(document.querySelector(".settings-screen"))`), true, "Settings did not switch to the dedicated settings screen.");
    assert.equal(await client.evaluate(`Boolean(document.querySelector(".settings-screen")?.closest(".modal-backdrop"))`), false, "Settings is still rendered inside a modal backdrop.");
    await client.waitFor(`Boolean(document.querySelector(".model-provider-settings"))`, "The Pi model provider settings view did not render.");
    // 服务商这一栏早就不是一个下拉框了，是一份可搜索的目录（见 ModelSettings 的
    // provider-catalog）。这里跟着改，不然这套 smoke 会一直红着，把真的回归盖住。
    await client.waitFor(`Boolean(document.querySelector(".model-provider-settings .provider-catalog-group button")) || Boolean(document.querySelector(".model-provider-settings .settings-error"))`, "The Pi model provider settings did not finish loading.");
    const modelSettingsUi = await client.evaluate(`(() => ({
      nativeSelectCount: document.querySelectorAll(".model-provider-settings select").length,
      providerCount: document.querySelectorAll(".model-provider-settings .provider-catalog-group button").length,
      headerDrag: document.querySelector(".settings-page-header")?.classList.contains("window-drag") === true,
      customProviderButton: Boolean(document.querySelector('[aria-label="添加自定义服务商"]')),
      error: document.querySelector(".model-provider-settings .settings-error")?.textContent || "",
    }))()`);
    assert.equal(modelSettingsUi.nativeSelectCount, 0, "Model settings still uses a native select menu.");
    assert.ok(modelSettingsUi.providerCount >= 1, `Model settings did not render the provider catalog: ${modelSettingsUi.error}`);
    assert.equal(modelSettingsUi.headerDrag, true, "The settings page header did not preserve the macOS drag region.");
    assert.equal(modelSettingsUi.customProviderButton, true, "The model settings did not expose custom Pi provider creation.");
    const selectedNativeProvider = await client.evaluate(`(() => {
      const row = [...document.querySelectorAll(".provider-catalog-group button")]
        .find((button) => button.querySelector("small")?.textContent === "anthropic");
      if (!row) return false;
      row.click();
      return true;
    })()`);
    assert.equal(selectedNativeProvider, true, "The Pi Anthropic provider was not shown in the native provider catalog.");
    await client.waitFor(`Boolean(document.querySelector(".provider-native-summary"))`, "A native Pi provider still opened the custom-provider form.");
    const nativeProviderUi = await client.evaluate(`({
      protocolSelector: Boolean(document.querySelector('.model-provider-settings button[aria-label="请求协议"]')),
      baseUrlInput: Boolean(document.querySelector('input[placeholder="https://api.example.com/v1"]')),
      credentialInput: Boolean(document.querySelector('.provider-credential-editor input[type="password"]')),
    })`);
    assert.equal(nativeProviderUi.protocolSelector, false, "A native Pi provider must not prompt for a request protocol.");
    assert.equal(nativeProviderUi.baseUrlInput, false, "A native Pi provider must not prompt for a Base URL.");
    assert.equal(nativeProviderUi.credentialInput, true, "A native Pi provider did not expose its credential field.");
    const selectedAzureProvider = await client.evaluate(`(() => {
      const row = [...document.querySelectorAll(".provider-catalog-group button")].find((button) => button.textContent.includes("azure-openai-responses"));
      if (!row) return false;
      row.click();
      return true;
    })()`);
    assert.equal(selectedAzureProvider, true, "The Pi Azure OpenAI provider was not shown in the provider catalog.");
    await client.waitFor(`Boolean(document.querySelector('input[placeholder="https://your-resource.openai.azure.com"]'))`, "Azure OpenAI did not expose its Pi endpoint configuration.");
    const azureProviderUi = await client.evaluate(`(() => {
      const labels = [...document.querySelectorAll(".provider-credential-fields label")].map((label) => label.textContent);
      const advanced = document.querySelector(".provider-editor form > details.provider-advanced");
      const reference = advanced ? [...advanced.querySelectorAll("label")].find((label) => label.textContent.startsWith("密钥引用")) : null;
      return {
        hasEndpoint: labels.some((label) => label.includes("Azure 端点")),
        hasResource: labels.some((label) => label.includes("Azure 资源名")),
        advancedClosed: advanced instanceof HTMLDetailsElement && !advanced.open,
        referenceExists: Boolean(reference),
        referenceHidden: Boolean(reference) && !reference.checkVisibility(),
      };
    })()`);
    assert.equal(azureProviderUi.hasEndpoint, true, "Azure OpenAI endpoint was omitted from the native Pi form.");
    assert.equal(azureProviderUi.hasResource, true, "Azure OpenAI resource name was omitted from the native Pi form.");
    assert.equal(azureProviderUi.advancedClosed, true, "Provider advanced options must be collapsed by default.");
    assert.equal(azureProviderUi.referenceExists, true, "The key reference was not placed inside provider advanced options.");
    assert.equal(azureProviderUi.referenceHidden, true, "Key references must stay hidden under advanced options by default.");
    const openedCustomProvider = await client.evaluate(`(() => {
      const add = document.querySelector('[aria-label="添加自定义服务商"]');
      if (!add) return false;
      add.click();
      return true;
    })()`);
    assert.equal(openedCustomProvider, true, "The custom Pi provider creation action was unavailable.");
    await client.waitFor(`Boolean(document.querySelector('input[placeholder="例如 dog-provider"]'))`, "The custom Pi provider editor did not open.");
    const filledCustomProvider = await client.evaluate(`(() => {
      const setValue = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
      return setValue('input[placeholder="例如 dog-provider"]', "desktop-smoke-provider")
        && setValue('input[placeholder="例如 DogProvider"]', "Desktop Smoke Provider")
        && setValue('input[placeholder="https://api.example.com/v1"]', ${JSON.stringify(modelFixture.baseUrl)})
        && setValue('input[placeholder="例如 dog-coder-v1"]', "desktop-smoke-model");
    })()`);
    assert.equal(filledCustomProvider, true, "The custom Pi provider editor did not accept editable provider/model fields.");
    const savedCustomProvider = await client.evaluate(`(() => {
      const save = [...document.querySelectorAll('.provider-editor .primary-button')].find((button) => button.textContent.includes("保存服务商"));
      if (!save) return false;
      save.click();
      return true;
    })()`);
    assert.equal(savedCustomProvider, true, "The custom Pi provider save action was unavailable.");
    await client.waitFor(`(async () => {
      const snapshot = await window.coilcoil.request({ type: "get_model_provider_configuration" });
      return snapshot.providers.some((provider) => provider.id === "desktop-smoke-provider" && provider.models.some((model) => model.id === "desktop-smoke-model"));
    })()`, "The custom provider entered through the settings UI was not persisted in Pi models.json.");
    await client.waitFor(
      `document.querySelector('.provider-catalog-group button.active small')?.textContent === "desktop-smoke-provider" && !document.querySelector('.provider-editor .primary-button')?.disabled`,
      "The saved provider was not reloaded into the editor.",
    );
    await client.waitFor(`document.querySelector('.provider-catalog-group button.active em')?.textContent !== "未保存"`, "The saved provider remained marked as unsaved.");
    const editedProviderName = await client.evaluate(`(() => {
      const input = document.querySelector('input[placeholder="例如 DogProvider"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Desktop Smoke Provider Edited");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    assert.equal(editedProviderName, true, "The saved provider name could not be edited for dirty-state verification.");
    await client.waitFor(
      `document.querySelector('input[placeholder="例如 DogProvider"]')?.value === "Desktop Smoke Provider Edited"`,
      "React did not accept the edited provider name.",
    );
    await client.waitFor(
      `document.querySelector('.provider-catalog-group button.active em.unsaved')?.textContent === "未保存" && document.querySelector('.provider-unsaved-tag')?.textContent === "未保存"`,
      "Editing a provider did not expose its unsaved state in both navigation and editor.",
    );
    await client.evaluate(`(() => {
      const input = document.querySelector('input[placeholder="例如 DogProvider"]');
      if (!(input instanceof HTMLInputElement)) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Desktop Smoke Provider");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await client.waitFor(
      `!document.querySelector('.provider-catalog-group button.active em.unsaved') && !document.querySelector('.provider-unsaved-tag')`,
      "Reverting the provider form to its saved values did not clear the unsaved state.",
    );
    await client.waitFor(
      `(() => { const button = [...document.querySelectorAll('.model-provider-settings button')].find((item) => item.textContent.includes("拉取上游模型列表")); return Boolean(button && !button.disabled); })()`,
      "The upstream model picker action did not become ready after saving the provider.",
    );
    const openedUpstreamPicker = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('.model-provider-settings button')].find((item) => item.textContent.includes("拉取上游模型列表"));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(openedUpstreamPicker, true, "The upstream model picker action was unavailable.");
    await client.waitFor(`Boolean(document.querySelector('.upstream-model-picker'))`, "The upstream model picker did not open.", 15_000);
    const pickerStyle = await client.evaluate(`(() => {
      const picker = document.querySelector('.upstream-model-picker');
      const search = document.querySelector('.upstream-model-search');
      const input = document.querySelector('.upstream-model-search input');
      if (!(picker instanceof HTMLElement) || !(search instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return null;
      const searchStyle = getComputedStyle(search);
      const inputStyle = getComputedStyle(input);
      return {
        models: [...picker.querySelectorAll('.upstream-model-picker-list > label strong')].map((item) => item.textContent || ''),
        searchBorder: searchStyle.borderTopWidth,
        searchRadius: searchStyle.borderTopLeftRadius,
        // 圆角走的是主题里那把尺（--radius-xl），钉死像素值会在调尺子的时候假红。
        scaleRadius: getComputedStyle(document.documentElement).getPropertyValue("--radius-xl").trim(),
        searchHeight: searchStyle.height,
        inputBorder: inputStyle.borderTopWidth,
        inputFontSize: inputStyle.fontSize,
      };
    })()`);
    assert.ok(pickerStyle, "The upstream model picker search input did not render.");
    assert.equal(pickerStyle.searchBorder, "1px", "The portalled model picker search lost its styled border.");
    assert.equal(pickerStyle.searchRadius, pickerStyle.scaleRadius, "The portalled model picker search lost its rounded shape.");
    assert.equal(pickerStyle.inputBorder, "0px", "The model picker input fell back to a native border.");
    assert.equal(pickerStyle.inputFontSize, "11px", "The model picker input fell back to the browser default font size.");
    assert.ok(pickerStyle.models.includes("desktop-smoke-id-model"), "The upstream model id was not rendered.");
    assert.ok(pickerStyle.models.includes("Desktop Smoke 可读名称"), "The upstream model display name was not rendered.");
    const filteredById = await client.evaluate(`(() => {
      const input = document.querySelector('.upstream-model-search input');
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "id-model");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    assert.equal(filteredById, true);
    await client.waitFor(`document.querySelectorAll('.upstream-model-picker-list > label').length === 1`, "The upstream model picker did not filter by model id.");
    const filteredByName = await client.evaluate(`(() => {
      const input = document.querySelector('.upstream-model-search input');
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "可读名称");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    assert.equal(filteredByName, true);
    await client.waitFor(`document.querySelectorAll('.upstream-model-picker-list > label').length === 1`, "The upstream model picker did not filter by display name.");
    await client.evaluate(`document.querySelector('.upstream-model-picker [aria-label="关闭"]')?.click()`);
    const openedProtocolMenu = await client.evaluate(`(() => {
      const button = document.querySelector('.model-provider-settings button[aria-label="请求协议"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(openedProtocolMenu, true, "The custom Pi protocol selector did not open.");
    // 这个下拉是应用自己的控件（.coil-select-popover），不是原生 select；早先它叫
    // settings-select-popover，改名之后这套 smoke 没跟上。
    await client.waitFor(`Boolean(document.querySelector(".coil-select-popover"))`, "The in-app Pi protocol menu did not render.");
    await client.evaluate(`document.body.click()`);
    const openedMcpSettings = await client.evaluate(`(() => {
      const mcp = [...document.querySelectorAll(".settings-tabs button")].find((button) => button.textContent.includes("MCP"));
      if (!mcp) return false;
      mcp.click();
      return true;
    })()`);
    assert.equal(openedMcpSettings, true);
    await client.waitFor(`Boolean(document.querySelector(".mcp-settings"))`, "The MCP settings view did not open.");
    await client.waitFor(`!document.querySelector(".mcp-settings .settings-loading") && !document.querySelector(".mcp-add-button")?.disabled`, "The MCP settings did not finish loading.");
    assert.equal(await client.evaluate(`Boolean(document.querySelector(".mcp-editor-actions"))`), false, "The redundant MCP header actions were still rendered.");
    const startedMcpDraft = await client.evaluate(`(() => {
      const button = document.querySelector(".mcp-add-button");
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(startedMcpDraft, true);
    await client.waitFor(
      `document.querySelector(".mcp-editor-heading strong")?.textContent === "添加 MCP 服务器"`,
      "The MCP editor did not enter add-server mode.",
    );
    const savedMcpServer = await client.evaluate(`(async () => {
      const secret = "desktop-mcp-secret-do-not-display";
      const setInput = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const setTextarea = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const labels = [...document.querySelectorAll(".mcp-editor label")];
      const findLabel = (text) => labels.find((label) => label.textContent.startsWith(text));
      const name = findLabel("名称")?.querySelector("input");
      const command = findLabel("启动命令")?.querySelector("input");
      const idleTimeout = findLabel("空闲超时")?.querySelector("input");
      const requestTimeout = findLabel("请求超时")?.querySelector("input");
      const directTools = findLabel("直接注册的工具")?.querySelector("textarea");
      const excludeTools = findLabel("排除工具")?.querySelector("textarea");
      const environment = findLabel("环境变量 JSON")?.querySelector("textarea");
      const debug = findLabel("显示服务器调试输出")?.querySelector('input[type="checkbox"]');
      const exposeResources = findLabel("向 Agent 暴露资源")?.querySelector('input[type="checkbox"]');
      if (!name || !command || !idleTimeout || !requestTimeout || !directTools || !excludeTools || !environment || !debug || !exposeResources) return false;
      setInput(name, "desktop-smoke-mcp");
      setInput(command, "/usr/bin/true");
      setInput(idleTimeout, "3");
      setInput(requestTimeout, "4500");
      setTextarea(directTools, "ping");
      setTextarea(excludeTools, "dangerous");
      setTextarea(environment, JSON.stringify({ PRIVATE_TOKEN: secret }));
      debug.click();
      exposeResources.click();
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      return true;
    })()`);
    assert.equal(savedMcpServer, true);
    await client.waitFor(
      `(() => { const button = [...document.querySelectorAll(".mcp-editor .primary-button")].find((item) => item.textContent.includes("保存 MCP")); return Boolean(button && !button.disabled); })()`,
      "The MCP editor did not accept the server fields.",
    );
    await client.evaluate(`document.querySelector(".mcp-editor form")?.requestSubmit()`);
    try {
      await client.waitFor(
        `[...document.querySelectorAll(".mcp-server-list strong")].some((item) => item.textContent === "desktop-smoke-mcp") || Boolean(document.querySelector(".mcp-editor .settings-error"))`,
        "The MCP settings save did not settle.",
      );
    } catch (error) {
      const diagnostic = await client.evaluate(`(async () => ({
        names: [...document.querySelectorAll(".mcp-server-list strong")].map((item) => item.textContent || ""),
        error: document.querySelector(".mcp-editor .settings-error")?.textContent || "",
        button: document.querySelector(".mcp-editor .primary-button")?.textContent || "",
        disabled: document.querySelector(".mcp-editor .primary-button")?.disabled ?? null,
        draftName: [...document.querySelectorAll(".mcp-editor label")].find((label) => label.textContent.startsWith("名称"))?.querySelector("input")?.value || "",
        runtime: (await window.coilcoil.request({ type: "get_mcp_configuration" })).servers.map((server) => server.name)
      }))()`);
      throw new Error(`${error instanceof Error ? error.message : String(error)} ${JSON.stringify(diagnostic)}`);
    }
    await client.waitFor(
      `[...document.querySelectorAll(".mcp-editor label")].find((label) => label.textContent.startsWith("环境变量 JSON"))?.querySelector("textarea")?.value.includes("••••••")`,
      "The MCP editor did not finish replacing the saved sensitive value with its mask.",
    );
    const mcpUiSaveState = await client.evaluate(`({
      saved: [...document.querySelectorAll(".mcp-server-list strong")].some((item) => item.textContent === "desktop-smoke-mcp"),
      error: document.querySelector(".mcp-editor .settings-error")?.textContent || "",
      environment: [...document.querySelectorAll(".mcp-editor label")].find((label) => label.textContent.startsWith("环境变量 JSON"))?.querySelector("textarea")?.value || ""
    })`);
    assert.equal(mcpUiSaveState.saved, true, `The MCP server saved through the desktop settings did not appear: ${mcpUiSaveState.error}`);
    assert.ok(mcpUiSaveState.environment.includes("••••••"), "The MCP editor did not mask a sensitive environment value.");
    assert.ok(!mcpUiSaveState.environment.includes("desktop-mcp-secret-do-not-display"), "The MCP editor exposed a sensitive environment value after saving.");
    const mcpSnapshot = await client.evaluate(`window.coilcoil.request({ type: "get_mcp_configuration" })`);
    const configuredMcp = mcpSnapshot.servers.find((server) => server.name === "desktop-smoke-mcp");
    assert.equal(configuredMcp?.command, "/usr/bin/true");
    assert.equal(configuredMcp?.scope, "global");
    assert.equal(configuredMcp?.idleTimeout, 3);
    assert.equal(configuredMcp?.requestTimeoutMs, 4500);
    assert.equal(configuredMcp?.directTools?.[0], "ping");
    assert.equal(configuredMcp?.excludeTools?.[0], "dangerous");
    assert.equal(configuredMcp?.exposeResources, false);
    assert.equal(configuredMcp?.debug, true);
    assert.equal(configuredMcp?.env?.PRIVATE_TOKEN, "desktop-mcp-secret-do-not-display");
    const newlySavedMcpNeedsEnable = await client.evaluate(`Boolean(document.querySelector('button[aria-label="启用 MCP 服务器"]'))`);
    if (newlySavedMcpNeedsEnable) {
      await client.evaluate(`document.querySelector('button[aria-label="启用 MCP 服务器"]')?.click()`);
      await client.waitFor(
        `Boolean(document.querySelector('button[aria-label="停用 MCP 服务器"]'))`,
        "The newly saved MCP server did not become enabled.",
      );
    }
    const disabledMcpServer = await client.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="停用 MCP 服务器"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(disabledMcpServer, true, "The MCP adapter-native disable action was not exposed in settings.");
    await client.waitFor(
      `(() => { const button = document.querySelector('button[aria-label="启用 MCP 服务器"]'); return Boolean(button && !button.disabled); })()`,
      "The MCP settings did not reflect the disabled project override.",
    );
    const disabledMcpSnapshot = await client.evaluate(`window.coilcoil.request({ type: "get_mcp_configuration", cwd: ${JSON.stringify(homeState.home.path)} })`);
    assert.equal(disabledMcpSnapshot.servers.find((server) => server.name === "desktop-smoke-mcp")?.disabled, true);
    const enabledMcpServer = await client.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="启用 MCP 服务器"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(enabledMcpServer, true, "The MCP adapter-native enable action was not exposed in settings.");
    await client.waitFor(
      `(() => { const button = document.querySelector('button[aria-label="停用 MCP 服务器"]'); return Boolean(button && !button.disabled); })()`,
      "The MCP settings did not clear the disabled project override.",
    );
    const enabledMcpSnapshot = await client.evaluate(`window.coilcoil.request({ type: "get_mcp_configuration", cwd: ${JSON.stringify(homeState.home.path)} })`);
    assert.equal(enabledMcpSnapshot.servers.find((server) => server.name === "desktop-smoke-mcp")?.disabled, false);
    const rejectedUnsafeExternalUrl = await client.evaluate(`window.coilcoil.openExternal("file:///tmp/coilcoil-smoke").then(() => false, () => true)`);
    assert.equal(rejectedUnsafeExternalUrl, true, "The desktop external URL bridge accepted a non-HTTP URL.");
    const addedProjectMcp = await client.evaluate(`(async () => {
      document.querySelector(".mcp-add-button")?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      const labels = [...document.querySelectorAll(".mcp-editor label")];
      const name = labels.find((label) => label.textContent.startsWith("名称"))?.querySelector("input");
      const command = labels.find((label) => label.textContent.startsWith("启动命令"))?.querySelector("input");
      // 作用域早就不是原生 select 了，是应用自己的下拉（Select 组件）：点开按钮、
      // 在弹层里点那一项。这套 smoke 别处还断言着「没有任何原生 select」，两边对上。
      const scope = document.querySelector('button[aria-label="MCP 作用域"]');
      if (!name || !command || !scope) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(name, "desktop-smoke-mcp-project");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(command, "/usr/bin/true");
      command.dispatchEvent(new Event("input", { bubbles: true }));
      scope.click();
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      const option = [...document.querySelectorAll('.coil-select-options button[role="option"]')]
        .find((item) => item.textContent?.includes("当前项目"));
      if (!option) return false;
      option.click();
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      document.querySelector(".mcp-editor form")?.requestSubmit();
      return true;
    })()`);
    assert.equal(addedProjectMcp, true);
    await client.waitFor(
      `[...document.querySelectorAll(".mcp-server-list strong")].some((item) => item.textContent === "desktop-smoke-mcp-project") || Boolean(document.querySelector(".mcp-editor .settings-error"))`,
      "The project MCP server did not settle.",
    );
    const projectMcpSnapshot = await client.evaluate(`window.coilcoil.request({ type: "get_mcp_configuration", cwd: ${JSON.stringify(homeState.home.path)} })`);
    const projectMcp = projectMcpSnapshot.servers.find((server) => server.name === "desktop-smoke-mcp-project");
    assert.equal(projectMcp?.scope, "project");
    assert.equal(projectMcp?.source, projectMcpSnapshot.projectConfigPath);
    await client.evaluate(`document.querySelectorAll(".toast-dismiss").forEach((button) => button.click())`);
    await client.evaluate(`(async () => {
      await window.coilcoil.request({ type: "remove_mcp_server", name: "desktop-smoke-mcp-project", scope: "project", cwd: ${JSON.stringify(homeState.home.path)} });
      await window.coilcoil.request({ type: "remove_mcp_server", name: "desktop-smoke-mcp", scope: "global", cwd: ${JSON.stringify(homeState.home.path)} });
    })()`);
    await client.evaluate(`document.querySelector('button[aria-label="返回工作区"]')?.click()`);

    const openedArchive = await client.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="归档会话"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(openedArchive, true);
    await client.waitFor(`Boolean(document.querySelector(".archive-dialog"))`, "The archive restore dialog did not open.");
    await client.waitFor(`document.querySelector(".archive-dialog")?.textContent.includes("暂无归档会话")`, "The empty archive state did not render.");
    // 提示语后来补了「（会读取全部项目）」。断言它是搜索框、而不是逐字复述文案。
    assert.match(
      await client.evaluate(`document.querySelector(".archive-search input")?.getAttribute("placeholder") ?? ""`),
      /搜索归档会话标题/,
    );
    await client.evaluate(`document.querySelector('button[aria-label="关闭归档会话"]')?.click()`);

    const expandedHomePath = await client.evaluate(`(async () => {
      document.querySelector(".workspace-path")?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return document.querySelector(".path-popover")?.textContent || "";
    })()`);
    assert.match(expandedHomePath, new RegExp(homeState.home.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const isolation = await client.evaluate(`({
      title: document.title,
      bridge: typeof window.coilcoil,
      nodeRequire: typeof window.require,
      nodeProcess: typeof window.process,
      panes: [".sidebar", ".conversation-pane", ".inspector-pane"].every((selector) => Boolean(document.querySelector(selector))),
      rightClosed: document.querySelector(".app-shell")?.classList.contains("right-collapsed"),
      leftResizer: Boolean(document.querySelector(".left-resizer")),
      rightResizer: Boolean(document.querySelector(".right-resizer")),
      inspector: document.querySelector(".inspector-nav")?.textContent || ""
    })`);
    assert.equal(isolation.title, "CoilCoil");
    assert.equal(isolation.bridge, "object");
    assert.equal(isolation.nodeRequire, "undefined");
    assert.equal(isolation.nodeProcess, "undefined");
    assert.equal(isolation.panes, true);
    assert.equal(isolation.rightClosed, true);
    assert.equal(isolation.rightResizer, false);
    assert.equal(isolation.inspector, "");
    // 文件 / 浏览器 / 运行时 / 终端 — the terminal surface became a tab of its own.
    assert.equal(await client.evaluate(`document.querySelectorAll(".inspector-empty-actions button").length`), 4);
    const emptyMetricState = await client.evaluate(`({
      summary: document.querySelector(".response-metrics")?.textContent || "",
      performance: Boolean(document.querySelector(".performance-trigger")),
      context: Boolean(document.querySelector(".context-trigger"))
    })`);
    assert.equal(emptyMetricState.summary, "");
    assert.equal(emptyMetricState.performance, false);
    assert.equal(emptyMetricState.context, true);
    assert.equal(await client.evaluate(`(() => { const button = document.querySelector(".agent-mode"); button?.click(); return Boolean(button); })()`), true, "The composer model parameter menu trigger was missing.");
    await client.waitFor(`Boolean(document.querySelector(".model-popover"))`, "The model menu did not open.");
    // 这个菜单有两种形态，取决于当前模型有没有可调的参数（思考级别、Fast）。冒烟用
    // 的那个假模型两样都没有，所以它就该直接是模型列表——「不给没有参数的模型摆一
    // 个空菜单」本来就是这块的设计意图。有参数时才是参数菜单 + 二级模型列表。
    const modelMenu = await client.evaluate(`(() => {
      const menu = document.querySelector(".model-popover");
      return {
        parameters: menu?.classList.contains("model-parameter-popover") ?? false,
        text: menu?.textContent || "",
        directSearch: Boolean(menu?.querySelector(".model-popover-search")),
        contextInput: Boolean(menu?.querySelector('input[type="number"]')),
        submenuTrigger: Boolean(menu?.querySelector(".model-submenu-trigger")),
      };
    })()`);
    assert.equal(modelMenu.contextInput, false, "The removed ad-hoc context input still appeared in the model menu.");
    if (modelMenu.parameters) {
      assert.match(modelMenu.text, /Thinking|思考/);
      assert.equal(modelMenu.directSearch, false, "The primary parameter menu still rendered the model list/search directly.");
      assert.equal(modelMenu.submenuTrigger, true);
      await client.evaluate(`document.querySelector(".model-submenu-trigger")?.click()`);
      await client.waitFor(`Boolean(document.querySelector('.model-submenu input[placeholder="搜索模型名称或 ID"]'))`, "The model list did not open as a secondary menu.");
    } else {
      assert.doesNotMatch(modelMenu.text, /Thinking/, "A model with no parameters still got a parameter section.");
      assert.doesNotMatch(modelMenu.text, /Fast/, "An unsupported model still consumed space with a disabled Fast control.");
      assert.equal(modelMenu.directSearch, true, "With no parameters to show, the menu must be the model list itself.");
    }
    await client.evaluate(`document.querySelector(".agent-mode")?.click()`);
    await client.waitFor(`!document.querySelector(".model-popover") && !document.querySelector(".model-submenu")`, "The model menu did not close.");
    // 拖动改成「标题栏里铺一层 .window-drag-layer，交互元素在它上面挖洞」之后
    // （#5），.inspector-drag-surface 不再自己是拖动区，它是那条永远不会被标签条吃
    // 掉的空带。所以这里验的是：拖动层在、真的可拖，空带还留着宽度。
    const inspectorDragSurface = await client.evaluate(`(() => {
      const header = document.querySelector(".inspector-header");
      const layer = header?.querySelector(".window-drag-layer");
      const spacer = document.querySelector(".inspector-drag-surface");
      if (!header || !layer || !spacer) return null;
      return {
        region: getComputedStyle(layer).webkitAppRegion,
        layerWidth: layer.getBoundingClientRect().width,
        spacerWidth: spacer.getBoundingClientRect().width,
      };
    })()`);
    assert.equal(inspectorDragSurface?.region, "drag", "右侧栏标题条没有可拖动的那一层。");
    assert.ok(inspectorDragSurface.layerWidth > 0, "拖动层没有铺开。");
    assert.ok(inspectorDragSurface.spacerWidth >= 40, `标签条把拖动空带吃没了：${inspectorDragSurface.spacerWidth}px`);
    const runtimeIsolation = await client.evaluate(`(async () => {
      const first = await window.coilcoil.request({ type: "create_session", cwd: ${JSON.stringify(concurrentDirectoryA)} });
      const second = await window.coilcoil.request({ type: "create_session", cwd: ${JSON.stringify(concurrentDirectoryB)} });
      return { first: first.runtimeId, second: second.runtimeId };
    })()`);
    assert.ok(runtimeIsolation.first);
    assert.ok(runtimeIsolation.second);
    assert.notEqual(runtimeIsolation.first, runtimeIsolation.second);
    await delay(150);
    assert.equal(
      runtimeProcessPids(child.pid).length,
      1,
      "Opening multiple conversations must keep exactly one desktop Runtime process.",
    );
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
        platform: window.coilcoil.platform,
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

    const panelWidths = `({
      width: window.innerWidth,
      sidebar: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      conversation: document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0
    })`;
    const panelWidthBeforeWindowResize = await client.evaluate(panelWidths);
    // 按当前宽度往里收，不要钉死一个像素值：窗口默认多宽取决于这台机器的屏幕，
    // 钉死 1000 的结果是在小屏上「收窄」反而把窗口放宽了，断言随之假红。
    const narrowed = Math.max(620, panelWidthBeforeWindowResize.width - 200);
    await client.evaluate(`(() => { window.resizeTo(${narrowed}, 700); return true; })()`);
    await client.waitFor(`window.innerWidth <= ${narrowed}`, "The window did not resize for the panel preservation test.");
    const panelWidthAfterWindowResize = await client.evaluate(panelWidths);
    // 侧栏宽度是用户拖出来的，窗口变窄不该动它；被挤的必须是中间的对话区。
    assert.equal(panelWidthAfterWindowResize.sidebar, panelWidthBeforeWindowResize.sidebar);
    assert.ok(
      panelWidthAfterWindowResize.conversation < panelWidthBeforeWindowResize.conversation,
      `窗口收窄后对话区没有跟着变窄：${JSON.stringify({ before: panelWidthBeforeWindowResize, after: panelWidthAfterWindowResize })}`,
    );

    await client.evaluate(`(() => { window.resizeTo(482, 700); return true; })()`);
    await client.waitFor(`window.innerWidth <= 700`, "The window did not reach its narrow desktop layout.");
    await client.evaluate(`(() => { window.resizeTo(482, 700); return true; })()`);
    await client.waitFor(
      `window.innerWidth <= 482`,
      "The packaged desktop window could not shrink to the 482px left-panel minimum.",
    );
    await client.waitFor(
      `document.querySelector(".sidebar")?.getBoundingClientRect().width <= 168`,
      "The conversation sidebar did not settle at its 167px minimum.",
    );
    const minimumSidebarLayout = await client.evaluate(`({
      left: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      center: document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0,
    })`);
    assert.ok(minimumSidebarLayout.left <= 168 && minimumSidebarLayout.left >= 166, `The conversation sidebar did not stop at 167px: ${JSON.stringify(minimumSidebarLayout)}`);
    assert.ok(minimumSidebarLayout.center <= 316 && minimumSidebarLayout.center >= 314, `The conversation pane lost its minimum width: ${JSON.stringify(minimumSidebarLayout)}`);
    await client.evaluate(`document.querySelectorAll(".toast-dismiss").forEach((button) => button.click())`);
    await client.evaluate(`(async () => {
      if (!document.querySelector(".app-shell")?.classList.contains("left-collapsed")) return true;
      document.querySelector('button[aria-label="展开侧栏"]')?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return true;
    })()`);
    const narrowSidebarClosed = await client.evaluate(`(async () => {
      const button = document.querySelector('button[aria-label="收起侧栏"]');
      if (!button) return { ok: false, reason: "missing-button" };
      const buttonBounds = button.getBoundingClientRect();
      if (buttonBounds.width !== 30 || buttonBounds.height !== 30) return { ok: false, reason: "size", width: buttonBounds.width, height: buttonBounds.height };
      if (getComputedStyle(button).webkitAppRegion !== "no-drag") return { ok: false, reason: "drag-region" };
      const hitPoints = [
        [buttonBounds.left + 5, buttonBounds.top + 5],
        [buttonBounds.right - 5, buttonBounds.top + 5],
        [buttonBounds.left + 5, buttonBounds.bottom - 5],
        [buttonBounds.right - 5, buttonBounds.bottom - 5],
        [buttonBounds.left + buttonBounds.width / 2, buttonBounds.top + buttonBounds.height / 2],
      ];
      for (const [x, y] of hitPoints) {
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest("button") !== button) return { ok: false, reason: "hit-target", x, y, hit: hit ? { tag: hit.tagName, className: String(hit.className) } : null };
        if (document.elementsFromPoint(x, y).some((element) => getComputedStyle(element).webkitAppRegion === "drag")) return { ok: false, reason: "hit-drag", x, y };
      }
      if (button.closest(".window-drag")) return { ok: false, reason: "drag-ancestor" };
      button.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return { ok: document.querySelector(".app-shell")?.classList.contains("left-collapsed") ?? false, reason: "click" };
    })()`);
    assert.equal(narrowSidebarClosed?.ok, true, JSON.stringify(narrowSidebarClosed));
    const narrowSidebarOpened = await client.evaluate(`(async () => {
      const button = document.querySelector('button[aria-label="展开侧栏"]');
      if (!button) return false;
      button.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return !document.querySelector(".app-shell")?.classList.contains("left-collapsed");
    })()`);
    assert.equal(narrowSidebarOpened, true);
    await client.evaluate(`window.resizeTo(522, 700)`);
    await client.waitFor(`window.innerWidth >= 522`, "The window did not make room for both panel minimums.");
    const narrowInspectorLayout = await client.evaluate(`(async () => {
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
    assert.equal(narrowInspectorLayout.shellTransition, "0s");
    assert.equal(narrowInspectorLayout.sidebarTransition, "0s");
    assert.notEqual(narrowInspectorLayout.inspectorPosition, "absolute");
    assert.ok(narrowInspectorLayout.conversationWidth >= 315);
    assert.ok(narrowInspectorLayout.inspectorWidth >= 40);
    assert.ok(narrowInspectorLayout.inspectorLeft >= narrowInspectorLayout.conversationRight - 1);
    assert.equal(narrowInspectorLayout.rightResizer, true);
    await client.evaluate(`(() => { window.resizeTo(1440, 900); return true; })()`);
    await client.waitFor(`window.innerWidth >= 1400`, "The window did not return to its regular test size.");
    const inspectorButtonInsets = await client.evaluate(`(async () => {
      const collapsedButton = document.querySelector('button[aria-label="展开作业栏"]');
      const conversationBounds = document.querySelector(".conversation-pane")?.getBoundingClientRect();
      const collapsedBounds = collapsedButton?.getBoundingClientRect();
      collapsedButton?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      const inspectorBounds = document.querySelector(".inspector-pane")?.getBoundingClientRect();
      const expandedBounds = document.querySelector('button[aria-label="收起右侧栏"]')?.getBoundingClientRect();
      return {
        collapsedTop: collapsedBounds && conversationBounds ? collapsedBounds.top - conversationBounds.top : -1,
        collapsedRight: collapsedBounds && conversationBounds ? conversationBounds.right - collapsedBounds.right : -1,
        expandedTop: expandedBounds && inspectorBounds ? expandedBounds.top - inspectorBounds.top : -1,
        expandedRight: expandedBounds && inspectorBounds ? inspectorBounds.right - expandedBounds.right : -1,
      };
    })()`);
    assert.ok(Math.abs(inspectorButtonInsets.collapsedTop - inspectorButtonInsets.expandedTop) <= 1, `Collapsed/expanded inspector top insets differ: ${JSON.stringify(inspectorButtonInsets)}`);
    assert.ok(Math.abs(inspectorButtonInsets.collapsedRight - inspectorButtonInsets.expandedRight) <= 1, `Collapsed/expanded inspector right insets differ: ${JSON.stringify(inspectorButtonInsets)}`);
    await client.waitFor(`Boolean(document.querySelector(".right-resizer"))`, "The right panel did not open for resize priority testing.");
    assert.equal(await clickInspector(client, "运行时"), true);
    const inspectorTabLayout = await client.evaluate(`(() => {
      const runtime = document.querySelector('.inspector-nav button[aria-label="运行时"]');
      const label = runtime?.querySelector("span");
      return {
        width: runtime?.getBoundingClientRect().width ?? 0,
        labelWidth: label?.getBoundingClientRect().width ?? 0,
        labelScrollWidth: label?.scrollWidth ?? Infinity,
        contextComposition: document.body.textContent.includes("上下文构成"),
      };
    })()`);
    assert.ok(inspectorTabLayout.width > 45, `The runtime inspector tab was clipped to ${inspectorTabLayout.width}px.`);
    assert.ok(inspectorTabLayout.labelWidth >= inspectorTabLayout.labelScrollWidth, "The runtime inspector label was ellipsized.");
    assert.equal(inspectorTabLayout.contextComposition, false, "The removed context-composition panel is still visible.");
    // 前面的最小宽度测试把窗口缩到 482px 了；浏览器这一段要在正常宽度下验，否则验
    // 的是「窄到极限时标签条怎么排」，那是另一回事。
    await client.evaluate(`(() => { window.resizeTo(1_100, 760); return true; })()`);
    await client.waitFor(`window.innerWidth >= 900`, "The window did not return to a normal width for the browser checks.");
    assert.equal(await clickInspector(client, "浏览器"), true);
    // 浏览器的标签页早就并进右侧栏顶上那一排了（#3，和终端一致），原来那条
    // .browser-tabs 独立标签条不复存在。这里验今天的样子：排里有一个浏览器标签，
    // 而且「打开面板」那个加号还在。
    try {
      await client.waitFor(
        `[...document.querySelectorAll(".inspector-tab-select")].some((tab) => tab.getAttribute("aria-label")?.includes("新标签页") || tab.getAttribute("aria-label")?.includes("about:blank") || tab.closest(".inspector-tab")?.querySelector("svg")) && Boolean(document.querySelector(".inspector-add-tab"))`,
        "The inspector tab strip did not render the browser tab and the add action.",
      );
    } catch (error) {
      // 标签条没出来时，光说「没出来」查不动。把主进程那边的状态一起打出来。
      const diagnosis = await client.evaluate(`(async () => ({
        tabs: [...document.querySelectorAll(".inspector-tab-select")].map((tab) => tab.getAttribute("aria-label")),
        guests: document.querySelectorAll(".browser-guest-layer webview").length,
        partitions: [...document.querySelectorAll(".browser-guest-layer webview")].map((guest) => guest.getAttribute("partition")),
        panel: Boolean(document.querySelector(".browser-panel")),
        toast: [...document.querySelectorAll(".toast")].map((item) => item.textContent).join(" | "),
      }))()`);
      process.stderr.write(`浏览器标签诊断：${JSON.stringify(diagnosis)}\n`);
      throw error;
    }

    // 每个工作区一份 cookie：guest 必须建在这个工作区自己那份 jar 里，而不是那个
    // 谁都能读的默认 jar。
    await client.waitFor(
      `document.querySelectorAll(".browser-guest-layer webview").length >= 1`,
      "浏览器面板打开了，却没有任何 guest。",
    );
    const guestJars = await client.evaluate(`[...document.querySelectorAll(".browser-guest-layer webview")].map((guest) => guest.getAttribute("partition"))`);
    for (const jar of guestJars) {
      assert.match(String(jar), /^persist:coilcoil-browser-[0-9a-f]{12}$/, `guest 落在了共用的 jar 里：${jar}`);
    }

    // The browser renders as a <webview> guest specifically so DOM overlays can
    // paint over it. A native view would composite above the renderer and there
    // is no per-view click-through, so a regression here is unfixable in CSS.
    await client.waitFor(
      `Boolean(document.querySelector(".browser-guest-layer > webview.visible"))`,
      "The browser guest never became visible in the guest layer.",
    );
    const guestPlacement = await client.evaluate(`(() => {
      const host = document.querySelector(".browser-native-host")?.getBoundingClientRect();
      const guest = document.querySelector(".browser-guest-layer > webview.visible")?.getBoundingClientRect();
      if (!host || !guest) return { matched: false };
      return {
        matched: true,
        dx: Math.abs(host.left - guest.left),
        dy: Math.abs(host.top - guest.top),
        dw: Math.abs(host.width - guest.width),
        dh: Math.abs(host.height - guest.height),
      };
    })()`);
    assert.equal(guestPlacement.matched, true, "The visible browser guest is not aligned to its panel host.");
    assert.ok(
      guestPlacement.dx <= 1 && guestPlacement.dy <= 1 && guestPlacement.dw <= 1 && guestPlacement.dh <= 1,
      `The visible browser guest does not fill its panel host: ${JSON.stringify(guestPlacement)}`,
    );

    const overlayOcclusion = await client.evaluate(`(() => {
      const guest = document.querySelector(".browser-guest-layer > webview.visible");
      const rect = guest?.getBoundingClientRect();
      if (!rect || rect.width < 20 || rect.height < 20) return { ran: false };
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const beneath = document.elementFromPoint(x, y)?.tagName ?? "";
      const overlay = document.createElement("div");
      overlay.className = "inspector-add-popover";
      overlay.style.cssText = "position:fixed;left:" + (x - 40) + "px;top:" + (y - 30) + "px;width:80px;height:60px;";
      document.body.appendChild(overlay);
      const hit = document.elementFromPoint(x, y);
      const above = hit === overlay || overlay.contains(hit);
      overlay.remove();
      return { ran: true, beneath, above };
    })()`);
    assert.equal(overlayOcclusion.ran, true, "The overlay occlusion probe could not find a visible browser guest.");
    assert.equal(overlayOcclusion.beneath, "WEBVIEW", "The browser guest is not the element under the panel centre.");
    assert.equal(overlayOcclusion.above, true, "A DOM overlay is occluded by the browser guest.");

    await client.evaluate(`document.querySelector('.inspector-nav button[aria-label="运行时"]')?.click()`);
    // Switching away must not destroy guests: agents keep driving them in the background.
    const guestsAfterSwitch = await client.evaluate(`(() => ({
      count: document.querySelectorAll(".browser-guest-layer > webview").length,
      layerDisplay: getComputedStyle(document.querySelector(".browser-guest-layer")).display,
    }))()`);
    assert.ok(guestsAfterSwitch.count >= 1, "Switching inspector tabs destroyed the browser guests.");
    assert.notEqual(guestsAfterSwitch.layerDisplay, "none", "The browser guest layer was hidden with display:none.");
    const preferredPanelWidths = await client.evaluate(`({
      left: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      right: document.querySelector(".inspector-pane")?.getBoundingClientRect().width ?? 0
    })`);
    // 面板开着的时候，应用会把窗口的最小宽度顶到「各面板最小宽度之和」（682px）：
    // 那是后加的设计——宁可把窗口撑宽，也不挤对话区。下面这段验的是「挤压顺序」，
    // 前提是右侧栏收起来，所以先收。
    await client.evaluate(`document.querySelector('button[aria-label="收起右侧栏"]')?.click()`);
    await client.waitFor(
      `document.querySelector(".app-shell")?.classList.contains("right-collapsed")`,
      "The inspector did not collapse before the panel priority checks.",
    );
    // 带着 webview guest 收窄窗口偶尔会漏掉一次（第一次调用落在一次布局中间），
    // 所以重试几轮，失败时把真实宽度说出来，而不是只说「没收窄」。
    let shrank = false;
    for (let attempt = 0; attempt < 5 && !shrank; attempt += 1) {
      await client.evaluate(`window.resizeTo(600, 700)`);
      await delay(400);
      shrank = await client.evaluate(`window.innerWidth <= 600`);
    }
    assert.ok(shrank, `窗口没有收窄到 600：${await client.evaluate(`window.innerWidth`)}px`);
    // 挤压顺序：先让中间的对话区吃掉，侧栏守着用户拖出来的宽度，收起的右侧栏是
    // 一条 1px 的轨。这几个数字跟着布局改过好几轮，所以这里验的是顺序和下限，不
    // 再逐像素复述某一版的排布。
    const compressedPanelWidths = await client.evaluate(`({
      left: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      center: document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0,
      right: document.querySelector(".inspector-pane")?.getBoundingClientRect().width ?? 0,
      sidebarPosition: getComputedStyle(document.querySelector(".sidebar")).position,
      inspectorPosition: getComputedStyle(document.querySelector(".inspector-pane")).position
    })`);
    assert.notEqual(compressedPanelWidths.sidebarPosition, "absolute");
    assert.notEqual(compressedPanelWidths.inspectorPosition, "absolute");
    assert.ok(compressedPanelWidths.center >= 314, `对话区跌破了最小宽度：${JSON.stringify(compressedPanelWidths)}`);
    assert.ok(
      compressedPanelWidths.center < preferredPanelWidths.right + compressedPanelWidths.center,
      "对话区没有吸收收窄",
    );
    assert.equal(compressedPanelWidths.left, preferredPanelWidths.left, "对话区还没到最小宽度，侧栏就先被挤了");

    // 再往里收到三栏的下限：这时轮到侧栏退到它的最小宽度。
    await client.evaluate(`window.resizeTo(482, 700)`);
    await client.waitFor(`window.innerWidth <= 482`, "The window did not reach the three-pane minimum width.");
    await client.waitFor(
      `document.querySelector(".sidebar")?.getBoundingClientRect().width <= 168`,
      "The left panel did not compress after the conversation reached its minimum.",
    );
    const minimumPanelWidths = await client.evaluate(`({
      left: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
      center: document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0,
      right: document.querySelector(".inspector-pane")?.getBoundingClientRect().width ?? 0
    })`);
    assert.ok(minimumPanelWidths.center <= 320 && minimumPanelWidths.center >= 314, `对话区不在最小宽度上：${JSON.stringify(minimumPanelWidths)}`);
    assert.ok(minimumPanelWidths.left <= 168 && minimumPanelWidths.left >= 166, `侧栏不在最小宽度上：${JSON.stringify(minimumPanelWidths)}`);
    const narrowConversationLayout = await client.evaluate(`(() => {
      const body = document.querySelector(".conversation-body");
      if (!body) return null;
      const probe = document.createElement("div");
      probe.className = "agent-turn-content";
      probe.innerHTML = '<details class="tool-activity"><summary><span>思考了 7 次，编辑了 1 个文件，查看了 2 个文件，搜索 1 次，运行了 4 个命令，调用了 3 个工具</span><svg class="tool-chevron" width="14"></svg></summary></details><div class="assistant-segment"><div class="markdown"><p>测试过程中的长中文内容必须在很窄的聊天窗口中正确换行而不能被右侧文件栏遮挡。<code>very-long-inline-token-without-natural-breaks-0123456789</code></p><div class="markdown-table-scroll"><table><tbody><tr><td style="min-width:480px">很宽的表格内容</td><td style="min-width:480px">继续横向滚动</td></tr></tbody></table></div></div></div>';
      body.append(probe);
      const summary = probe.querySelector(".tool-activity > summary");
      const summaryText = summary?.querySelector("span")?.getBoundingClientRect();
      const chevron = summary?.querySelector(".tool-chevron")?.getBoundingClientRect();
      const tableScroller = probe.querySelector(".markdown-table-scroll");
      const result = {
        hasActivity: document.querySelector(".conversation-pane")?.classList.contains("has-composer-activity") ?? false,
        paddingBottom: Number.parseFloat(getComputedStyle(body).paddingBottom),
        clientWidth: body.clientWidth,
        scrollWidth: body.scrollWidth,
        probeRight: probe.getBoundingClientRect().right,
        probeScrollWidth: probe.scrollWidth,
        probeClientWidth: probe.clientWidth,
        bodyRight: body.getBoundingClientRect().right,
        summaryGap: summaryText && chevron ? chevron.left - summaryText.right : 999,
        tableScrollable: tableScroller ? tableScroller.scrollWidth > tableScroller.clientWidth : false,
      };
      probe.remove();
      return result;
    })()`);
    assert.equal(narrowConversationLayout?.paddingBottom, narrowConversationLayout?.hasActivity ? 190 : 76);
    assert.ok((narrowConversationLayout?.scrollWidth ?? 1) <= (narrowConversationLayout?.clientWidth ?? 0) + 1);
    assert.ok((narrowConversationLayout?.probeScrollWidth ?? 1) <= (narrowConversationLayout?.probeClientWidth ?? 0) + 1);
    assert.ok((narrowConversationLayout?.probeRight ?? 1) <= (narrowConversationLayout?.bodyRight ?? 0) + 1);
    assert.ok((narrowConversationLayout?.summaryGap ?? 999) <= 9);
    assert.equal(narrowConversationLayout?.tableScrollable, true);
    await client.evaluate(`window.resizeTo(1440, 900)`);
    await client.waitFor(`window.innerWidth >= 1400`, "The window did not expand after panel compression.");
    // 上面为了验挤压顺序把右侧栏收起来了，这里再展开——「宽回来之后各面板回到用户
    // 拖出来的宽度」这条，说的是展开状态下的宽度。
    await client.evaluate(`document.querySelector('button[aria-label="展开作业栏"]')?.click()`);
    await client.waitFor(
      `!document.querySelector(".app-shell")?.classList.contains("right-collapsed")`,
      "The inspector did not expand again after the panel priority checks.",
    );
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
    const leftHandle = await client.evaluate(`(() => {
      const bounds = document.querySelector(".left-resizer")?.getBoundingClientRect();
      return bounds ? { x: bounds.left + bounds.width / 2, y: bounds.height / 2 } : null;
    })()`);
    assert.ok(leftHandle, "The left panel resize handle was missing.");
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: leftHandle.x, y: leftHandle.y, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: leftHandle.y, button: "left", buttons: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: leftHandle.y, button: "left", buttons: 0, clickCount: 1 });
    await client.waitFor(
      `Math.abs((document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0) - 167) <= 1`,
      "Dragging the conversation sidebar past its lower bound did not stop at 167px.",
    );
    const minimumLeftHandle = await client.evaluate(`(() => {
      const bounds = document.querySelector(".left-resizer")?.getBoundingClientRect();
      return bounds ? { x: bounds.left + bounds.width / 2, y: bounds.height / 2 } : null;
    })()`);
    assert.ok(minimumLeftHandle, "The left panel resize handle disappeared at its minimum.");
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: minimumLeftHandle.x, y: minimumLeftHandle.y, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: preferredPanelWidths.left, y: minimumLeftHandle.y, button: "left", buttons: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: preferredPanelWidths.left, y: minimumLeftHandle.y, button: "left", buttons: 0, clickCount: 1 });
    await client.waitFor(
      `Math.abs((document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0) - ${preferredPanelWidths.left}) <= 1`,
      "The conversation sidebar did not restore after its minimum-width drag test.",
    );
    const openInspectorDragSurface = await client.evaluate(`(() => {
      const surface = document.querySelector(".inspector-drag-surface");
      const bounds = surface?.getBoundingClientRect();
      if (!surface || !bounds) return null;
      const center = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return { width: bounds.width, hit: center === surface };
    })()`);
    assert.ok((openInspectorDragSurface?.width ?? 0) >= 12);
    assert.equal(openInspectorDragSurface?.hit, true);
    const rightHandle = await client.evaluate(`(() => {
      const bounds = document.querySelector(".right-resizer")?.getBoundingClientRect();
      return bounds ? { x: bounds.left + bounds.width / 2, y: bounds.height / 2 } : null;
    })()`);
    assert.ok(rightHandle);
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rightHandle.x, y: rightHandle.y, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: rightHandle.y, button: "left", buttons: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: rightHandle.y, button: "left", buttons: 0, clickCount: 1 });
    await client.waitFor(
      `(document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? Infinity) <= 316`,
      "The right panel drag did not reduce the conversation pane to its 315px minimum.",
    );
    const narrowConversation = await client.evaluate(`({
      conversation: document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0,
      inspector: document.querySelector(".inspector-pane")?.getBoundingClientRect().width ?? 0
    })`);
    assert.ok(narrowConversation.conversation <= 316, `Conversation pane stopped at ${narrowConversation.conversation}px instead of 315px.`);
    assert.ok(narrowConversation.inspector >= 800);
    const narrowTodoOverlay = await client.evaluate(`(() => {
      const conversation = document.querySelector(".conversation-pane");
      const overlays = document.querySelector(".composer-overlays");
      const composer = document.querySelector(".composer");
      if (!conversation || !overlays || !composer) return null;
      const activity = document.createElement("section");
      activity.className = "composer-activity expanded";
      activity.innerHTML = '<div class="composer-activity-header"><strong>Todo</strong></div><div class="composer-activity-body"><ol><li>一条很长、足以验证窄布局不会越过右侧面板边界的任务文本</li></ol></div>';
      overlays.append(activity);
      const bounds = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      };
      const result = {
        conversation: bounds(conversation),
        composer: bounds(composer),
        activity: bounds(activity),
      };
      activity.remove();
      return result;
    })()`);
    assert.ok(narrowTodoOverlay, "The narrow Todo overlay fixture did not render.");
    assert.ok(narrowTodoOverlay.composer.right <= narrowTodoOverlay.conversation.right + 1, `Composer overflowed the narrow conversation pane: ${JSON.stringify(narrowTodoOverlay)}`);
    assert.ok(narrowTodoOverlay.activity.right <= narrowTodoOverlay.conversation.right + 1, `Todo overflowed the narrow conversation pane: ${JSON.stringify(narrowTodoOverlay)}`);
    const expandedHandle = await client.evaluate(`(() => {
      const bounds = document.querySelector(".right-resizer")?.getBoundingClientRect();
      return bounds ? { x: bounds.left + bounds.width / 2, y: bounds.height / 2 } : null;
    })()`);
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: expandedHandle.x, y: expandedHandle.y, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1_088, y: expandedHandle.y, button: "left", buttons: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1_088, y: expandedHandle.y, button: "left", buttons: 0, clickCount: 1 });
    await client.evaluate(`document.querySelector('button[aria-label="收起右侧栏"]')?.click()`);

    const chatComposerAlignment = await client.evaluate(`(() => {
      const body = document.querySelector(".conversation-body");
      const composer = document.querySelector(".composer-wrap");
      if (!body || !composer) return null;
      let timeline = body.querySelector(".timeline");
      const temporary = !timeline;
      if (!timeline) {
        timeline = document.createElement("div");
        timeline.className = "timeline";
        body.append(timeline);
      }
      const chatBounds = timeline.getBoundingClientRect();
      const composerBounds = composer.getBoundingClientRect();
      if (temporary) timeline.remove();
      return {
        chatLeft: chatBounds.left,
        chatRight: chatBounds.right,
        composerLeft: composerBounds.left,
        composerRight: composerBounds.right,
      };
    })()`);
    assert.ok(Math.abs(chatComposerAlignment.chatLeft - chatComposerAlignment.composerLeft) <= 5);
    assert.ok(Math.abs(chatComposerAlignment.chatRight - chatComposerAlignment.composerRight) <= 5);

    const todoOverlayLayout = await client.evaluate(`(() => {
      const stack = document.querySelector(".composer-stack");
      const overlays = stack?.querySelector(".composer-overlays");
      const composer = stack?.querySelector(".composer");
      if (!stack || !overlays || !composer) return null;
      const before = stack.getBoundingClientRect().height;
      const plan = document.createElement("section");
      plan.className = "composer-activity expanded";
      plan.innerHTML = '<div class="composer-activity-header"><strong>Todo</strong></div><div class="composer-activity-body"><ol><li>测试</li></ol></div>';
      overlays.append(plan);
      const after = stack.getBoundingClientRect().height;
      const position = getComputedStyle(plan).position;
      const composerRect = composer.getBoundingClientRect();
      const hit = document.elementFromPoint(composerRect.left + composerRect.width / 2, composerRect.top + 4);
      const composerOwnsOverlap = Boolean(hit?.closest(".composer"));
      plan.remove();
      return { before, after, position, composerOwnsOverlap };
    })()`);
    assert.equal(todoOverlayLayout?.position, "relative");
    assert.equal(todoOverlayLayout?.after, todoOverlayLayout?.before);
    assert.equal(todoOverlayLayout?.composerOwnsOverlap, true, "Todo/Agent activity rendered above the composer instead of behind it.");

    await client.evaluate(`(() => {
      const project = ${JSON.stringify({
        name: basename(projectDirectory),
        path: projectDirectory,
        kind: "workspace",
      })};
      localStorage.setItem("coilcoil.mounted-projects", JSON.stringify([project]));
      localStorage.setItem("coilcoil.active-project", project.path);
      window.__coilcoilSmokeReloading = true;
      location.reload();
      return true;
    })()`);
    await client.waitFor(`typeof window.__coilcoilSmokeReloading === "undefined"`, "The packaged renderer did not finish the project reload.", 45_000);
    await dismissFirstRunSettings(client, !hasConfiguredProvider);
    await client.waitFor(
      `Boolean(document.querySelector('textarea[aria-label="发送消息给 CoilCoil"]')) && [...document.querySelectorAll(".project-name")].some((item) => item.textContent === ${JSON.stringify(basename(projectDirectory))}) && Boolean(document.querySelector(".conversation-header"))`,
      "The packaged app could not create a project session through IPC.",
      45_000,
    );
    const projectState = await client.evaluate(`({
      status: document.querySelector(".workspace-status")?.textContent || "",
      session: document.querySelector(".conversation-title")?.textContent || "",
      projects: [...document.querySelectorAll(".project-name")].map((item) => item.textContent || ""),
      headerBorder: getComputedStyle(document.querySelector(".conversation-header")).borderBottomWidth,
      inspectorTitle: document.querySelector(".inspector-header")?.textContent || "",
      filePreview: Boolean(document.querySelector(".file-preview")),
      workspaceGap: getComputedStyle(document.querySelector(".project-tree")).rowGap,
      workspaceMargin: getComputedStyle(document.querySelectorAll(".project-tree")[1]).marginTop,
      conversationBottomPadding: getComputedStyle(document.querySelector(".conversation-list")).paddingBottom,
    })`);
    assert.match(projectState.status, new RegExp(basename(projectDirectory)));
    assert.ok(projectState.session.length > 0);
    assert.deepEqual(projectState.projects, ["Home", basename(projectDirectory)]);
    assert.equal(projectState.headerBorder, "0px");
    assert.doesNotMatch(projectState.inspectorTitle, /项目作业/);
    assert.equal(projectState.filePreview, false);
    assert.deepEqual(
      { gap: projectState.workspaceGap, margin: projectState.workspaceMargin, bottom: projectState.conversationBottomPadding },
      { gap: "1px", margin: "2px", bottom: "3px" },
      "Workspace groups retained the oversized conversation spacing.",
    );

    const projectInteraction = await client.evaluate(`(async () => {
      const tree = [...document.querySelectorAll(".project-tree")].find((item) => item.querySelector(".project-name")?.textContent === ${JSON.stringify(basename(projectDirectory))});
      const toggle = tree?.querySelector(".project-toggle");
      const add = tree?.querySelector('button[aria-label*="新建对话"]');
      const titleBefore = document.querySelector(".conversation-title strong")?.textContent || "";
      toggle?.click();
      await new Promise((resolveWait) => setTimeout(resolveWait, 220));
      const titleAfterCollapse = document.querySelector(".conversation-title strong")?.textContent || "";
      const collapsed = toggle?.getAttribute("aria-expanded") === "false";
      toggle?.click();
      add?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => requestAnimationFrame(resolveWait)));
      return {
        titleBefore,
        titleAfterCollapse,
        collapsed,
        pendingTitle: document.querySelector(".conversation-title strong")?.textContent || "",
        pendingRow: Boolean(tree?.querySelector(".conversation-row.pending")),
        loading: Boolean(document.querySelector(".loading-state")),
        textareaDisabled: document.querySelector('textarea[aria-label="发送消息给 CoilCoil"]')?.disabled ?? true,
        conversationPane: Boolean(document.querySelector(".conversation-pane")),
        activeProjects: [...document.querySelectorAll(".project-tree.active .project-name")].map((item) => item.textContent),
      };
    })()`);
    assert.equal(projectInteraction.titleAfterCollapse, projectInteraction.titleBefore, `Collapsing a Workspace changed the active conversation: ${JSON.stringify(projectInteraction)}`);
    assert.equal(projectInteraction.collapsed, true);
    assert.equal(projectInteraction.pendingTitle, "新对话");
    assert.equal(projectInteraction.pendingRow, true);
    assert.equal(projectInteraction.loading, false);
    assert.equal(projectInteraction.textareaDisabled, false);

    await client.evaluate(`(() => {
      const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (value) => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
      const textarea = document.querySelector('textarea[aria-label="发送消息给 CoilCoil"]');
      textarea?.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    })()`);
    await client.waitFor(`Boolean(document.querySelector(".composer-images img"))`, "Pasted images did not appear in the composer.");
    await client.evaluate(`(() => {
      const home = [...document.querySelectorAll(".project-tree")].find((item) => item.querySelector(".project-name")?.textContent === "Home");
      home?.querySelector('button[aria-label*="新建对话"]')?.click();
    })()`);
    await client.waitFor(`(() => {
      const original = [...document.querySelectorAll(".project-tree")].find((item) => item.querySelector(".project-name")?.textContent === ${JSON.stringify(basename(projectDirectory))});
      return !original?.querySelector(".conversation-row.pending") && !document.querySelector(".composer-images");
    })()`, "The temporary conversation did not disappear after switching to another project.");

    await client.evaluate(`(() => {
      localStorage.setItem("coilcoil.active-project", ${JSON.stringify(projectDirectory)});
      window.__coilcoilSmokeReloading = true;
      location.reload();
    })()`);
    await client.waitFor(`typeof window.__coilcoilSmokeReloading === "undefined"`, "The packaged renderer did not finish the temporary-session reload.", 45_000);
    await dismissFirstRunSettings(client, !hasConfiguredProvider);
    await client.waitFor(`document.querySelector(".workspace-status")?.textContent.includes(${JSON.stringify(basename(projectDirectory))})`, "The project session did not restore after the temporary-session test.", 45_000);

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
    const unknownFileFallback = await client.evaluate(`window.coilcoil.openFilePreview({ root: ${JSON.stringify(projectDirectory)}, path: "unknown-format.coilcoil-smoke" })`);
    assert.deepEqual(unknownFileFallback, { opened: false, actions: ["reveal", "force-text", "trash"] });
    await client.evaluate(`[...document.querySelectorAll(".file-leaf")].find((item) => item.textContent.includes("unknown-format.coilcoil-smoke"))?.click()`);
    await client.waitFor(
      `document.querySelector(".preview-placeholder.error")?.textContent.includes("可从右键菜单选择其他打开方式")`,
      "Left-clicking an unsupported file did not show the right-click guidance.",
    );
    assert.equal(await client.evaluate(`Boolean(document.querySelector(".conversation-context-menu"))`), false, "Left-clicking an unsupported file opened a duplicate native/context menu.");
    const openedUnknownContextMenu = await client.evaluate(`(() => {
      const file = [...document.querySelectorAll(".file-leaf")].find((item) => item.textContent.includes("unknown-format.coilcoil-smoke"));
      if (!file) return false;
      file.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 180, clientY: 180 }));
      return true;
    })()`);
    assert.equal(openedUnknownContextMenu, true);
    await client.waitFor(`document.querySelectorAll('.conversation-context-menu[data-state="open"]').length === 1`, "The unsupported-file context menu did not settle.");
    const unknownContextMenu = await client.evaluate(`[...document.querySelectorAll('.conversation-context-menu[data-state="open"] .conversation-context-item')].map((item) => item.textContent)`);
    assert.deepEqual(unknownContextMenu, ["复制绝对路径", "复制相对路径", "作为文本尝试预览", "在访达中显示", "移到废纸篓"]);
    await client.evaluate(`([...document.querySelectorAll('.conversation-context-menu[data-state="open"] .conversation-context-item')].find((item) => item.textContent === "作为文本尝试预览"))?.click()`);
    await client.waitFor(
      `document.querySelector(".files-workspace.has-preview .text-preview")?.textContent.includes("unknown")`,
      "The unified context menu did not force-open the unsupported file as text.",
    );
    await client.evaluate(`document.querySelector('button[aria-label="关闭文件预览"]')?.click()`);
    await client.evaluate(`[...document.querySelectorAll(".file-tree-node > button")].find((item) => item.textContent.includes("lazy-folder"))?.click()`);
    await client.waitFor(
      `[...document.querySelectorAll(".file-leaf")].some((item) => item.textContent.includes("lazy-child.txt"))`,
      "The file tree did not load an expanded folder on demand.",
    );
    const openedFileContextMenu = await client.evaluate(`(() => {
      const file = [...document.querySelectorAll(".file-leaf")].find((item) => item.textContent.includes("lazy-child.txt"));
      if (!file) return false;
      file.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 180, clientY: 180 }));
      return true;
    })()`);
    assert.equal(openedFileContextMenu, true);
    await client.waitFor(`document.querySelectorAll('.conversation-context-menu[data-state="open"]').length === 1`, "The file context menu did not settle.");
    const fileContextMenu = await client.evaluate(`[...document.querySelectorAll('.conversation-context-menu[data-state="open"] .conversation-context-item')].map((item) => item.textContent)`);
    assert.deepEqual(fileContextMenu, ["复制绝对路径", "复制相对路径", "作为文本尝试预览", "在访达中显示", "移到废纸篓"]);
    await client.evaluate(`([...document.querySelectorAll('.conversation-context-menu[data-state="open"] .conversation-context-item')].find((item) => item.textContent === "复制绝对路径"))?.click()`);
    await delay(50);
    // macOS 的临时目录是 /var → /private/var 的软链。复制出来的是用户看到的那条路
    // 径，断言时两边都还原一次，免得比的是软链写法的差别。
    const copiedAbsolutePath = execFileSync("pbpaste", { encoding: "utf8" }).trim();
    assert.equal(
      await realpath(copiedAbsolutePath),
      join(await realpath(projectDirectory), "lazy-folder", "lazy-child.txt"),
    );
    await client.evaluate(`(() => {
      const file = [...document.querySelectorAll(".file-leaf")].find((item) => item.textContent.includes("lazy-child.txt"));
      file?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 180, clientY: 180 }));
    })()`);
    await client.waitFor(`[...document.querySelectorAll('.conversation-context-menu[data-state="open"] .conversation-context-item')].some((item) => item.textContent === "复制相对路径")`, "The relative-path context action did not reopen.");
    await client.evaluate(`([...document.querySelectorAll('.conversation-context-menu[data-state="open"] .conversation-context-item')].find((item) => item.textContent === "复制相对路径"))?.click()`);
    await delay(50);
    assert.equal(execFileSync("pbpaste", { encoding: "utf8" }).trim(), join("lazy-folder", "lazy-child.txt"));
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
      const editor = document.querySelector('[aria-label="发送消息给 CoilCoil"]');
      return {
        value: editor?.value || "",
        overlay: document.querySelector(".conversation-pane")?.classList.contains("file-drag-active") ?? true,
      };
    })()`);
    assert.match(draggedPaths?.value ?? "", /'\/[^']+\/lazy-folder'/);
    assert.match(draggedPaths?.value ?? "", /'\/[^']+\/lazy-folder\/lazy-child\.txt'/);
    assert.equal(draggedPaths?.overlay, false);
    await client.evaluate(`(() => {
      const editor = document.querySelector('textarea[aria-label="发送消息给 CoilCoil"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, "");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await client.evaluate(`document.querySelector('.inspector-nav button[aria-label="文件"]')?.click()`);
    await client.evaluate(`[...document.querySelectorAll(".file-leaf")].find((item) => item.textContent.includes("lazy-child.txt"))?.click()`);
    await client.waitFor(
      `document.querySelector(".files-workspace.has-preview .text-preview")?.textContent.includes("lazy")`,
      "The inline text preview did not render the selected file.",
    );
    const previewLayout = await client.evaluate(`(() => {
      const workspace = document.querySelector(".files-workspace.has-preview")?.getBoundingClientRect();
      const preview = document.querySelector(".inline-file-preview")?.getBoundingClientRect();
      const resizer = document.querySelector(".files-split-resizer")?.getBoundingClientRect();
      const tree = document.querySelector(".files-tree-region")?.getBoundingClientRect();
      const footer = document.querySelector(".inline-preview-status")?.getBoundingClientRect();
      return {
        workspaceLeft: workspace?.left ?? 0,
        workspaceRight: workspace?.right ?? 0,
        previewLeft: preview?.left ?? 0,
        previewRight: preview?.right ?? 0,
        resizerLeft: resizer?.left ?? 0,
        resizerRight: resizer?.right ?? 0,
        treeLeft: tree?.left ?? 0,
        treeRight: tree?.right ?? 0,
        footerBottom: footer?.bottom ?? 0,
        workspaceBottom: workspace?.bottom ?? 0,
      };
    })()`);
    assert.ok(Math.abs(previewLayout.workspaceLeft - previewLayout.previewLeft) <= 1);
    assert.ok(Math.abs(previewLayout.previewRight - previewLayout.resizerLeft) <= 1);
    assert.ok(Math.abs(previewLayout.resizerRight - previewLayout.treeLeft) <= 1);
    assert.ok(Math.abs(previewLayout.workspaceRight - previewLayout.treeRight) <= 1);
    assert.ok(Math.abs(previewLayout.footerBottom - previewLayout.workspaceBottom) <= 1);
    const splitBefore = await client.evaluate(`(() => {
      const workspace = document.querySelector(".files-workspace.has-preview")?.getBoundingClientRect();
      const handle = document.querySelector(".files-split-resizer")?.getBoundingClientRect();
      const preview = document.querySelector(".inline-file-preview")?.getBoundingClientRect();
      return workspace && handle && preview ? {
        workspaceLeft: workspace.left,
        workspaceWidth: workspace.width,
        handleX: handle.left + handle.width / 2,
        handleY: handle.top + handle.height / 2,
        previewWidth: preview.width,
      } : null;
    })()`);
    assert.ok(splitBefore, "The inline file preview did not expose its resize handle.");
    const splitTargetX = splitBefore.workspaceLeft + splitBefore.workspaceWidth * 0.55;
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: splitBefore.handleX, y: splitBefore.handleY, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: splitTargetX, y: splitBefore.handleY, button: "left", buttons: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: splitTargetX, y: splitBefore.handleY, button: "left", buttons: 0, clickCount: 1 });
    await client.waitFor(
      `Math.abs((document.querySelector(".inline-file-preview")?.getBoundingClientRect().width ?? 0) - ${splitBefore.previewWidth}) > 20`,
      "Dragging the file preview divider did not resize the panes.",
    );
    const embeddedOverflow = await client.evaluate(`(() => {
      const content = document.querySelector(".inline-preview-content");
      if (!content) return null;
      const originalClass = content.className;
      content.classList.add("embedded");
      const result = {
        overflowX: getComputedStyle(content).overflowX,
        overflowY: getComputedStyle(content).overflowY,
      };
      content.className = originalClass;
      return result;
    })()`);
    assert.deepEqual(embeddedOverflow, { overflowX: "hidden", overflowY: "hidden" });
    await writeFile(join(projectDirectory, "lazy-folder", "lazy-child.txt"), "live preview update\n", "utf8");
    await client.waitFor(
      `document.querySelector(".files-workspace.has-preview .text-preview")?.textContent.includes("live preview update")`,
      "The inline preview did not update after the file changed on disk.",
    );
    await client.evaluate(`document.querySelector('button[aria-label="关闭文件预览"]')?.click()`);
    await client.waitFor(`!document.querySelector(".files-workspace.has-preview")`, "The inline file preview did not close.");
    await client.evaluate(`document.querySelector('button[aria-label="收起右侧栏"]')?.click()`);

    if (!live) {
      const fixtureToken = `DESKTOP_RESTORE_FIXTURE_${Date.now()}`;
      const fixtureSnapshot = await client.evaluate(`window.coilcoil.request({ type: "create_session", cwd: ${JSON.stringify(projectDirectory)} })`);
      const fixturePath = join(dirname(fixtureSnapshot.session.path), `desktop-restore-${Date.now()}.jsonl`);
      const fixtureSession = { ...fixtureSnapshot, session: { ...fixtureSnapshot.session, id: `desktop-restore-${Date.now()}`, path: fixturePath } };
      await writeFile(fixturePath, `${restoreFixtureEntries(fixtureSession, fixtureToken).map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      await client.evaluate(`(() => {
        localStorage.setItem("coilcoil.activeProject", ${JSON.stringify(projectDirectory)});
        window.__coilcoilSmokeReloading = true;
        location.reload();
      })()`);
      await client.waitFor(`typeof window.__coilcoilSmokeReloading === "undefined"`, "The packaged renderer did not finish the fixture-session reload.", 45_000);
      await dismissFirstRunSettings(client, !hasConfiguredProvider);
      await client.waitFor(
        `[...document.querySelectorAll(".conversation-row")].some((row) => row.textContent.includes(${JSON.stringify(fixtureToken)}))`,
        "The packaged sidebar did not discover the restore fixture session.",
        60_000,
      );
      assert.equal(await client.evaluate(`(() => {
        const row = [...document.querySelectorAll(".conversation-row")].find((item) => item.textContent.includes(${JSON.stringify(fixtureToken)}));
        return Boolean(row) && !row.querySelector(".conversation-status");
      })()`), true, "A normal persisted conversation still rendered the meaningless default status icon.");
      await client.evaluate(`[...document.querySelectorAll(".conversation-row")].find((row) => row.textContent.includes(${JSON.stringify(fixtureToken)}))?.click()`);
      await client.waitFor(`document.querySelectorAll(".user-bubble-button .message-image img").length === 1`, "The packaged renderer did not restore the historical image.", 60_000);
      // 标题在 .conversation-title 里，tooltip 挂在这一层上（strong 只放文字）。
      await client.waitFor(
        `Boolean(document.querySelector(".conversation-title strong")?.textContent?.trim())`,
        "The restored conversation header never showed a title.",
        20_000,
      );
      const restoredConversationTitle = await client.evaluate(`(() => {
        const holder = document.querySelector(".conversation-title");
        const title = holder?.querySelector("strong");
        return {
          text: title?.textContent || "",
          tooltip: holder?.getAttribute("title") || "",
          visibleWidth: title?.clientWidth ?? 0,
          contentWidth: title?.scrollWidth ?? 0,
        };
      })()`);
      const expectedConversationTitle = `会话恢复投影测试 ${fixtureToken}`;
      assert.equal(restoredConversationTitle.text, expectedConversationTitle, "The conversation header still hard-truncated the title text.");
      assert.equal(restoredConversationTitle.tooltip, expectedConversationTitle, "The conversation title tooltip did not preserve the full title.");
      assert.ok(restoredConversationTitle.visibleWidth > 0 && restoredConversationTitle.visibleWidth <= 620, `The conversation title did not respect the available header width: ${JSON.stringify(restoredConversationTitle)}`);
      await client.evaluate(`document.querySelector(".user-bubble-button")?.click()`);
      await client.waitFor(`Boolean(document.querySelector('textarea[aria-label="编辑历史消息"]'))`, "The historical message did not enter edit mode.");
      const historicalImageBeforePaste = await client.evaluate(`(() => {
        const editor = document.querySelector('textarea[aria-label="编辑历史消息"]');
        const before = document.querySelectorAll(".user-message-editor-shell .composer-images img").length;
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (value) => value.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "history-paste.png", { type: "image/png" }));
        const dispatched = editor?.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer })) ?? false;
        return { before, files: transfer.files.length, dispatched };
      })()`);
      assert.deepEqual(historicalImageBeforePaste, { before: 1, files: 1, dispatched: false });
      await client.waitFor(`document.querySelectorAll(".user-message-editor-shell .composer-images img").length === 2`, "The pasted historical image did not appear in the editor.");
      await client.evaluate(`document.querySelector('.user-message-editor-shell button[aria-label="移除图片"]')?.click()`);
      await client.waitFor(`document.querySelectorAll(".user-message-editor-shell .composer-images img").length === 1`, "The historical image was not removed from the editor.");
      await client.evaluate(`document.querySelector(".conversation-header")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
      await client.waitFor(`!document.querySelector('textarea[aria-label="编辑历史消息"]') && document.querySelectorAll(".user-bubble-button .message-image img").length === 1`, "The edited historical image state did not return to the message bubble.");
      await client.waitFor(`Boolean(document.querySelector(".tool-activity-row"))`, "The packaged renderer did not restore the historical tool run.", 60_000);
      const preservedProviderFailure = await client.evaluate(`({
        tool: Boolean(document.querySelector(".tool-activity-row")),
        error: [...document.querySelectorAll(".assistant-message.error")].some((item) => item.textContent.includes(${JSON.stringify(fixtureToken)}))
      })`);
      assert.deepEqual(preservedProviderFailure, { tool: true, error: true });
      const overlayLayout = await client.evaluate(`(() => {
        const overlays = document.querySelector('.composer-overlays');
        const activity = overlays?.querySelector('.composer-activity');
        if (!overlays || !activity) return null;
        const banner = document.createElement('div');
        banner.className = 'error-banner';
        banner.innerHTML = '<span>测试错误消息不会覆盖 Agent 活动</span>';
        overlays.prepend(banner);
        const bannerRect = banner.getBoundingClientRect();
        const activityRect = activity.getBoundingClientRect();
        banner.remove();
        return { gap: activityRect.top - bannerRect.bottom };
      })()`);
      assert.ok(overlayLayout === null || overlayLayout.gap >= 7, `The error banner overlapped the Agent activity panel (${overlayLayout?.gap}px).`);
      await client.evaluate(`window.coilcoil.request({ type: "archive_session", cwd: ${JSON.stringify(projectDirectory)}, sessionPath: ${JSON.stringify(fixturePath)} })`);
      await client.evaluate(`document.querySelector('button[aria-label="归档会话"]')?.click()`);
      await client.waitFor(
        `document.querySelector(".archive-dialog")?.textContent.includes(${JSON.stringify(fixtureToken)})`,
        "The archive dialog did not render the archived fixture conversation.",
      );
      const setArchiveSearch = async (value) => client.evaluate(`(() => {
        const input = document.querySelector(".archive-search input");
        if (!(input instanceof HTMLInputElement)) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
      assert.equal(await setArchiveSearch(fixtureToken), true);
      await client.waitFor(
        `document.querySelectorAll(".archive-session").length === 1 && document.querySelector(".archive-session")?.textContent.includes(${JSON.stringify(fixtureToken)})`,
        "Searching archived conversation titles did not preserve the matching row.",
      );
      assert.equal(await setArchiveSearch("DESKTOP_ARCHIVE_NO_MATCH"), true);
      await client.waitFor(
        `Boolean(document.querySelector(".archive-filter-empty")) && document.querySelectorAll(".archive-session").length === 0`,
        "The archive title search did not hide non-matching rows.",
      );
      assert.equal(await setArchiveSearch(fixtureToken), true);
      await client.waitFor(`document.querySelectorAll(".archive-session").length === 1`, "The archive title search did not recover after clearing a non-match.");
      await client.evaluate(`document.querySelector(".archive-session button")?.click()`);
      await client.waitFor(
        `document.querySelector(".archive-dialog")?.textContent.includes("暂无归档会话")`,
        "Restoring the archived fixture did not update the dialog.",
      );
      await client.evaluate(`document.querySelector('button[aria-label="关闭归档会话"]')?.click()`);
    }

    if (live) {
      const openedLiveConversation = await client.evaluate(`(async () => {
        const configuration = await window.coilcoil.request({ type: "get_configuration" });
        const configured = configuration.models.filter((item) => item.configured);
        const model = configured.find((item) => {
          const identity = \`${'${item.provider} ${item.id} ${item.name}'}\`.toLowerCase();
          return identity.includes("minimax") && /(^|[^a-z0-9])m3([^a-z0-9]|$)/i.test(identity);
        })
          ?? configured.find((item) => item.provider === configuration.provider && item.id === "gpt-5.6-sol")
          ?? configured.find((item) => item.provider === configuration.provider && item.id === configuration.modelId)
          ?? configured[0];
        if (!model) throw new Error("No configured live GUI smoke model.");
        await window.coilcoil.request({ type: "configure_model", provider: model.provider, modelId: model.id, thinkingLevel: "low" });
        const activeTree = [...document.querySelectorAll(".project-tree")].find((item) => item.classList.contains("active"));
        const addButton = [...(activeTree?.querySelectorAll("button.project-action") ?? [])]
          .find((button) => button.getAttribute("aria-label")?.includes("新建对话"));
        if (!addButton) return false;
        addButton.click();
        return true;
      })()`);
      assert.equal(openedLiveConversation, true, "The live smoke could not open a fresh project conversation.");
      await client.waitFor(
        `Boolean(document.querySelector(".conversation-row.pending.active")) && document.querySelector(".conversation-title strong")?.textContent === "新对话"`,
        "The live smoke did not enter the temporary new-conversation state.",
      );
      await client.evaluate(`(() => {
        window.__coilcoilSmokeEvents = [];
        window.__coilcoilSmokeUnsubscribe?.();
        window.__coilcoilSmokeUnsubscribe = window.coilcoil.onRuntimeEvent((event, runtimeId) => {
          window.__coilcoilSmokeEvents.push({
            type: event.type,
            runtimeId,
            field: event.type === "message_delta" ? event.field : undefined,
            running: event.type === "run_state" ? event.running : undefined,
            toolName: event.type === "tool_started" || event.type === "tool_finished" ? event.tool.name : undefined,
            toolOutput: event.type === "tool_finished" ? event.tool.output : undefined,
            message: event.type === "runtime_error" ? event.message : undefined,
            subagents: event.type === "subagents_updated" ? event.subagents : undefined,
          });
        });
        return true;
      })()`);
      const planToken = `DESKTOP_PLAN_OK_${Date.now()}`;
      const fileToken = `DESKTOP_FILE_OK_${Date.now()}`;
      const terminalToken = `DESKTOP_TERMINAL_OK_${Date.now()}`;
      const subagentToken = `DESKTOP_SUBAGENT_OK_${Date.now()}`;
      const stoppedSubagentToken = `DESKTOP_SUBAGENT_STOP_${Date.now()}`;
      const fileName = "coilcoil-desktop-smoke.txt";
      await submitPrompt(
        client,
        `You must call the todo tool once before replying. Set exactly two short plan items and mark both completed. Do not call another tool. Then reply exactly ${planToken}.`,
        "todo",
      );
      await submitPromptWithScrollPause(
        client,
        `You must call the write tool before replying. Create ${fileName} in the current project with exactly this content: ${fileToken}. Do not use bash or edit. Then reply exactly ${fileToken}.`,
        "write",
      );
      await submitPrompt(
        client,
        `You must execute a shell tool before replying. Run exactly: printf ${terminalToken}. Then reply exactly ${terminalToken}.`,
        "bash",
      );
      const subagentEventStart = await client.evaluate(`window.__coilcoilSmokeEvents?.length ?? 0`);
      await submitPrompt(
        client,
        `You must call the subagent tool exactly once with action run, agent explore, and background false. Ask it to reply exactly ${subagentToken}. Do not call another tool. After it completes, reply exactly ${subagentToken}.`,
        "subagent",
        180_000,
      );
      await client.waitFor(
        `window.__coilcoilSmokeEvents?.slice(${subagentEventStart}).some((event) => event.type === "subagents_updated" && event.subagents?.some((item) => item.status === "completed"))`,
        "The CoilCoil subagent extension did not publish a completed run.",
        180_000,
      );
      const completedSubagent = await client.evaluate(`(() => {
        const events = window.__coilcoilSmokeEvents?.slice(${subagentEventStart}) ?? [];
        const activities = events.flatMap((event) => event.type === "subagents_updated" ? (event.subagents ?? []) : []);
        return activities.findLast((item) => item.status === "completed") ?? null;
      })()`);
      if (!String(completedSubagent?.finalOutput ?? "").includes(subagentToken)) {
        const sessions = await client.evaluate(`window.coilcoil.request({ type: "list_sessions", cwd: ${JSON.stringify(projectDirectory)} })`);
        const latestSession = sessions[0]?.path ? await readFile(sessions[0].path, "utf8").catch(() => "") : "";
        const subagentEvents = await client.evaluate(`window.__coilcoilSmokeEvents?.filter((event) => event.type === "subagents_updated" || event.toolName === "subagent") ?? []`);
        throw new Error(`The completed subagent activity did not contain its final output.\nProjected events:\n${JSON.stringify(subagentEvents, null, 2)}\nPersisted session tail:\n${latestSession.split("\n").slice(-8).join("\n")}`);
      }
      await client.waitFor(
        `Boolean(document.querySelector(".subagent-card.timeline.completed"))`,
        "The completed subagent did not render as an inline conversation card.",
      );
      assert.equal(await client.evaluate(`(() => {
        const card = document.querySelector(".subagent-card.timeline.completed");
        if (!(card instanceof HTMLButtonElement)) return false;
        card.click();
        return true;
      })()`), true, "The inline subagent card was not clickable.");
      await client.waitFor(
        `Boolean(document.querySelector(".subagent-dialog"))`,
        "Clicking the inline subagent card did not open the read-only detail dialog.",
      );
      assert.equal(await client.evaluate(`(() => {
        const dialog = document.querySelector(".subagent-dialog");
        const text = dialog?.textContent ?? "";
        return text.includes("explore") && text.includes(${JSON.stringify(subagentToken)});
      })()`), true, "The subagent detail dialog did not render the child transcript.");
      await client.evaluate(`document.querySelector('.subagent-dialog header button')?.click()`);
      await client.waitFor(
        `!document.querySelector(".subagent-dialog")`,
        "The subagent detail dialog did not close.",
      );
      assert.equal(await client.evaluate(`(() => {
        const tab = [...document.querySelectorAll(".composer-activity-tabs button")]
          .find((button) => button.textContent?.trim().startsWith("代理"));
        if (!(tab instanceof HTMLButtonElement)) return false;
        tab.click();
        return true;
      })()`), true, "The composer activity panel did not expose its subagent tab.");
      await client.waitFor(
        `Boolean(document.querySelector(".composer-subagent-list .subagent-card.panel"))`,
        "The composer activity panel did not render the subagent card list.",
      );

      const stopEventStart = await client.evaluate(`window.__coilcoilSmokeEvents?.length ?? 0`);
      assert.equal(await fillAndSubmitComposer(
        client,
        `Call the subagent tool exactly once with action run, agent worker, background true, and worktree false. Give it this exact task: Run the bash command sleep 90, then reply exactly ${stoppedSubagentToken}. Do not call status, stop, resume, or another tool. After the background run starts, reply briefly that it started.`,
      ), true);
      await client.waitFor(
        `window.__coilcoilSmokeEvents?.slice(${stopEventStart}).some((event) => event.type === "subagents_updated" && event.subagents?.some((item) => item.background && (item.status === "pending" || item.status === "running")))`,
        "The bundled subagent extension did not expose a live background run.",
        120_000,
      );
      const descendantApplications = execFileSync("/usr/bin/lsappinfo", ["list"], { encoding: "utf8" })
        .split(/(?=\s*\d+\)\s)/)
        .filter((record) => [...descendantPids(child.pid)].some((pid) => record.includes(`pid = ${pid} `)));
      for (const record of descendantApplications) {
        assert.doesNotMatch(record, /^\s*\d+\)\s+"exec"/m, "A real subagent worker appeared in the Dock as a generic exec application.");
        assert.doesNotMatch(record, /type="Foreground"/, "A real subagent worker registered as a foreground Dock application.");
      }
      assert.equal(await client.evaluate(`(async () => {
        const events = window.__coilcoilSmokeEvents?.slice(${stopEventStart}) ?? [];
        const scoped = [...events].reverse().find((event) => event.type === "subagents_updated"
          && event.subagents?.some((item) => item.background && (item.status === "pending" || item.status === "running")));
        const activity = scoped?.subagents?.find((item) => item.background && (item.status === "pending" || item.status === "running"));
        if (!activity?.runId || !scoped?.runtimeId) return false;
        await window.coilcoil.request({ type: "stop_subagent", id: activity.runId, background: true }, scoped.runtimeId);
        return true;
      })()`), true, "The runtime protocol could not stop the live background subagent.");
      await client.waitFor(
        `window.__coilcoilSmokeEvents?.slice(${stopEventStart}).some((event) => event.type === "subagents_updated" && event.subagents?.some((item) => item.background && item.status === "stopped"))`,
        "The background subagent did not transition to stopped after the UI control was clicked.",
        60_000,
      );
      await client.waitFor(
        `window.__coilcoilSmokeEvents?.slice(${stopEventStart}).some((event) => event.type === "run_state" && event.running === false)`,
        "The parent Agent did not settle after stopping its background subagent.",
        60_000,
      );

      await client.evaluate(`document.querySelector('button[aria-label="刷新项目"]')?.click()`);

      const toolState = await client.evaluate(`({
        count: document.querySelectorAll(".tool-activity-row").length,
        failed: document.querySelectorAll(".tool-activity-row.failed").length
      })`);
      assert.ok(toolState.count >= 1, "The GUI did not render any tool activity details.");
      assert.equal(toolState.failed, 0);

      const eventState = await client.evaluate(`window.__coilcoilSmokeEvents`);
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
      assert.equal(toolNames.has("subagent"), true, "The packaged Agent did not emit the bundled subagent lifecycle.");
      assert.equal([...toolNames].some((name) => name === "bash" || name.startsWith("terminal")), true, "The live Agent did not emit a terminal tool lifecycle.");
      assert.equal(eventState.some((event) => event.toolName === "bash" && event.toolOutput?.includes(terminalToken)), true, "The terminal tool did not return the expected output.");

      await clickInspector(client, "文件");
      await client.waitFor(
        `[...document.querySelectorAll(".file-leaf")].some((item) => item.textContent.includes(${JSON.stringify(fileName)}))`,
        "The Agent-written file was not projected into Files.",
      );
      assert.equal(await client.evaluate(`Boolean(document.querySelector(".file-preview"))`), false);
      assert.equal((await readFile(join(projectDirectory, fileName), "utf8")).trim(), fileToken);

      await client.evaluate(`window.__coilcoilSmokeReloading = true`);
      await client.send("Page.reload", { ignoreCache: true });
      await client.waitFor(`typeof window.__coilcoilSmokeReloading === "undefined"`, "The packaged renderer did not finish the final reload.", 45_000);
      await dismissFirstRunSettings(client, !hasConfiguredProvider);
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

    process.stdout.write(`CoilCoil Desktop smoke passed${live ? " (live Agent + tools + restored session)" : ""}.\n`);
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
    await new Promise((resolveClose) => modelFixture.server.close(resolveClose));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
