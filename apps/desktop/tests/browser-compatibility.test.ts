import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFile(resolve(repositoryRoot, path), "utf8");

test("browser runtime source files stay within the 600-line architecture limit", async () => {
  for (const path of [
    "apps/desktop/src/main/browser-runtime.ts",
    "apps/desktop/src/main/browser-cdp-bridge.ts",
    "apps/desktop/src/main/browser-cdp-commands.ts",
    "apps/desktop/src/main/browser-runtime-types.ts",
    "scripts/chrome-devtools-mcp/intercept-network-request.js",
  ]) {
    const lines = (await read(path)).split("\n").length - 1;
    assert.ok(lines <= 600, `${path} has ${lines} lines`);
  }
});

test("the pinned Chrome DevTools MCP carries CoilCoil lifecycle fixes", async () => {
  const [handler, pages, snapshot, network, interception, tools, performance, response, lighthouse] = await Promise.all([
    read("node_modules/chrome-devtools-mcp/build/src/ToolHandler.js"),
    read("node_modules/chrome-devtools-mcp/build/src/tools/pages.js"),
    read("node_modules/chrome-devtools-mcp/build/src/tools/snapshot.js"),
    read("node_modules/chrome-devtools-mcp/build/src/tools/network.js"),
    read("node_modules/chrome-devtools-mcp/build/src/tools/intercept-network-request.js"),
    read("node_modules/chrome-devtools-mcp/build/src/tools/tools.js"),
    read("node_modules/chrome-devtools-mcp/build/src/tools/performance.js"),
    read("node_modules/chrome-devtools-mcp/build/src/McpResponse.js"),
    read("node_modules/chrome-devtools-mcp/build/src/tools/lighthouse.js"),
  ]);
  assert.match(handler, /discovery tools must survive a stale selected page/);
  assert.match(pages, /PAGE_RELOAD_FAILED/);
  assert.doesNotMatch(pages, /appendResponseLine\(`Unable to reload/);
  assert.match(snapshot, /union\(\[zod\.string\(\), zod\.array/);
  assert.match(network, /NO_NETWORK_REQUEST/);
  assert.match(interception, /name: 'intercept_network_request'/);
  assert.match(interception, /setRequestInterception\(true\)/);
  assert.match(tools, /Object\.values\(networkInterceptionTools\)/);
  assert.match(performance, /NO_ACTIVE_TRACE/);
  assert.match(response, /insightSetId,/);
  assert.match(lighthouse, /mainDocumentUrl \?\? lhr\.finalDisplayedUrl \?\? page\.pptrPage\.url/);
});

test("Chrome DevTools MCP exposes structured results and optional page routing", async () => {
  const main = await read("apps/desktop/src/main/index.ts");
  assert.match(main, /"--experimentalStructuredContent"/);
  assert.match(main, /"--experimentalPageIdRouting"/);
});
