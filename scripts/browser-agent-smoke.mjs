import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const appBinary = join(repositoryRoot, "apps/desktop/release/mac-arm64/SuoCode.app/Contents/MacOS/SuoCode");
const sourceDataDirectory = join(homedir(), "Library/Application Support/@suocode/desktop");

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (typeof address !== "object" || !address?.port) throw new Error("Unable to reserve a local port.");
  return address.port;
}

async function waitForPage(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
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
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", () => rejectOpen(new Error("DevTools WebSocket failed.")), { once: true });
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
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || "Renderer evaluation failed.");
    return response.result.value;
  }

  async waitFor(expression, message, timeout = 180_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (await this.evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(message);
  }

  close() {
    this.socket.close();
  }
}

async function copyPrivateRuntime(targetDirectory) {
  await mkdir(targetDirectory, { recursive: true });
  for (const name of ["agent", "models.json", "auth.json"]) {
    await cp(join(sourceDataDirectory, name), join(targetDirectory, name), { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "suocode-browser-agent-"));
  const dataDirectory = join(temporaryRoot, "data");
  const projectDirectory = join(temporaryRoot, "project");
  await copyPrivateRuntime(dataDirectory);
  await mkdir(projectDirectory, { recursive: true });

  const fixtureServer = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>SuoCode browser agent fixture</title><h1>Browser agent fixture</h1>");
  });
  await new Promise((resolveListen, rejectListen) => {
    fixtureServer.once("error", rejectListen);
    fixtureServer.listen(0, "127.0.0.1", resolveListen);
  });
  const fixtureAddress = fixtureServer.address();
  if (!fixtureAddress || typeof fixtureAddress === "string") throw new Error("Browser fixture did not bind a port.");
  const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;

  const port = await freePort();
  const child = spawn(appBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${dataDirectory}`], {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  let client;
  try {
    const page = await waitForPage(port);
    client = new DevToolsClient(page.webSocketDebuggerUrl);
    await client.open();
    const setup = await client.evaluate(`(async () => {
      const configuration = await window.suocode.request({ type: "get_configuration" });
      const model = configuration.models.find((item) => item.configured && item.provider === "xai" && item.id === "grok-4.5")
        ?? configuration.models.find((item) => item.configured && item.provider === "ka" && item.id === "claude-sonnet-5")
        ?? configuration.models.find((item) => item.configured && item.provider === "ka" && item.id === "claude-haiku-4-5-20251001")
        ?? configuration.models.find((item) => item.configured && item.provider === "pierce" && item.id === "claude-opus-5")
        ?? configuration.models.find((item) => item.configured && item.provider === "pierce" && /gpt[- ]?5\.6[- ]?sol/i.test(\`${'${item.id} ${item.name}'}\`))
        ?? configuration.models.find((item) => item.configured && item.provider === configuration.provider && item.id === configuration.modelId)
        ?? configuration.models.find((item) => item.configured && /minimax.*m3|m3.*minimax/i.test(\`${'${item.provider} ${item.id} ${item.name}'}\`))
        ?? configuration.models.find((item) => item.configured);
      if (!model) return { error: "No configured model" };
      const snapshot = await window.suocode.request({ type: "create_session", cwd: ${JSON.stringify(projectDirectory)} });
      await window.suocode.request({ type: "set_session_model", provider: model.provider, modelId: model.id, thinkingLevel: "low" }, snapshot.runtimeId);
      await window.suocode.createBrowserTab(snapshot.runtimeId, ${JSON.stringify(fixtureUrl)});
      window.__browserAgentEvents = [];
      window.__browserAgentUnsubscribe?.();
      window.__browserAgentUnsubscribe = window.suocode.onRuntimeEvent((event, runtimeId) => {
        if (runtimeId !== snapshot.runtimeId) return;
        window.__browserAgentEvents.push({
          type: event.type,
          running: event.type === "run_state" ? event.running : undefined,
          toolName: event.type === "tool_started" || event.type === "tool_finished" ? event.tool.name : undefined,
          toolOutput: event.type === "tool_finished" ? event.tool.output : undefined,
          messageText: event.type === "message_finished" ? event.message.text : undefined,
          message: event.type === "runtime_error" ? event.message : undefined,
        });
      });
      return { runtimeId: snapshot.runtimeId, model: { provider: model.provider, id: model.id } };
    })()`);
    if (setup.error) throw new Error(setup.error);
    await client.evaluate(`window.suocode.request({
      type: "prompt",
      text: ${JSON.stringify(`Use the MCP gateway to search for the hidden tool browser_application_storage. Then call that hidden tool exactly once with action "usage" and origin "${fixtureUrl.slice(0, -1)}". Do not use a direct browser tool and do not merely describe the schema. After the tool succeeds, reply exactly BROWSER_PROGRESSIVE_DISCLOSURE_OK.`)}
    }, ${JSON.stringify(setup.runtimeId)})`);
    await client.waitFor(
      `window.__browserAgentEvents.some((event) => event.type === "run_state" && event.running === false)`,
      "The browser Agent request did not settle.",
    );
    const events = await client.evaluate("window.__browserAgentEvents");
    diagnostics = JSON.stringify(events, null, 2);
    const mcpResults = events.filter((event) => event.type === "tool_finished" && event.toolName === "mcp");
    assert.ok(mcpResults.some((event) => String(event.toolOutput).includes("browser_application_storage")), "The Agent did not discover the hidden browser tool through MCP search.");
    assert.ok(mcpResults.some((event) => /quota|usage/i.test(String(event.toolOutput))), "The Agent did not execute the discovered browser storage tool.");
    assert.equal(events.some((event) => event.toolName === "browser_application_storage"), false, "A hidden advanced browser tool leaked onto the direct tool surface.");
    process.stdout.write(`SuoCode browser Agent progressive-disclosure smoke passed with ${setup.model.provider}/${setup.model.id}.\n`);
  } catch (error) {
    throw new Error(`${error.stack || error.message}\nRuntime events:\n${diagnostics || "<unavailable>"}\nElectron stderr tail:\n${stderr.split("\n").slice(-30).join("\n")}`);
  } finally {
    client?.close();
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(3_000)]);
    await new Promise((resolveClose) => fixtureServer.close(resolveClose));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
