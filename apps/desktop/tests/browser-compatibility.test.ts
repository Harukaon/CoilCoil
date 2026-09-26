import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFile(resolve(repositoryRoot, path), "utf8");

/**
 * 这条线是防「一个文件什么都装」，不是防长文件本身。
 *
 * 内置浏览器先后加了缩放、每个工作区一份 cookie、新会话接手草稿标签页，
 * browser-runtime.ts 三次越线。为了这几十行把它拆开，只会让同一件事分散在两处——
 * 用户明确说过，宁可一个长文件，也不要为了压行数把复杂逻辑切开。所以抬上限，不动代码。
 *
 * 1150、1250：Agent 的标签页改成离屏页面、用户和 Agent 互相接管、用户直接操作页面，一路
 * 涨上去。之后每张标签页都改成离屏页面，<webview>、接管和嵌入页名册整块删掉，运行时
 * 回到九百多行，线收回 1050。
 */
const MAX_LINES = 1050;

test(`browser runtime source files stay within the ${MAX_LINES}-line architecture limit`, async () => {
  for (const path of [
    "apps/desktop/src/main/browser-runtime.ts",
    "apps/desktop/src/main/browser-cdp-bridge.ts",
    "apps/desktop/src/main/browser-cdp-commands.ts",
    "apps/desktop/src/main/browser-runtime-types.ts",
    "scripts/chrome-devtools-mcp/intercept-network-request.js",
  ]) {
    const lines = (await read(path)).split("\n").length - 1;
    assert.ok(lines <= MAX_LINES, `${path} has ${lines} lines`);
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

test("pageId 是可选的：不传就落到当前选中的页面", async () => {
  // --experimentalPageIdRouting 会给每个按页面走的工具加上 pageId，上游把它写成必填。
  // 模型第一次调 take_snapshot / click / navigate_page 时并不知道有这么个参数，于是
  // 撞一次 "Invalid arguments: Required at pageId" 才学会——一个会话里白撞了八次。
  // ToolHandler 本来就有「没给 pageId 就用当前选中页」的兜底，挡路的只是 schema。
  const definition = await read("node_modules/chrome-devtools-mcp/build/src/tools/ToolDefinition.js");
  assert.match(definition, /pageId: zod[\s\S]{0,40}\.optional\(\)/);
  assert.match(definition, /Omit to act on the currently selected page/);
  // 处理器那一侧的兜底还在，否则可选就成了「不传就报错」。
  const handler = await read("node_modules/chrome-devtools-mcp/build/src/ToolHandler.js");
  assert.match(handler, /: context\.getSelectedMcpPage\(\)/);
  // evaluate_script 在自己的处理函数里又按 pageId 查一次页面，没有兜底：照 schema
  // 不传 pageId，每次都是 "No page found"。端到端跑真实 Agent 时撞出来的。
  const script = await read("node_modules/chrome-devtools-mcp/build/src/tools/script.js");
  assert.match(script, /experimentalPageIdRouting && request\.params\.pageId !== undefined/);
  // select_page 自己那个 pageId 仍然必填：它的全部意思就是「选这一个」。
  const pages = await read("node_modules/chrome-devtools-mcp/build/src/tools/pages.js");
  assert.match(pages, /The ID of the page to select/);
});
