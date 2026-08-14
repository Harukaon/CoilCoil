import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";

const [endpoint, token] = process.argv.slice(2);
if (!endpoint || !token) throw new Error("usage: playwright-mcp-probe.mjs <endpoint> <token>");

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
const outputDir = join(tmpdir(), `suocode-playwright-probe-${process.pid}`);
mkdirSync(outputDir, { recursive: true });
const configPath = join(outputDir, "mcp-config.json");
writeFileSync(configPath, `${JSON.stringify({
  capabilities: ["core", "network", "storage", "testing", "vision", "pdf", "devtools"],
  allowUnrestrictedFileAccess: true,
  codegen: "none",
}, null, 2)}\n`);
const fixtureServer = createServer((request, response) => {
  if (request.url === "/api/value") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ source: "fixture" }));
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>SuoCode Playwright</title><button>Continue</button><script>localStorage.setItem('probe','ready')</script>");
});
await new Promise((resolve, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(0, "127.0.0.1", resolve);
});
const fixtureAddress = fixtureServer.address();
if (!fixtureAddress || typeof fixtureAddress === "string") throw new Error("failed to start fixture server");
const fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;

const mcpProcess = spawn(process.execPath, [
  cli,
  "--config", configPath,
  "--cdp-endpoint", endpoint,
  "--cdp-header", `Authorization: Bearer ${token}`,
  "--output-dir", outputDir,
], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
});

let nextId = 0;
const pending = new Map();
createInterface({ input: mcpProcess.stdout }).on("line", (line) => {
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
  mcpProcess.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const notify = (method, params) => mcpProcess.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
const text = (result) => result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n").slice(0, 4_000);
const hasTool = (tools, name) => tools.tools.some((tool) => tool.name === name);
const call = (name, args = {}, timeout) => request("tools/call", { name, arguments: args }, timeout);

try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "suocode-playwright-probe", version: "1" } });
  notify("notifications/initialized", {});
  const tools = await request("tools/list", {});
  const requiredTools = [
    "browser_route",
    "browser_cookie_list",
    "browser_localstorage_list",
    "browser_verify_element_visible",
    "browser_highlight",
    "browser_mouse_wheel",
  ];
  const missingTools = requiredTools.filter((name) => !hasTool(tools, name));
  if (missingTools.length > 0) throw new Error(`Playwright capabilities missing: ${missingTools.join(", ")}`);

  const tabsBefore = await call("browser_tabs", { action: "list" });
  const navigate = await call("browser_navigate", { url: fixtureOrigin });
  const snapshot = await call("browser_snapshot");
  const find = await call("browser_find", { text: "Continue" });
  const localStorage = await call("browser_localstorage_list");
  const route = await call("browser_route", {
    pattern: `${fixtureOrigin}/api/value`,
    status: 200,
    body: JSON.stringify({ source: "mock" }),
    contentType: "application/json",
  });
  const mockedFetch = await call("browser_evaluate", {
    function: `async () => await (await fetch('${fixtureOrigin}/api/value')).json()`,
  });
  const verify = await call("browser_verify_element_visible", { role: "button", accessibleName: "Continue" });
  const tabsAfter = await call("browser_tabs", { action: "new" });
  const tabList = await call("browser_tabs", { action: "list" });
  process.stdout.write(`${JSON.stringify({
    toolCount: tools.tools.length,
    requiredCapabilities: Object.fromEntries(requiredTools.map((name) => [name, true])),
    tabsBefore: text(tabsBefore),
    navigate: text(navigate),
    snapshot: text(snapshot),
    find: text(find),
    localStorage: text(localStorage),
    route: text(route),
    mockedFetch: text(mockedFetch),
    verify: text(verify),
    tabsAfter: text(tabsAfter),
    tabList: text(tabList),
  }, null, 2)}\n`);
} finally {
  mcpProcess.stdin.end();
  setTimeout(() => mcpProcess.kill("SIGTERM"), 500).unref();
  fixtureServer.close();
}
