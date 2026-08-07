import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appBinary = join(repositoryRoot, "apps/desktop/release/mac-arm64/SuoCode.app/Contents/MacOS/SuoCode");

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function pageFor(port) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
    const page = pages.find((entry) => entry.type === "page" && entry.title === "SuoCode");
    if (page?.webSocketDebuggerUrl) return page;
    await delay(100);
  }
  throw new Error("SuoCode renderer did not start.");
}

class Client {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
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
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Renderer evaluation failed.");
    return result.result.value;
  }
  async waitFor(expression, message, timeout = 30_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (await this.evaluate(`(async () => { try { return Boolean(${expression}); } catch { return false; } })()`)) return;
      await delay(100);
    }
    throw new Error(message);
  }
  close() { this.socket.close(); }
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(5_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Terminal Desktop smoke currently targets the macOS bundle.");
  const userData = await mkdtemp(join(tmpdir(), "suocode-terminal-smoke-"));
  const port = await freePort();
  const logs = [];
  const child = spawn(appBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    cwd: repositoryRoot,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  let client;
  try {
    const page = await pageFor(port);
    client = new Client(page.webSocketDebuggerUrl);
    await client.open();
    await client.waitFor(`typeof window.suocode === "object" && document.querySelector(".project-name")?.textContent === "Home"`, "SuoCode did not initialize Home.", 45_000);
    const shell = await client.evaluate(`(async () => {
      window.__terminalSmoke = [];
      window.suocode.onTerminalEvent((event) => window.__terminalSmoke.push(event));
      const home = await window.suocode.homeProject();
      const terminal = await window.suocode.createTerminal({ cwd: home.path, kind: "shell", cols: 90, rows: 24 });
      await window.suocode.resizeTerminal(terminal.id, 100, 28);
      await window.suocode.writeTerminal(terminal.id, "printf 'suocode-terminal-smoke\\\\n'\\r");
      return terminal;
    })()`);
    assert.equal(shell.kind, "shell");
    assert.equal(shell.running, true);
    await client.waitFor(`window.__terminalSmoke.some((event) => event.type === "data" && event.id === ${JSON.stringify(shell.id)} && event.data.includes("suocode-terminal-smoke"))`, "Shell PTY did not stream output.");
    const buffered = await client.evaluate(`(async () => (await window.suocode.listTerminals()).find((item) => item.id === ${JSON.stringify(shell.id)}))()`);
    assert.match(buffered.buffer, /suocode-terminal-smoke/);
    await client.evaluate(`window.suocode.closeTerminal(${JSON.stringify(shell.id)})`);
    await client.waitFor(`(await window.suocode.listTerminals()).every((item) => item.id !== ${JSON.stringify(shell.id)})`, "Closed shell terminal remained registered.");

    const clicked = await client.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="在 Home 中打开终端"]');
      button?.click();
      return Boolean(button);
    })()`);
    assert.equal(clicked, true);
    await client.waitFor(`Boolean(document.querySelector(".terminal-workspace") && document.querySelector(".terminal-surface.active .xterm"))`, "Terminal workspace UI did not mount.");
    assert.equal(await client.evaluate(`document.querySelector(".terminal-workspace-title")?.textContent`), "终端Home");

    for (const kind of ["claude", "codex"]) {
      const external = await client.evaluate(`(async () => {
        const home = await window.suocode.homeProject();
        return window.suocode.createTerminal({ cwd: home.path, kind: ${JSON.stringify(kind)}, cols: 90, rows: 24 });
      })()`);
      await delay(1_000);
      const externalState = await client.evaluate(`(async () => (await window.suocode.listTerminals()).find((item) => item.id === ${JSON.stringify(external.id)}))()`);
      assert.equal(externalState.running, true, `${kind} did not stay attached to its PTY: ${externalState.buffer}`);
      assert.doesNotMatch(externalState.buffer, /command not found|not recognized/i);
      await client.evaluate(`window.suocode.closeTerminal(${JSON.stringify(external.id)})`);
    }

    const pi = await client.evaluate(`(async () => {
      const home = await window.suocode.homeProject();
      return window.suocode.createTerminal({ cwd: home.path, kind: "pi", cols: 90, rows: 24 });
    })()`);
    await delay(2_000);
    const piState = await client.evaluate(`(async () => (await window.suocode.listTerminals()).find((item) => item.id === ${JSON.stringify(pi.id)}))()`);
    assert.equal(piState.kind, "pi");
    assert.equal(piState.running, true, `Bundled Pi exited early: ${piState.buffer}`);
    assert.doesNotMatch(piState.buffer, /Failed to load extension|workflow failed/i);
    await client.evaluate(`window.suocode.closeTerminal(${JSON.stringify(pi.id)})`);
    process.stdout.write("SuoCode Terminal Desktop smoke passed.\n");
  } catch (error) {
    if (logs.length) process.stderr.write(`\nPackaged application logs:\n${logs.join("")}\n`);
    throw error;
  } finally {
    client?.close();
    await stop(child);
    await delay(250);
    await rm(userData, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
