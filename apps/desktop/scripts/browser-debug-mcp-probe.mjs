import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const [endpoint, token] = process.argv.slice(2);
if (!endpoint || !token) throw new Error("usage: browser-debug-mcp-probe.mjs <endpoint> <token>");

const fixtureServer = createServer((request, response) => {
  if (request.url === "/api/value") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ source: "fixture" }));
    return;
  }
  if (request.url === "/api/body") {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("suocode-network-body");
    return;
  }
  if (request.url === "/download") {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("content-disposition", "attachment; filename=suocode-download.txt");
    response.end("suocode-download-ready");
    return;
  }
  if (request.url === "/sw.js") {
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end("self.addEventListener('fetch', () => {});");
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>SuoCode Debug Probe</title><script>
    localStorage.setItem('debug-probe','ready');
    window.fixtureReady = Promise.all([
      new Promise((resolve, reject) => {
        const open = indexedDB.open('debug-db', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('items', { keyPath: 'id' });
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('items', 'readwrite');
          tx.objectStore('items').put({ id: 1, value: 'ready' });
          tx.oncomplete = () => { open.result.close(); resolve(true); };
          tx.onerror = () => reject(tx.error);
        };
      }),
      caches.open('debug-cache').then((cache) => cache.put('/cached', new Response('cached-ready'))),
      navigator.serviceWorker.register('/sw.js'),
    ]).then(() => true);
  </script><button>Probe</button>`);
});
const webSocketServer = new WebSocketServer({ noServer: true });
fixtureServer.on("upgrade", (request, socket, head) => {
  if (request.url !== "/socket") return socket.destroy();
  webSocketServer.handleUpgrade(request, socket, head, (connection) => webSocketServer.emit("connection", connection, request));
});
webSocketServer.on("connection", (connection) => {
  connection.on("message", (value) => connection.send(`echo:${value.toString()}`));
});
await new Promise((resolvePromise, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(0, "127.0.0.1", resolvePromise);
});
const address = fixtureServer.address();
if (!address || typeof address === "string") throw new Error("failed to start fixture server");
const fixtureOrigin = `http://127.0.0.1:${address.port}`;
const outputDir = mkdtempSync(join(tmpdir(), "suocode-browser-debug-"));
const desktopDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const rawSocket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` } });
await new Promise((resolvePromise, reject) => {
  rawSocket.once("open", resolvePromise);
  rawSocket.once("error", reject);
});
let rawNextId = 0;
const rawPending = new Map();
rawSocket.on("message", (data) => {
  const message = JSON.parse(data.toString());
  const waiter = rawPending.get(message.id);
  if (!waiter) return;
  rawPending.delete(message.id);
  message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
});
const rawCommand = (method, params = {}, sessionId) => new Promise((resolvePromise, reject) => {
  const id = ++rawNextId;
  const timer = setTimeout(() => {
    rawPending.delete(id);
    reject(new Error(`raw CDP timeout: ${method}`));
  }, 30_000);
  rawPending.set(id, {
    resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
    reject: (error) => { clearTimeout(timer); reject(error); },
  });
  rawSocket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const state = await rawCommand("SuoCode.getBrowserState");
const attached = await rawCommand("Target.attachToTarget", { targetId: state.activePageTargetId, flatten: true });
const rawSession = attached.sessionId;

const mcpProcess = spawn(process.execPath, [join(desktopDir, "out/main/browser-debug-mcp.js")], {
  cwd: desktopDir,
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    SUOCODE_BROWSER_DEBUG_CDP_ENDPOINT: endpoint,
    SUOCODE_BROWSER_DEBUG_CDP_TOKEN: token,
    SUOCODE_BROWSER_DEBUG_OUTPUT_DIR: outputDir,
  },
});
let nextId = 0;
const pending = new Map();
createInterface({ input: mcpProcess.stdout }).on("line", (line) => {
  const value = JSON.parse(line);
  const waiter = pending.get(value.id);
  if (!waiter) return;
  pending.delete(value.id);
  value.error ? waiter.reject(new Error(value.error.message)) : waiter.resolve(value.result);
});
const request = (method, params, timeout = 30_000) => new Promise((resolvePromise, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method}${params?.name ? `:${params.name}` : ""} timeout`));
  }, timeout);
  pending.set(id, {
    resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
    reject: (error) => { clearTimeout(timer); reject(error); },
  });
  mcpProcess.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const notify = (method, params) => mcpProcess.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
const call = async (name, args = {}, timeout) => {
  const response = await request("tools/call", { name, arguments: args }, timeout);
  if (response.isError) throw new Error(response.content?.map((item) => item.text).join("\n") || `${name} failed`);
  return response.content?.map((item) => item.text).join("\n") || "";
};

try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "suocode-browser-debug-probe", version: "1" } });
  notify("notifications/initialized", {});
  const tools = await request("tools/list", {});
  const required = [
    "browser_debugger_enable",
    "browser_debugger_control",
    "browser_debugger_call_stack",
    "browser_network_interception",
    "browser_network_paused",
    "browser_network_resolve",
    "browser_network_recording",
    "browser_application_storage",
    "browser_network_body",
    "browser_websocket_frames",
    "browser_downloads",
    "browser_coverage",
  ];
  const names = new Set(tools.tools.map((tool) => tool.name));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);

  await rawCommand("Page.enable", {}, rawSession);
  await rawCommand("Page.navigate", { url: fixtureOrigin }, rawSession);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  await rawCommand("Runtime.evaluate", { expression: "window.fixtureReady", awaitPromise: true, returnByValue: true }, rawSession);

  await call("browser_debugger_enable");
  await call("browser_debugger_control", { action: "pause", column: 1 });
  const pausedEvaluation = rawCommand("Runtime.evaluate", { expression: "(() => 40 + 2)()", returnByValue: true }, rawSession);
  const paused = await call("browser_wait_for_event", { methods: ["Debugger.paused"], timeoutMs: 10_000, sinceSequence: 0 });
  const stack = await call("browser_debugger_call_stack");
  await call("browser_debugger_control", { action: "resume", column: 1 });
  await pausedEvaluation;

  await call("browser_network_recording", { action: "start" });
  await call("browser_network_interception", { action: "enable", patterns: [{ urlPattern: "*api/value*", requestStage: "Request" }] });
  const fetchPromise = rawCommand("Runtime.evaluate", {
    expression: `fetch('${fixtureOrigin}/api/value').then(r => r.json())`,
    awaitPromise: true,
    returnByValue: true,
  }, rawSession);
  const requestPaused = JSON.parse(await call("browser_wait_for_event", { methods: ["Fetch.requestPaused"], timeoutMs: 10_000, sinceSequence: 0 }));
  await call("browser_network_resolve", {
    requestId: requestPaused.params.requestId,
    action: "fulfill",
    responseCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "suocode-debugger" }),
    errorReason: "Failed",
  });
  const fetched = await fetchPromise;
  await call("browser_network_interception", { action: "disable", handleAuthRequests: false });
  const bodyFetch = rawCommand("Runtime.evaluate", {
    expression: `fetch('${fixtureOrigin}/api/body').then(r => r.text())`,
    awaitPromise: true,
    returnByValue: true,
  }, rawSession);
  const bodyResponse = JSON.parse(await call("browser_wait_for_event", {
    methods: ["Network.responseReceived"],
    text: "/api/body",
    timeoutMs: 10_000,
    sinceSequence: 0,
  }));
  await call("browser_wait_for_event", {
    methods: ["Network.loadingFinished"],
    text: bodyResponse.params.requestId,
    timeoutMs: 10_000,
    sinceSequence: bodyResponse.sequence,
  });
  await bodyFetch;
  const body = JSON.parse(await call("browser_network_body", { requestId: bodyResponse.params.requestId }));

  const socketEvaluation = rawCommand("Runtime.evaluate", {
    expression: `new Promise((resolve, reject) => { const ws = new WebSocket('${fixtureOrigin.replace("http", "ws")}/socket'); ws.onopen = () => ws.send('probe-message'); ws.onmessage = (event) => { resolve(event.data); ws.close(); }; ws.onerror = reject; })`,
    awaitPromise: true,
    returnByValue: true,
  }, rawSession);
  await call("browser_wait_for_event", { methods: ["Network.webSocketFrameReceived"], text: "probe-message", timeoutMs: 10_000, sinceSequence: 0 });
  const socketValue = await socketEvaluation;
  const frames = JSON.parse(await call("browser_websocket_frames", { text: "probe-message", sinceSequence: 0, limit: 20 }));

  await call("browser_downloads", { action: "enable", downloadPath: join(outputDir, "downloads"), timeoutMs: 10_000 });
  await rawCommand("Runtime.evaluate", {
    expression: `(() => { const a = document.createElement('a'); a.href = '${fixtureOrigin}/download'; a.download = 'suocode-download.txt'; document.body.append(a); a.click(); a.remove(); })()`,
    returnByValue: true,
  }, rawSession);
  const download = JSON.parse(await call("browser_downloads", { action: "wait", timeoutMs: 10_000 }));
  const downloads = JSON.parse(await call("browser_downloads", { action: "list", timeoutMs: 10_000 }));

  const har = await call("browser_network_recording", { action: "export_har" });
  const storage = await call("browser_application_storage", { action: "usage", indexName: "", skipCount: 0, pageSize: 100, storageTypes: "all" });
  const indexedDb = JSON.parse(await call("browser_application_storage", { action: "indexeddb_databases", indexName: "", skipCount: 0, pageSize: 100, storageTypes: "all" }));
  const caches = JSON.parse(await call("browser_application_storage", { action: "cache_names", indexName: "", skipCount: 0, pageSize: 100, storageTypes: "all" }));
  const serviceWorkers = JSON.parse(await call("browser_application_storage", { action: "service_workers", indexName: "", skipCount: 0, pageSize: 100, storageTypes: "all" }));
  await call("browser_coverage", { action: "start", maxEntries: 20 });
  await rawCommand("Runtime.evaluate", { expression: "(() => document.title.length)()", returnByValue: true }, rawSession);
  const coverage = await call("browser_coverage", { action: "stop", maxEntries: 20 });

  process.stdout.write(`${JSON.stringify({
    toolCount: tools.tools.length,
    paused: JSON.parse(paused).method,
    callStack: JSON.parse(stack).paused,
    mockedFetch: fetched.result?.value,
    har: JSON.parse(har),
    networkBody: body.body,
    webSocket: { value: socketValue.result?.value, frames: frames.length, url: frames.find((event) => event.url)?.url },
    download: { event: download.method, events: downloads.length },
    storageOrigin: JSON.parse(storage).usageBreakdown !== undefined,
    indexedDb: indexedDb.databaseNames?.includes("debug-db") === true,
    cacheStorage: caches.caches?.some((cache) => cache.cacheName === "debug-cache") === true,
    serviceWorkers: serviceWorkers.length,
    coverageScripts: JSON.parse(coverage).scripts.length,
  }, null, 2)}\n`);
} finally {
  mcpProcess.stdin.end();
  setTimeout(() => mcpProcess.kill("SIGTERM"), 300).unref();
  rawSocket.close();
  webSocketServer.close();
  fixtureServer.close();
}
