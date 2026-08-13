import { spawn } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";

const [endpoint, token] = process.argv.slice(2);
if (!endpoint || !token) throw new Error("usage: chrome-mcp-probe.mjs <endpoint> <token>");
const server = spawn(process.execPath, [
  new URL("../../../node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js", import.meta.url).pathname,
  "--wsEndpoint", endpoint,
  "--wsHeaders", JSON.stringify({ Authorization: `Bearer ${token}` }),
  "--allow-unrestricted-paths",
  "--no-usage-statistics",
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

try {
  process.stderr.write("[probe] initialize\n");
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "suocode-probe", version: "1" } });
  notify("notifications/initialized", {});
  process.stderr.write("[probe] tools/list\n");
  const tools = await request("tools/list", {});
  process.stderr.write("[probe] list_pages\n");
  const before = await request("tools/call", { name: "list_pages", arguments: {} });
  process.stderr.write("[probe] new_page\n");
  const newPage = await request("tools/call", { name: "new_page", arguments: { url: "https://example.com", timeout: 20_000 } }, 30_000);
  process.stderr.write("[probe] resize_page\n");
  const resize = await request("tools/call", { name: "resize_page", arguments: { width: 1024, height: 768 } });
  process.stderr.write("[probe] navigate_page\n");
  const navigation = await request("tools/call", { name: "navigate_page", arguments: { type: "url", url: "https://example.com" } });
  process.stderr.write("[probe] take_snapshot\n");
  const snapshot = await request("tools/call", { name: "take_snapshot", arguments: {} });
  process.stderr.write("[probe] evaluate_script\n");
  const evaluation = await request("tools/call", { name: "evaluate_script", arguments: { function: "() => ({ title: document.title, href: location.href })" } });
  process.stderr.write("[probe] take_screenshot\n");
  const screenshot = await request("tools/call", { name: "take_screenshot", arguments: { format: "png" } });
  process.stderr.write("[probe] click\n");
  const click = await request("tools/call", { name: "click", arguments: { uid: "1_3" } });
  let heap;
  let heapBytes;
  if (process.env.SUOCODE_PROBE_HEAP === "1") {
    const heapPath = `/tmp/suocode-browser-probe-${process.pid}.heapsnapshot`;
    process.stderr.write("[probe] take_heapsnapshot\n");
    heap = await request("tools/call", { name: "take_heapsnapshot", arguments: { filePath: heapPath } }, 180_000);
    heapBytes = (await stat(heapPath)).size;
    await unlink(heapPath);
  }
  let lighthouse;
  if (process.env.SUOCODE_PROBE_LIGHTHOUSE === "1") {
    process.stderr.write("[probe] lighthouse_audit\n");
    lighthouse = await request("tools/call", {
      name: "lighthouse_audit",
      arguments: { mode: "snapshot", device: "desktop" },
    }, 180_000);
  }
  const summary = (result) => result.content?.map((item) => item.type === "text"
    ? { type: item.type, text: item.text.slice(0, 1_000) }
    : { type: item.type, mimeType: item.mimeType, bytes: item.data?.length ?? item.blob?.length ?? 0, keys: Object.keys(item) });
  process.stdout.write(`${JSON.stringify({
    toolCount: tools.tools.length,
    before: summary(before),
    newPage: summary(newPage),
    resize: summary(resize),
    navigation: summary(navigation),
    snapshot: summary(snapshot),
    evaluation: summary(evaluation),
    screenshot: summary(screenshot),
    click: summary(click),
    heap: summary(heap),
    heapBytes,
    lighthouse: summary(lighthouse),
  }, null, 2)}\n`);
} finally {
  server.stdin.end();
  setTimeout(() => server.kill("SIGTERM"), 1000).unref();
}
