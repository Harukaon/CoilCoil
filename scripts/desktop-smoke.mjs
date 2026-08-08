import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
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
  await client.evaluate(`(() => {
    const button = [...document.querySelectorAll(".inspector-nav button")]
      .find((item) => item.textContent.includes(${JSON.stringify(label)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function dismissFirstRunSettings(client, required) {
  if (!required) return;
  await client.waitFor(`Boolean(document.querySelector('.settings-screen'))`, "The first-run settings screen did not appear after reload.", 45_000);
  await client.evaluate(`document.querySelector('.settings-screen button[aria-label="关闭设置"]')?.click()`);
  await client.waitFor(`Boolean(document.querySelector('.conversation-pane'))`, "The workspace did not return after closing first-run settings.", 10_000);
}

async function fillAndSubmitComposer(client, prompt) {
  const filled = await client.evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="发送消息给 SuoCode"]');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  assert.equal(filled, true);
  await delay(75);
  return client.evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="发送消息给 SuoCode"]');
    const form = input?.closest("form");
    if (!form) return false;
    form.requestSubmit();
    return true;
  })()`);
}

async function submitPrompt(client, prompt, expectedTool, timeout = 120_000) {
  const eventStart = await client.evaluate(`window.__suocodeSmokeEvents?.length ?? 0`);
  const submitted = await fillAndSubmitComposer(client, prompt);
  assert.equal(submitted, true);
  try {
    await client.waitFor(
      `window.__suocodeSmokeEvents?.slice(${eventStart}).some((event) => event.type === "tool_finished" && event.toolName === ${JSON.stringify(expectedTool)}) && window.__suocodeSmokeEvents?.slice(${eventStart}).some((event) => event.type === "run_state" && event.running === false)`,
      `The packaged GUI did not complete the expected ${expectedTool} tool run.`,
      timeout,
    );
  } catch (error) {
    const diagnostics = await client.evaluate(`({
      events: window.__suocodeSmokeEvents?.slice(${eventStart}) ?? [],
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
  const eventStart = await client.evaluate(`window.__suocodeSmokeEvents?.length ?? 0`);
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
    `window.__suocodeSmokeEvents?.slice(${eventStart}).some((event) => event.type === "tool_finished" && event.toolName === ${JSON.stringify(expectedTool)}) && window.__suocodeSmokeEvents?.slice(${eventStart}).some((event) => event.type === "run_state" && event.running === false)`,
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

function subagentFixtureEntries(snapshot, token) {
  const timestamp = new Date().toISOString();
  const toolId = `desktop-subagent-tool-${token}`;
  const userId = `desktop-subagent-user-${token}`;
  const callId = `desktop-subagent-call-${token}`;
  const resultId = `desktop-subagent-result-${token}`;
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
          { type: "text", text: `子 Agent 投影测试 ${token}` },
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
        content: [{ type: "toolCall", id: toolId, name: "subagent", arguments: { agent: "scout", task: "验证桌面端扩展投影" } }],
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
        toolName: "subagent",
        content: [{ type: "text", text: token }],
        details: {
          mode: "single",
          runId: `desktop-subagent-run-${token}`,
          results: [{
            agent: "scout",
            task: "验证桌面端扩展投影",
            exitCode: 0,
            model: "smoke-child-model",
            usage: { input: 8, output: 4, cacheRead: 3, cacheWrite: 0, cost: 0, turns: 2 },
            messages: [{ role: "assistant", content: [{ type: "thinking", text: "检查 Pi 扩展事件" }, { type: "text", text: token }] }],
            toolCalls: [{ text: "读取桌面测试文件", expandedText: "read /tmp/desktop-subagent-smoke" }],
            finalOutput: token,
          }],
        },
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

  const dataDirectory = await mkdtemp(join(tmpdir(), "suocode-desktop-data-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "suocode-desktop-project-"));
  const concurrentDirectoryA = await mkdtemp(join(tmpdir(), "suocode-concurrent-a-"));
  const concurrentDirectoryB = await mkdtemp(join(tmpdir(), "suocode-concurrent-b-"));
  execFileSync("git", ["init", "--quiet", projectDirectory]);
  await mkdir(join(projectDirectory, "lazy-folder"));
  await writeFile(join(projectDirectory, "lazy-folder", "lazy-child.txt"), "lazy\n", "utf8");
  await writeFile(join(projectDirectory, "unknown-format.suocode-smoke"), "unknown\n", "utf8");
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
      ...(live ? { SUOCODE_LEGACY_AGENT_DIR: join(homedir(), ".pi", "agent") } : {}),
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
      `document.readyState === "complete" && typeof window.suocode === "object"`,
      "The renderer or preload bridge did not become ready.",
    );
    await client.waitFor(
      `document.querySelector(".project-name")?.textContent === "Home" && Boolean(document.querySelector('textarea[aria-label="发送消息给 SuoCode"]'))`,
      "The desktop app did not initialize its private Home workspace.",
      45_000,
    );
    const hasConfiguredProvider = await client.evaluate(`(async () => {
      const configuration = await window.suocode.request({ type: "get_configuration" });
      return configuration.configuredProviders.length > 0;
    })()`);
    if (!hasConfiguredProvider) {
      await client.waitFor(`Boolean(document.querySelector('button[aria-label="关闭设置"]'))`, "The first-run model settings dialog did not open.");
      await client.evaluate(`document.querySelector('button[aria-label="关闭设置"]')?.click()`);
      await client.waitFor(`Boolean(document.querySelector('.conversation-pane'))`, "The workspace did not return after closing first-run settings.", 10_000);
    }
    const homeState = await client.evaluate(`(async () => {
      const home = await window.suocode.homeProject();
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
    if (process.platform === "darwin") {
      const nodeRuntimeLauncher = join(dirname(homeState.home.path), "agent", "runtime-bin", "node");
      const expectedHelper = join(
        repositoryRoot,
        "apps/desktop/release/mac-arm64/SuoCode.app/Contents/Frameworks/SuoCode Helper.app/Contents/MacOS/SuoCode Helper",
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
    await client.waitFor(`Boolean(document.querySelector(".model-provider-settings .settings-select")) || Boolean(document.querySelector(".model-provider-settings .settings-error"))`, "The Pi model provider settings did not finish loading.");
    const modelSettingsUi = await client.evaluate(`(() => ({
      nativeSelectCount: document.querySelectorAll(".model-provider-settings select").length,
      customSelectCount: document.querySelectorAll(".model-provider-settings .settings-select").length,
      headerDrag: document.querySelector(".settings-page-header")?.classList.contains("window-drag") === true,
      customProviderButton: Boolean(document.querySelector('[aria-label="添加自定义服务商"]')),
      error: document.querySelector(".model-provider-settings .settings-error")?.textContent || "",
    }))()`);
    assert.equal(modelSettingsUi.nativeSelectCount, 0, "Model settings still uses a native select menu.");
    assert.ok(modelSettingsUi.customSelectCount >= 1, `Model settings did not render the in-app selection controls: ${modelSettingsUi.error}`);
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
        && setValue('input[placeholder="https://api.example.com/v1"]', "http://127.0.0.1:40124/v1")
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
      const snapshot = await window.suocode.request({ type: "get_model_provider_configuration" });
      return snapshot.providers.some((provider) => provider.id === "desktop-smoke-provider" && provider.models.some((model) => model.id === "desktop-smoke-model"));
    })()`, "The custom provider entered through the settings UI was not persisted in Pi models.json.");
    const openedProtocolMenu = await client.evaluate(`(() => {
      const button = document.querySelector('.model-provider-settings button[aria-label="请求协议"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(openedProtocolMenu, true, "The custom Pi protocol selector did not open.");
    await client.waitFor(`Boolean(document.querySelector(".settings-select-popover"))`, "The in-app Pi protocol menu did not render.");
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
        runtime: (await window.suocode.request({ type: "get_mcp_configuration" })).servers.map((server) => server.name)
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
    const mcpSnapshot = await client.evaluate(`window.suocode.request({ type: "get_mcp_configuration" })`);
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
    const disabledMcpServer = await client.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="停用 MCP 服务器"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(disabledMcpServer, true, "The MCP adapter-native disable action was not exposed in settings.");
    await client.waitFor(
      `Boolean(document.querySelector('button[aria-label="启用 MCP 服务器"]'))`,
      "The MCP settings did not reflect the disabled project override.",
    );
    const disabledMcpSnapshot = await client.evaluate(`window.suocode.request({ type: "get_mcp_configuration", cwd: ${JSON.stringify(homeState.home.path)} })`);
    assert.equal(disabledMcpSnapshot.servers.find((server) => server.name === "desktop-smoke-mcp")?.disabled, true);
    const enabledMcpServer = await client.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="启用 MCP 服务器"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(enabledMcpServer, true, "The MCP adapter-native enable action was not exposed in settings.");
    await client.waitFor(
      `Boolean(document.querySelector('button[aria-label="停用 MCP 服务器"]'))`,
      "The MCP settings did not clear the disabled project override.",
    );
    const enabledMcpSnapshot = await client.evaluate(`window.suocode.request({ type: "get_mcp_configuration", cwd: ${JSON.stringify(homeState.home.path)} })`);
    assert.equal(enabledMcpSnapshot.servers.find((server) => server.name === "desktop-smoke-mcp")?.disabled, false);
    const rejectedUnsafeExternalUrl = await client.evaluate(`window.suocode.openExternal("file:///tmp/suocode-smoke").then(() => false, () => true)`);
    assert.equal(rejectedUnsafeExternalUrl, true, "The desktop external URL bridge accepted a non-HTTP URL.");
    await delay(900);
    const connectedMcpServer = await client.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="连接 MCP 服务器"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(connectedMcpServer, true, "The MCP extension connection action was not exposed in settings.");
    await client.waitFor(
      `Boolean(document.querySelector(".mcp-action-message")) || Boolean(document.querySelector(".mcp-editor .settings-error"))`,
      "The MCP extension connection action did not return diagnostics.",
    );
    const mcpConnectionState = await client.evaluate(`({
      diagnostics: document.querySelector(".mcp-action-message")?.textContent || document.querySelector(".mcp-editor .settings-error")?.textContent || "",
      ui: document.querySelector(".mcp-runtime-card")?.textContent || ""
    })`);
    assert.ok(mcpConnectionState.diagnostics, "The MCP adapter connection failure did not surface diagnostics.");
    assert.match(mcpConnectionState.ui, /连接失败|未连接|已缓存|已连接|需要认证|状态未知|初始化中|暂不可用/);
    const addedProjectMcp = await client.evaluate(`(async () => {
      document.querySelector(".mcp-add-button")?.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      const labels = [...document.querySelectorAll(".mcp-editor label")];
      const name = labels.find((label) => label.textContent.startsWith("名称"))?.querySelector("input");
      const command = labels.find((label) => label.textContent.startsWith("启动命令"))?.querySelector("input");
      const scope = labels.find((label) => label.textContent.startsWith("作用域"))?.querySelector("select");
      if (!name || !command || !scope) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(name, "desktop-smoke-mcp-project");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(command, "/usr/bin/true");
      command.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(scope, "project");
      scope.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      document.querySelector(".mcp-editor form")?.requestSubmit();
      return true;
    })()`);
    assert.equal(addedProjectMcp, true);
    await client.waitFor(
      `[...document.querySelectorAll(".mcp-server-list strong")].some((item) => item.textContent === "desktop-smoke-mcp-project") || Boolean(document.querySelector(".mcp-editor .settings-error"))`,
      "The project MCP server did not settle.",
    );
    const projectMcpSnapshot = await client.evaluate(`window.suocode.request({ type: "get_mcp_configuration", cwd: ${JSON.stringify(homeState.home.path)} })`);
    const projectMcp = projectMcpSnapshot.servers.find((server) => server.name === "desktop-smoke-mcp-project");
    assert.equal(projectMcp?.scope, "project");
    assert.equal(projectMcp?.source, projectMcpSnapshot.projectConfigPath);
    await client.evaluate(`(async () => {
      await window.suocode.request({ type: "remove_mcp_server", name: "desktop-smoke-mcp-project", scope: "project", cwd: ${JSON.stringify(homeState.home.path)} });
      await window.suocode.request({ type: "remove_mcp_server", name: "desktop-smoke-mcp", scope: "global", cwd: ${JSON.stringify(homeState.home.path)} });
    })()`);
    await client.evaluate(`document.querySelector('button[aria-label="关闭设置"]')?.click()`);

    const openedArchive = await client.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="归档会话"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(openedArchive, true);
    await client.waitFor(`Boolean(document.querySelector(".archive-popover"))`, "The archive restore popover did not open.");
    await client.waitFor(`document.querySelector(".archive-popover")?.textContent.includes("暂无归档会话")`, "The empty archive state did not render.");
    await client.evaluate(`document.querySelector('button[aria-label="归档会话"]')?.click()`);

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
    const emptyMetricState = await client.evaluate(`({
      summary: document.querySelector(".response-metrics")?.textContent || "",
      performance: Boolean(document.querySelector(".performance-trigger")),
      context: Boolean(document.querySelector(".context-trigger"))
    })`);
    assert.equal(emptyMetricState.summary, "");
    assert.equal(emptyMetricState.performance, false);
    assert.equal(emptyMetricState.context, true);
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
      if (!button) return { ok: false, reason: "missing-button" };
      const dragRegion = document.querySelector(".sidebar-drag-region");
      const buttonBounds = button.getBoundingClientRect();
      const dragBounds = dragRegion?.getBoundingClientRect();
      if (buttonBounds.width !== 50 || buttonBounds.height !== 50) return { ok: false, reason: "size", width: buttonBounds.width, height: buttonBounds.height };
      if (getComputedStyle(button).webkitAppRegion !== "no-drag") return { ok: false, reason: "drag-region" };
      if (dragBounds && buttonBounds.left < dragBounds.right) return { ok: false, reason: "overlap", buttonLeft: buttonBounds.left, dragRight: dragBounds.right };
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
    assert.equal(compactSidebarClosed?.ok, true, JSON.stringify(compactSidebarClosed));
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
      probe.innerHTML = '<details class="tool-activity"><summary><span>思考了 7 次，编辑了 1 个文件，查看了 2 个文件，搜索 1 次，运行了 4 个命令，调用了 3 个工具</span><svg class="tool-chevron" width="14"></svg></summary></details><div class="assistant-segment"><div class="markdown"><p>测试过程中的长中文内容必须在很窄的聊天窗口中正确换行而不能被右侧文件栏遮挡。<code>very-long-inline-token-without-natural-breaks-0123456789</code></p><div class="markdown-table-scroll"><table><tbody><tr><td style="min-width:480px">很宽的表格内容</td><td style="min-width:480px">继续横向滚动</td></tr></tbody></table></div></div></div>';
      body.append(probe);
      const summary = probe.querySelector(".tool-activity > summary");
      const summaryText = summary?.querySelector("span")?.getBoundingClientRect();
      const chevron = summary?.querySelector(".tool-chevron")?.getBoundingClientRect();
      const tableScroller = probe.querySelector(".markdown-table-scroll");
      const result = {
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
    assert.ok((narrowConversationLayout?.paddingBottom ?? 0) >= 175);
    assert.ok((narrowConversationLayout?.scrollWidth ?? 1) <= (narrowConversationLayout?.clientWidth ?? 0) + 1);
    assert.ok((narrowConversationLayout?.probeScrollWidth ?? 1) <= (narrowConversationLayout?.probeClientWidth ?? 0) + 1);
    assert.ok((narrowConversationLayout?.probeRight ?? 1) <= (narrowConversationLayout?.bodyRight ?? 0) + 1);
    assert.ok((narrowConversationLayout?.summaryGap ?? 999) <= 9);
    assert.equal(narrowConversationLayout?.tableScrollable, true);
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
      localStorage.setItem("suocode.mounted-projects", JSON.stringify([project]));
      localStorage.setItem("suocode.active-project", project.path);
      window.__suocodeSmokeReloading = true;
      location.reload();
      return true;
    })()`);
    await client.waitFor(`typeof window.__suocodeSmokeReloading === "undefined"`, "The packaged renderer did not finish the project reload.", 45_000);
    await dismissFirstRunSettings(client, !hasConfiguredProvider);
    await client.waitFor(
      `Boolean(document.querySelector('textarea[aria-label="发送消息给 SuoCode"]')) && [...document.querySelectorAll(".project-name")].some((item) => item.textContent === ${JSON.stringify(basename(projectDirectory))}) && Boolean(document.querySelector(".conversation-header"))`,
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
        textareaDisabled: document.querySelector('textarea[aria-label="发送消息给 SuoCode"]')?.disabled ?? true,
        conversationPane: Boolean(document.querySelector(".conversation-pane")),
        terminalPane: Boolean(document.querySelector(".terminal-workspace")),
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
      const textarea = document.querySelector('textarea[aria-label="发送消息给 SuoCode"]');
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
      localStorage.setItem("suocode.active-project", ${JSON.stringify(projectDirectory)});
      window.__suocodeSmokeReloading = true;
      location.reload();
    })()`);
    await client.waitFor(`typeof window.__suocodeSmokeReloading === "undefined"`, "The packaged renderer did not finish the temporary-session reload.", 45_000);
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
    const unknownFileFallback = await client.evaluate(`window.suocode.openFilePreview({ root: ${JSON.stringify(projectDirectory)}, path: "unknown-format.suocode-smoke" })`);
    assert.deepEqual(unknownFileFallback, { opened: false, actions: ["reveal", "force-text", "trash"] });
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await client.evaluate(`[...document.querySelectorAll(".file-tree-node > button")].find((item) => item.textContent.includes("lazy-folder"))?.click()`);
    await client.waitFor(
      `[...document.querySelectorAll(".file-leaf")].some((item) => item.textContent.includes("lazy-child.txt"))`,
      "The file tree did not load an expanded folder on demand.",
    );
    const fileContextMenu = await client.evaluate(`(async () => {
      const file = [...document.querySelectorAll(".file-leaf")].find((item) => item.textContent.includes("lazy-child.txt"));
      if (!file) return null;
      file.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 180, clientY: 180 }));
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      return [...document.querySelectorAll(".conversation-context-menu .conversation-context-item")].map((item) => item.textContent);
    })()`);
    assert.deepEqual(fileContextMenu, ["复制绝对路径", "复制相对路径", "在访达中显示", "移到废纸篓"]);
    await client.evaluate(`([...document.querySelectorAll(".conversation-context-menu .conversation-context-item")].find((item) => item.textContent === "复制绝对路径"))?.click()`);
    await delay(50);
    assert.equal(execFileSync("pbpaste", { encoding: "utf8" }).trim(), join(await realpath(projectDirectory), "lazy-folder", "lazy-child.txt"));
    await client.evaluate(`(() => {
      const file = [...document.querySelectorAll(".file-leaf")].find((item) => item.textContent.includes("lazy-child.txt"));
      file?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 180, clientY: 180 }));
    })()`);
    await client.waitFor(`[...document.querySelectorAll(".conversation-context-menu .conversation-context-item")].some((item) => item.textContent === "复制相对路径")`, "The relative-path context action did not reopen.");
    await client.evaluate(`([...document.querySelectorAll(".conversation-context-menu .conversation-context-item")].find((item) => item.textContent === "复制相对路径"))?.click()`);
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

    if (!live) {
      const fixtureToken = `DESKTOP_SUBAGENT_FIXTURE_${Date.now()}`;
      const fixtureSnapshot = await client.evaluate(`window.suocode.request({ type: "create_session", cwd: ${JSON.stringify(projectDirectory)} })`);
      const fixturePath = join(dirname(fixtureSnapshot.session.path), `desktop-subagent-${Date.now()}.jsonl`);
      const fixtureSession = { ...fixtureSnapshot, session: { ...fixtureSnapshot.session, id: `desktop-subagent-${Date.now()}`, path: fixturePath } };
      await writeFile(fixturePath, `${subagentFixtureEntries(fixtureSession, fixtureToken).map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      await client.evaluate(`(() => {
        localStorage.setItem("suocode.activeProject", ${JSON.stringify(projectDirectory)});
        window.__suocodeSmokeReloading = true;
        location.reload();
      })()`);
      await client.waitFor(`typeof window.__suocodeSmokeReloading === "undefined"`, "The packaged renderer did not finish the fixture-session reload.", 45_000);
      await dismissFirstRunSettings(client, !hasConfiguredProvider);
      await client.waitFor(
        `[...document.querySelectorAll(".conversation-row")].some((row) => row.textContent.includes(${JSON.stringify(fixtureToken)}))`,
        "The packaged sidebar did not discover the subagent fixture session.",
        60_000,
      );
      await client.evaluate(`[...document.querySelectorAll(".conversation-row")].find((row) => row.textContent.includes(${JSON.stringify(fixtureToken)}))?.click()`);
      await client.waitFor(`document.querySelectorAll(".user-bubble-button .message-image img").length === 1`, "The packaged renderer did not restore the historical image.", 60_000);
      await client.evaluate(`document.querySelector(".user-bubble-button")?.click()`);
      await client.waitFor(`Boolean(document.querySelector('textarea[aria-label="编辑历史消息"]'))`, "The historical message did not enter edit mode.");
      const historicalImageBeforePaste = await client.evaluate(`(() => {
        const editor = document.querySelector('textarea[aria-label="编辑历史消息"]');
        const before = document.querySelectorAll(".user-message-editor-shell .message-image img").length;
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (value) => value.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "history-paste.png", { type: "image/png" }));
        const dispatched = editor?.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer })) ?? false;
        return { before, files: transfer.files.length, dispatched };
      })()`);
      assert.deepEqual(historicalImageBeforePaste, { before: 1, files: 1, dispatched: false });
      await client.waitFor(`document.querySelectorAll(".user-message-editor-shell .message-image img").length === 2`, "The pasted historical image did not appear in the editor.");
      await client.evaluate(`document.querySelector('button[aria-label="移除历史图片"]')?.click()`);
      await client.waitFor(`document.querySelectorAll(".user-message-editor-shell .message-image img").length === 1`, "The historical image was not removed from the editor.");
      await client.evaluate(`document.querySelector(".conversation-header")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
      await client.waitFor(`!document.querySelector('textarea[aria-label="编辑历史消息"]') && document.querySelectorAll(".user-bubble-button .message-image img").length === 1`, "The edited historical image state did not return to the message bubble.");
      await client.waitFor(`Boolean(document.querySelector(".subagent-timeline-card"))`, "The packaged renderer did not restore the pi-subagents timeline card.", 60_000);
      const preservedProviderFailure = await client.evaluate(`({
        tool: Boolean(document.querySelector(".subagent-timeline-card")),
        error: [...document.querySelectorAll(".assistant-message.error")].some((item) => item.textContent.includes(${JSON.stringify(fixtureToken)}))
      })`);
      assert.deepEqual(preservedProviderFailure, { tool: true, error: true });
      const backdropCountBeforeDetail = await client.evaluate(`document.querySelectorAll(".modal-backdrop").length`);
      await client.evaluate(`document.querySelector(".subagent-timeline-card")?.click()`);
      await client.waitFor(`document.querySelector(".subagent-detail-window")?.textContent.includes(${JSON.stringify(fixtureToken)})`, "The packaged renderer did not show the structured subagent details.");
      const detailInteraction = await client.evaluate(`(async () => {
        const detail = document.querySelector(".subagent-detail-window");
        const header = detail?.querySelector(":scope > header");
        const before = detail?.getBoundingClientRect();
        if (!detail || !header || !before) return null;
        await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
        header.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: before.left + 30, clientY: before.top + 20 }));
        window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: before.left + 70, clientY: before.top + 55 }));
        window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
        const after = detail.getBoundingClientRect();
        return {
          moved: after.left > before.left + 20 && after.top > before.top + 20,
          backdropCount: document.querySelectorAll(".modal-backdrop").length,
          composerEnabled: !document.querySelector('textarea[aria-label="发送消息给 SuoCode"]')?.disabled,
        };
      })()`);
      assert.equal(detailInteraction?.moved, true, "The subagent detail window was not draggable.");
      assert.equal(detailInteraction?.backdropCount, backdropCountBeforeDetail, "The subagent detail window added a blocking backdrop to the Agent workspace.");
      assert.equal(detailInteraction?.composerEnabled, true, "The subagent detail window disabled the composer.");
      await client.evaluate(`document.querySelector('button[aria-label="关闭子 Agent 详情"]')?.click()`);
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
      assert.ok((overlayLayout?.gap ?? -1) >= 7, `The error banner overlapped the Agent activity panel (${overlayLayout?.gap}px).`);
    }

    if (live) {
      const openedLiveConversation = await client.evaluate(`(async () => {
        const configuration = await window.suocode.request({ type: "get_configuration" });
        const configured = configuration.models.filter((item) => item.configured);
        const model = configured.find((item) => {
          const identity = \`${'${item.provider} ${item.id} ${item.name}'}\`.toLowerCase();
          return identity.includes("minimax") && /(^|[^a-z0-9])m3([^a-z0-9]|$)/i.test(identity);
        })
          ?? configured.find((item) => item.provider === configuration.provider && item.id === "gpt-5.6-sol")
          ?? configured.find((item) => item.provider === configuration.provider && item.id === configuration.modelId)
          ?? configured[0];
        if (!model) throw new Error("No configured live GUI smoke model.");
        await window.suocode.request({ type: "configure_model", provider: model.provider, modelId: model.id, thinkingLevel: "low" });
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
        window.__suocodeSmokeEvents = [];
        window.__suocodeSmokeUnsubscribe?.();
        window.__suocodeSmokeUnsubscribe = window.suocode.onRuntimeEvent((event, runtimeId) => {
          window.__suocodeSmokeEvents.push({
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
      assert.match(String(historyEditInteraction?.warning ?? ""), /提示缓存命中率/);
      assert.equal(historyEditInteraction.retained, historyEditInteraction.edited);
      assert.match(historyEditInteraction.dialog, /工作区中已经产生的文件修改不会被恢复/);
      assert.equal(historyEditInteraction.editorAfterCancel, true);
      await client.evaluate(`document.querySelector(".conversation-header")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
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
      await submitPrompt(
        client,
        `You must call the subagent tool exactly once using the scout agent. Ask it to reply exactly ${subagentToken}. Do not call another tool. After it completes, reply exactly ${subagentToken}.`,
        "subagent",
        180_000,
      );
      await client.waitFor(`Boolean(document.querySelector(".subagent-timeline-card"))`, "The subagent extension result was not projected into the conversation timeline.");
      await client.evaluate(`document.querySelector(".subagent-timeline-card")?.click()`);
      await client.waitFor(`Boolean(document.querySelector(".subagent-detail-window"))`, "The non-blocking subagent detail window did not open.");
      const subagentDetail = await client.evaluate(`document.querySelector(".subagent-detail-window")?.textContent || ""`);
      if (!subagentDetail.includes(subagentToken)) {
        const sessions = await client.evaluate(`window.suocode.request({ type: "list_sessions", cwd: ${JSON.stringify(projectDirectory)} })`);
        const latestSession = sessions[0]?.path ? await readFile(sessions[0].path, "utf8").catch(() => "") : "";
        const subagentEvents = await client.evaluate(`window.__suocodeSmokeEvents?.filter((event) => event.type === "subagents_updated" || event.toolName === "subagent") ?? []`);
        throw new Error(`The subagent detail did not contain its final output.\nProjected events:\n${JSON.stringify(subagentEvents, null, 2)}\nPersisted session tail:\n${latestSession.split("\n").slice(-8).join("\n")}`);
      }
      await client.evaluate(`document.querySelector('button[aria-label="关闭子 Agent 详情"]')?.click()`);

      const stopEventStart = await client.evaluate(`window.__suocodeSmokeEvents?.length ?? 0`);
      assert.equal(await fillAndSubmitComposer(
        client,
        `Call the subagent tool exactly once with agent scout and async true. Give it this exact task: Run the bash command sleep 90, then reply exactly ${stoppedSubagentToken}. Do not call subagent_wait, status, or another tool. After the background run starts, reply briefly that it started.`,
      ), true);
      await client.waitFor(
        `window.__suocodeSmokeEvents?.slice(${stopEventStart}).some((event) => event.type === "subagents_updated" && event.subagents?.some((item) => item.background && (item.status === "pending" || item.status === "running")))`,
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
      await client.evaluate(`(() => {
        const tab = [...document.querySelectorAll('.composer-activity-tabs button')].find((button) => button.textContent.includes('代理'));
        tab?.click();
      })()`);
      await client.waitFor(`Boolean(document.querySelector('.subagent-stop'))`, "The Agent activity panel did not expose the background stop control.");
      assert.equal(await client.evaluate(`(() => {
        const button = document.querySelector('.subagent-stop');
        if (!button) return false;
        button.click();
        return true;
      })()`), true);
      await client.waitFor(
        `window.__suocodeSmokeEvents?.slice(${stopEventStart}).some((event) => event.type === "subagents_updated" && event.subagents?.some((item) => item.background && item.status === "stopped"))`,
        "The background subagent did not transition to stopped after the UI control was clicked.",
        60_000,
      );
      await client.waitFor(
        `window.__suocodeSmokeEvents?.slice(${stopEventStart}).some((event) => event.type === "run_state" && event.running === false)`,
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

      await client.evaluate(`window.__suocodeSmokeReloading = true`);
      await client.send("Page.reload", { ignoreCache: true });
      await client.waitFor(`typeof window.__suocodeSmokeReloading === "undefined"`, "The packaged renderer did not finish the final reload.", 45_000);
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
