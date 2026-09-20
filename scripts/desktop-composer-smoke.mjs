import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const appBinary = join(repositoryRoot, "apps/desktop/release/mac-arm64/CoilCoil.app/Contents/MacOS/CoilCoil");
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

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

async function finishOnboarding(client) {
  for (let step = 0; step < 5; step += 1) {
    if (!(await client.evaluate(`Boolean(document.querySelector(".onboarding-screen"))`))) return;
    const advanced = await client.evaluate(`(() => {
      const skip = document.querySelector(".onboarding-skip:not(:disabled)");
      const next = document.querySelector(".onboarding-next:not(:disabled)");
      (skip || next)?.click();
      return Boolean(skip || next);
    })()`);
    if (!advanced) throw new Error("The onboarding screen did not offer a way to continue.");
    await delay(120);
  }
  throw new Error("The onboarding screen did not finish.");
}

async function setComposer(client, text) {
  const result = await client.evaluate(`(() => {
    const editor = document.querySelector('[contenteditable="true"][aria-label="发送消息给 CoilCoil"]');
    if (!editor) return null;
    editor.focus();
    editor.replaceChildren(document.createTextNode(${JSON.stringify(text)}));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)} }));
    return { text: editor.textContent, html: editor.innerHTML };
  })()`);
  assert.ok(result, "Composer did not render.");
  await delay(100);
  return result;
}

async function checkChineseComposition(client) {
  const preedit = await client.evaluate(`(() => {
    const editor = document.querySelector('[contenteditable="true"][aria-label="发送消息给 CoilCoil"]');
    if (!editor) return null;
    editor.focus();
    editor.replaceChildren(document.createTextNode("nihao"));
    const preeditNode = editor.firstChild;
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "n" }));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "nihao", isComposing: true }));
    return { text: editor.textContent, sameNodeBeforeCommit: editor.firstChild === preeditNode };
  })()`);
  assert.deepEqual(preedit, { text: "nihao", sameNodeBeforeCommit: true });
  await delay(100);
  const untouched = await client.evaluate(`(() => {
    const editor = document.querySelector('[contenteditable="true"][aria-label="发送消息给 CoilCoil"]');
    return { editor: Boolean(editor), text: editor?.textContent ?? null, html: editor?.innerHTML ?? null };
  })()`);
  assert.deepEqual({ text: untouched.text, html: untouched.html }, { text: "nihao", html: "nihao" }, "IME preedit was committed or rebuilt before composition ended.");

  const committed = await client.evaluate(`(() => {
    const editor = document.querySelector('[contenteditable="true"][aria-label="发送消息给 CoilCoil"]');
    if (!editor) return null;
    editor.replaceChildren(document.createTextNode("你好"));
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "你好", isComposing: false }));
    return { text: editor.textContent, html: editor.innerHTML };
  })()`);
  await delay(100);
  const finalValue = await client.evaluate(`(() => {
    const editor = document.querySelector('[contenteditable="true"][aria-label="发送消息给 CoilCoil"]');
    return editor ? { text: editor.textContent, html: editor.innerHTML } : null;
  })()`);
  assert.deepEqual(committed, { text: "你好", html: "你好" });
  assert.deepEqual(finalValue, { text: "你好", html: "你好" });
}

async function clickByText(client, selector, text) {
  const clicked = await client.evaluate(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((item) => item.textContent.includes(${JSON.stringify(text)}));
    target?.click();
    return Boolean(target);
  })()`);
  assert.equal(clicked, true, `Could not click ${text}.`);
}

async function main() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "coilcoil-composer-data-"));
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
    await client.waitFor(`document.readyState === "complete" && typeof window.coilcoil === "object"`, "Renderer did not become ready.");
    await finishOnboarding(client);
    await client.waitFor(
      `Boolean(document.querySelector('[contenteditable="true"][aria-label="发送消息给 CoilCoil"]')) || Boolean(document.querySelector('button[aria-label="返回工作区"]'))`,
      "Composer or first-run settings did not render.",
      45_000,
    );
    const configuredProvider = await client.evaluate(`(async () => {
      const configuration = await window.coilcoil.request({ type: "get_configuration" });
      return configuration.configuredProviders.length > 0;
    })()`);
    if (!configuredProvider) {
      await client.waitFor(`Boolean(document.querySelector('button[aria-label="返回工作区"]'))`, "The first-run model settings screen did not open.", 45_000);
      await client.evaluate(`document.querySelector('button[aria-label="返回工作区"]')?.click()`);
    }
    await client.waitFor(`Boolean(document.querySelector('[contenteditable="true"][aria-label="发送消息给 CoilCoil"]'))`, "Composer did not return.");

    const draft = "跨界面草稿不会丢";
    const first = await setComposer(client, draft);
    assert.equal(first.text, draft);
    assert.equal(first.html, draft, "Plain text must not duplicate when contentEditable is synchronized.");
    await checkChineseComposition(client);
    await setComposer(client, draft);

    await clickByText(client, ".nav-button", "记忆");
    await client.waitFor(`Boolean(document.querySelector(".memory-workspace"))`, "Memory workspace did not open.");
    await clickByText(client, ".memory-workspace button", "返回对话");
    await client.waitFor(`document.querySelector('[contenteditable="true"][aria-label="发送消息给 CoilCoil"]')?.textContent === ${JSON.stringify(draft)}`, "Draft was lost after switching to Memory and back.");

    await clickByText(client, ".nav-button", "技能");
    await client.waitFor(`Boolean(document.querySelector(".skills-workspace"))`, "Skills workspace did not open.");
    await clickByText(client, ".skills-workspace button", "返回对话");
    await client.waitFor(`document.querySelector('[contenteditable="true"][aria-label="发送消息给 CoilCoil"]')?.textContent === ${JSON.stringify(draft)}`, "Draft was lost after switching to Skills and back.");

    const finalEditor = await client.evaluate(`(() => {
      const editor = document.querySelector('[contenteditable="true"][aria-label="发送消息给 CoilCoil"]');
      return editor ? { text: editor.textContent, html: editor.innerHTML } : null;
    })()`);
    assert.deepEqual(finalEditor, { text: draft, html: draft });
    process.stdout.write("CoilCoil composer smoke passed: draft survived Memory/Skills navigation and plain text stayed atomic.\n");
  } finally {
    client?.close();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(2_000),
    ]);
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
