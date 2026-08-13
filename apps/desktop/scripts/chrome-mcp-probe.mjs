import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [endpoint, token] = process.argv.slice(2);
if (!endpoint || !token) throw new Error("usage: chrome-mcp-probe.mjs <endpoint> <token>");
const server = spawn(process.execPath, [
  new URL("../../../node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js", import.meta.url).pathname,
  "--wsEndpoint", endpoint,
  "--wsHeaders", JSON.stringify({ Authorization: `Bearer ${token}` }),
  "--no-usage-statistics",
], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" } });

let nextId = 0;
const pending = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  const value = JSON.parse(line);
  const waiter = pending.get(value.id);
  if (waiter) { pending.delete(value.id); waiter(value); }
});
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method}${params?.name ? `:${params.name}` : ""} 超时`));
  }, 20_000);
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
  const summary = (result) => result.content?.map((item) => item.type === "text"
    ? { type: item.type, text: item.text.slice(0, 1_000) }
    : { type: item.type, mimeType: item.mimeType, bytes: item.data?.length ?? item.blob?.length ?? 0, keys: Object.keys(item) });
  process.stdout.write(`${JSON.stringify({
    toolCount: tools.tools.length,
    before: summary(before),
    navigation: summary(navigation),
    snapshot: summary(snapshot),
    evaluation: summary(evaluation),
    screenshot: summary(screenshot),
    click: summary(click),
  }, null, 2)}\n`);
} finally {
  server.stdin.end();
  setTimeout(() => server.kill("SIGTERM"), 1000).unref();
}
