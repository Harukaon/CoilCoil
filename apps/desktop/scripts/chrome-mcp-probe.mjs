import { spawn } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const [endpoint, token] = process.argv.slice(2);
if (!endpoint || !token) throw new Error("usage: chrome-mcp-probe.mjs <endpoint> <token>");
const fixtureServer = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/interception.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Interception Fixture</title><h1>Interception Fixture</h1>");
    return;
  }
  if (pathname === "/api/mock") {
    response.writeHead(200, { "content-type": "application/json", "x-coilcoil-source": "real" });
    response.end(JSON.stringify({ source: "real" }));
    return;
  }
  response.writeHead(404);
  response.end("not found");
});
await new Promise((resolve, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(0, "127.0.0.1", () => {
    fixtureServer.off("error", reject);
    resolve();
  });
});
const fixtureAddress = fixtureServer.address();
if (!fixtureAddress || typeof fixtureAddress === "string") throw new Error("Failed to start the browser MCP fixture server");
const fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;
const server = spawn(process.execPath, [
  new URL("../../../node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js", import.meta.url).pathname,
  "--wsEndpoint", endpoint,
  "--wsHeaders", JSON.stringify({ Authorization: `Bearer ${token}` }),
  "--allow-unrestricted-paths",
  "--no-usage-statistics",
  "--no-performance-crux",
  "--experimentalStructuredContent",
  "--experimentalPageIdRouting",
], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" } });

let nextId = 0;
const pending = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    process.stderr.write(`[mcp] ${line}\n`);
    return;
  }
  const waiter = pending.get(value.id);
  if (waiter) { pending.delete(value.id); waiter(value); }
});
const request = (method, params, timeout = 20_000) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method}${params?.name ? `:${params.name}` : ""} 超时`));
  }, timeout);
  pending.set(id, (value) => {
    clearTimeout(timer);
    value.error ? reject(new Error(value.error.message)) : resolve(value.result);
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const notify = (method, params) => server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
const toolError = (name, result) => {
  if (!result?.isError) return result;
  const detail = result.content?.map((item) => item.type === "text" ? item.text : item.type).join("\n") || "unknown error";
  throw new Error(`${name} failed: ${detail}`);
};
const callTool = async (name, args = {}, timeout) => toolError(name, await request(
  "tools/call",
  { name, arguments: args },
  timeout,
));

try {
  process.stderr.write("[probe] initialize\n");
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "coilcoil-probe", version: "1" } });
  notify("notifications/initialized", {});
  process.stderr.write("[probe] tools/list\n");
  const tools = await request("tools/list", {});
  if (!tools.tools.some((tool) => tool.name === "intercept_network_request")) {
    throw new Error("intercept_network_request is missing from the Chrome DevTools MCP tool list");
  }
  process.stderr.write("[probe] list_pages\n");
  const before = await callTool("list_pages");
  process.stderr.write("[probe] new_page\n");
  const newPage = await callTool("new_page", { url: "https://example.com", timeout: 20_000 }, 30_000);
  const pageId = newPage.structuredContent?.pages?.find((page) => page.selected)?.id;
  if (typeof pageId !== "number") throw new Error("new_page did not return a structured selected page id");
  process.stderr.write("[probe] resize_page\n");
  const resize = await callTool("resize_page", { pageId, width: 1024, height: 768 });
  process.stderr.write("[probe] navigate_page\n");
  const navigation = await callTool("navigate_page", { pageId, type: "url", url: "https://example.com" });
  process.stderr.write("[probe] navigate_page reload\n");
  const reload = await callTool("navigate_page", { pageId, type: "reload", ignoreCache: true }, 30_000);
  process.stderr.write("[probe] list_pages after reload\n");
  const pagesAfterReload = await callTool("list_pages");
  process.stderr.write("[probe] emulate mobile viewport\n");
  const emulation = await callTool("emulate", { pageId, viewport: "390x844x3,mobile,touch" }, 30_000);
  process.stderr.write("[probe] take_snapshot\n");
  const snapshot = await callTool("take_snapshot", { pageId });
  process.stderr.write("[probe] wait_for string\n");
  const waitFor = await callTool("wait_for", { pageId, text: "Example Domain", timeout: 10_000 });
  process.stderr.write("[probe] evaluate_script\n");
  const evaluation = await callTool("evaluate_script", { pageId, function: "() => ({ title: document.title, href: location.href })" });
  process.stderr.write("[probe] get_network_request latest\n");
  const network = await callTool("get_network_request", { pageId });
  process.stderr.write("[probe] take_screenshot\n");
  const screenshot = await callTool("take_screenshot", { pageId, format: "png" });
  process.stderr.write("[probe] performance_stop_trace without trace\n");
  const noTrace = await request("tools/call", { name: "performance_stop_trace", arguments: { pageId } });
  if (!noTrace?.isError || !JSON.stringify(noTrace).includes("NO_ACTIVE_TRACE")) {
    throw new Error("performance_stop_trace did not return the expected NO_ACTIVE_TRACE error");
  }
  let heap;
  let heapBytes;
  if (process.env.COILCOIL_PROBE_HEAP === "1") {
    const heapPath = `/tmp/coilcoil-browser-probe-${process.pid}.heapsnapshot`;
    process.stderr.write("[probe] take_heapsnapshot\n");
    heap = await callTool("take_heapsnapshot", { pageId, filePath: heapPath }, 180_000);
    heapBytes = (await stat(heapPath)).size;
    await unlink(heapPath);
  }
  let lighthouse;
  if (process.env.COILCOIL_PROBE_LIGHTHOUSE === "1") {
    process.stderr.write("[probe] lighthouse_audit\n");
    lighthouse = await callTool("lighthouse_audit", { pageId, mode: "snapshot", device: "desktop" }, 180_000);
    if (!lighthouse.structuredContent?.lighthouseResult?.summary?.url) {
      throw new Error("lighthouse_audit returned no audited URL");
    }
  }
  process.stderr.write("[probe] request interception mock\n");
  const fixtureNavigation = await callTool("navigate_page", {
    pageId,
    type: "url",
    url: `${fixtureOrigin}/interception.html`,
  });
  const interceptionAdd = await callTool("intercept_network_request", {
    pageId,
    operation: "add",
    urlPattern: `${fixtureOrigin}/api/mock*`,
    requestMethod: "GET",
    resourceTypes: ["fetch"],
    behavior: "mock",
    response: {
      status: 201,
      contentType: "application/json",
      headers: { "x-coilcoil-source": "mock" },
      body: JSON.stringify({ source: "mock" }),
    },
  });
  const interceptionFetch = await callTool("evaluate_script", {
    pageId,
    function: "async () => { const response = await fetch('/api/mock'); return { status: response.status, source: response.headers.get('x-coilcoil-source'), body: await response.json() }; }",
  });
  if (!JSON.stringify(interceptionFetch).includes("mock") || !JSON.stringify(interceptionFetch).includes("201")) {
    throw new Error(`The intercepted request did not return the mock response: ${JSON.stringify(interceptionFetch)}`);
  }
  const interceptionRules = await callTool("intercept_network_request", { pageId, operation: "list" });
  const interceptionClear = await callTool("intercept_network_request", { pageId, operation: "clear" });
  const realFetch = await callTool("evaluate_script", {
    pageId,
    function: "async () => { const response = await fetch('/api/mock'); return { status: response.status, source: response.headers.get('x-coilcoil-source'), body: await response.json() }; }",
  });
  if (!JSON.stringify(realFetch).includes("real")) {
    throw new Error(`Clearing interception did not restore the real response: ${JSON.stringify(realFetch)}`);
  }
  process.stderr.write("[probe] close selected page then recover with list_pages\n");
  const closeSelected = await callTool("close_page", { pageId });
  const pagesAfterClose = await callTool("list_pages");
  const summary = (result) => result?.content?.map((item) => item.type === "text"
    ? { type: item.type, text: item.text.slice(0, 1_000) }
    : { type: item.type, mimeType: item.mimeType, bytes: item.data?.length ?? item.blob?.length ?? 0, keys: Object.keys(item) });
  process.stdout.write(`${JSON.stringify({
    toolCount: tools.tools.length,
    before: summary(before),
    newPage: summary(newPage),
    resize: summary(resize),
    navigation: summary(navigation),
    reload: summary(reload),
    pagesAfterReload: pagesAfterReload.structuredContent?.pages,
    emulation: emulation.structuredContent,
    snapshot: summary(snapshot),
    waitFor: summary(waitFor),
    evaluation: summary(evaluation),
    network: network.structuredContent?.networkRequest,
    screenshot: summary(screenshot),
    noTrace: summary(noTrace),
    heap: summary(heap),
    heapBytes,
    lighthouse: summary(lighthouse),
    fixtureNavigation: summary(fixtureNavigation),
    interceptionAdd: summary(interceptionAdd),
    interceptionFetch: summary(interceptionFetch),
    interceptionRules: summary(interceptionRules),
    interceptionClear: summary(interceptionClear),
    realFetch: summary(realFetch),
    closeSelected: summary(closeSelected),
    pagesAfterClose: pagesAfterClose.structuredContent?.pages,
  }, null, 2)}\n`);
} finally {
  server.stdin.end();
  setTimeout(() => server.kill("SIGTERM"), 1000).unref();
  await new Promise((resolve) => fixtureServer.close(resolve));
}
