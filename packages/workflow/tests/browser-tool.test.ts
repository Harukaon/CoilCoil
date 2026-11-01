import assert from "node:assert/strict";
import test from "node:test";
import browserActExtension from "../extensions/browser-act.ts";
import { MCP_MANAGER_CHANNEL } from "../extensions/mcp-tools.ts";

type Result = { content: Array<{ type: string; text?: string; data?: string }>; details: Record<string, unknown>; isError?: boolean };
function harness(response: unknown = { content: [{ type: "text", text: "ok" }] }) {
  let discoveries = 0;
  const calls: Array<{ server: string; tool: string; args: unknown; signal?: AbortSignal }> = [];
  const registered: Array<{ name: string; parameters: unknown; execute: (...args: any[]) => Promise<Result> }> = [];
  browserActExtension({
    registerTool: (tool: never) => registered.push(tool),
    events: { emit(channel: string, data: { manager?: unknown }) {
      if (channel !== MCP_MANAGER_CHANNEL) return;
      data.manager = {
        serverTools: async () => { discoveries++; return { status: "connected", tools: [
          { name: "evaluate_script", description: "Evaluate a script", inputSchema: {
            type: "object", properties: { function: { type: "string" } }, required: ["function"], additionalProperties: false,
          } },
          { name: "take_screenshot", description: "Capture the current page", inputSchema: { type: "object", properties: {} } },
        ] }; },
        callTool: async (server: string, tool: string, args: unknown, signal?: AbortSignal) => {
          calls.push({ server, tool, args, signal }); return response;
        },
      };
    } },
  } as never);
  return { registered, calls, discoveries: () => discoveries,
    run: (params: Record<string, unknown>, signal?: AbortSignal) => registered[0].execute("call", params, signal) };
}

test("browser discovery discloses individual schemas on demand without registering more tools", async () => {
  const h = harness();
  const schema = JSON.stringify(h.registered[0].parameters);
  assert.doesNotMatch(schema, /uid|pageId|evaluate_script/);
  const common = await h.run({ action: "list" });
  assert.match(common.content[0].text!, /open/);
  assert.doesNotMatch(common.content[0].text!, /inputSchema/);
  const open = await h.run({ action: "tools", tool: "open" });
  assert.match(open.content[0].text!, /inputSchema/);
  assert.match(open.content[0].text!, /url/);
  assert.equal(h.discoveries(), 0, "common actions do not connect the MCP server");
  const all = await h.run({ action: "tools" });
  assert.match(all.content[0].text!, /devtools.evaluate_script/);
  assert.doesNotMatch(all.content[0].text!, /inputSchema/);
  const selected = await h.run({ action: "tools", tool: "devtools.evaluate_script" });
  assert.match(selected.content[0].text!, /inputSchema/);
  assert.match(selected.content[0].text!, /required/);
  assert.deepEqual(h.registered.map((tool) => tool.name), ["browser"]);
  assert.equal(h.calls.length, 0, "discovery must not execute browser operations");
});

test("browser validates both local and MCP arguments before any page operation", async () => {
  const h = harness();
  for (const params of [
    { action: "call", tool: "open", args: {} },
    { action: "call", tool: "devtools.evaluate_script", args: {} },
    { action: "call", tool: "made_up", args: {} },
    { action: "call", tool: "devtools.made_up", args: {} },
    { action: "call", tool: "click", args: { handle: "unknown", uid: "1_0" } },
  ]) assert.equal((await h.run(params)).isError, true);
  assert.equal(h.calls.length, 0);
});

test("browser MCP calls preserve screenshots, failure state and cancellation signal", async () => {
  const h = harness({ content: [{ type: "text", text: "capture failure" }, { type: "image", data: "AA==", mimeType: "image/png" }], isError: true });
  const controller = new AbortController();
  const result = await h.run({ action: "call", tool: "devtools.take_screenshot", args: {} }, controller.signal);
  assert.equal(result.isError, true);
  assert.equal(result.content.find((part) => part.type === "image")?.data, "AA==");
  assert.deepEqual(h.calls, [{ server: "coilcoil-browser", tool: "take_screenshot", args: {}, signal: controller.signal }]);
  controller.abort();
  await assert.rejects(h.run({ action: "call", tool: "devtools.take_screenshot", args: {} }, controller.signal), /abort/i);
  assert.equal(h.calls.length, 1);
});

test("browser MCP structured-only output remains visible", async () => {
  const h = harness({ structuredContent: { title: "Example" } });
  const result = await h.run({ action: "call", tool: "devtools.take_screenshot" });
  assert.match(result.content.map((part) => part.text ?? "").join("\n"), /Example/);
});
