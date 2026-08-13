import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";

const [endpoint, token] = process.argv.slice(2);
if (!endpoint || !token) throw new Error("usage: playwright-mcp-probe.mjs <endpoint> <token>");

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
const server = spawn(process.execPath, [
  cli,
  "--cdp-endpoint", endpoint,
  "--cdp-header", `Authorization: Bearer ${token}`,
  "--allow-unrestricted-file-access",
  "--output-dir", join(tmpdir(), `suocode-playwright-probe-${process.pid}`),
  "--caps", "vision,pdf,devtools",
  "--codegen", "none",
], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
});

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
  if (waiter) {
    pending.delete(value.id);
    waiter(value);
  }
});

const request = (method, params, timeout = 30_000) => new Promise((resolve, reject) => {
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
const text = (result) => result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n").slice(0, 4_000);

try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "suocode-playwright-probe", version: "1" } });
  notify("notifications/initialized", {});
  const tools = await request("tools/list", {});
  const tabsBefore = await request("tools/call", { name: "browser_tabs", arguments: { action: "list" } });
  const navigate = await request("tools/call", { name: "browser_navigate", arguments: { url: "data:text/html,<title>SuoCode Playwright</title><button>Continue</button>" } });
  const snapshot = await request("tools/call", { name: "browser_snapshot", arguments: {} });
  const find = await request("tools/call", { name: "browser_find", arguments: { text: "Continue" } });
  const tabsAfter = await request("tools/call", { name: "browser_tabs", arguments: { action: "new" } });
  const tabList = await request("tools/call", { name: "browser_tabs", arguments: { action: "list" } });
  process.stdout.write(`${JSON.stringify({
    toolCount: tools.tools.length,
    toolNames: tools.tools.map((tool) => tool.name),
    tabsBefore: text(tabsBefore),
    navigate: text(navigate),
    snapshot: text(snapshot),
    find: text(find),
    tabsAfter: text(tabsAfter),
    tabList: text(tabList),
  }, null, 2)}\n`);
} finally {
  server.stdin.end();
  setTimeout(() => server.kill("SIGTERM"), 500).unref();
}
