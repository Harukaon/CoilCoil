import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { syncSubscriptionAccounts, writeSubscriptionAccounts } from "../src/subscription-accounts.js";

const ids = ["claude-work", "claude-personal", "codex-work", "codex-personal"];
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function token(id: string) {
  return id.startsWith("claude") ? `sk-ant-oat01-e2e-${id}` : `e2e.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: `account-${id}` } })).toString("base64url")}.signature`;
}
function claudeStream(id: string, model: string) {
  return event("message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: id } })
    + event("content_block_stop", { type: "content_block_stop", index: 0 })
    + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
    + event("message_stop", { type: "message_stop" });
}
function codexStream(id: string, model: string) {
  const item = { id: "msg_test", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: id, annotations: [] }] };
  return event("response.created", { type: "response.created", response: { id: "resp_test", status: "in_progress", model, output: [] } })
    + event("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } })
    + event("response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
    + event("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: id })
    + event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item })
    + event("response.completed", { type: "response.completed", response: { id: "resp_test", status: "completed", model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
}

test("real native requests use each account's token, keep original model IDs and replay Codex tools correctly", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coil-account-native-stream-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "auth.json");
  writeFileSync(path, JSON.stringify(Object.fromEntries(ids.map((id) => [id, { type: "oauth", access: token(id), refresh: `fake-refresh-${id}`, expires: Date.now() + 3600000 }]))));
  writeSubscriptionAccounts(root, ids.map((id) => ({ id, name: id, provider: id.startsWith("claude") ? "anthropic" : "openai-codex" })));
  const runtime = await ModelRuntime.create({ authPath: path, modelsPath: null, refreshOnCreate: false });
  await syncSubscriptionAccounts(runtime, root);
  const requests: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, options: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(options.headers);
    const auth = headers.get("Authorization");
    const id = ids.find((id) => auth === `Bearer ${token(id)}`)!;
    assert.ok(id, "actual native request must use the selected account token");
    requests.push(id);
    const raw = headers.get("content-encoding") === "zstd" ? zstdDecompressSync(Buffer.from(options.body as Uint8Array)).toString() : String(options.body);
    const body = JSON.parse(raw);
    assert.ok(!body.model.startsWith(id), "display prefix must not enter the service's model ID");
    if (id.startsWith("codex")) {
      assert.equal(headers.get("chatgpt-account-id"), `account-${id}`);
      const call = body.input.find((item: { type: string }) => item.type === "function_call");
      const result = body.input.find((item: { type: string }) => item.type === "function_call_output");
      assert.equal(call.id, "fc_test");
      assert.equal(call.call_id, "call_test");
      assert.equal(result.call_id, "call_test");
      assert.ok(JSON.stringify(body.input).includes("cipher-same-account"), "own opaque reasoning must survive replay");
      assert.ok(!JSON.stringify(body.input).includes("cipher-other-account"), "another account's opaque reasoning must not be relabeled as ours");
      assert.ok(JSON.stringify(body.input).includes("foreign-visible-text"), "switching accounts must preserve ordinary conversation text");
      assert.ok(url.includes("chatgpt.com"));
    } else assert.ok(url.includes("api.anthropic.com"));
    return new Response(id.startsWith("claude") ? claudeStream(id, body.model) : codexStream(id, body.model), { headers: { "Content-Type": "text/event-stream" } });
  });
  for (const id of ids) {
    const model = runtime.getModels().find((model) => model.provider === id)!;
    const input: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };
    if (id.startsWith("codex")) {
      const assistant: AssistantMessage = { role: "assistant", provider: id, api: model.api, model: model.id, usage: zeroUsage, stopReason: "toolUse", timestamp: 1, content: [{ type: "toolCall", id: "call_test|fc_test", name: "read", arguments: { path: "test.txt" } }] };
      assistant.content.unshift({ type: "thinking", thinking: "", redacted: true, thinkingSignature: JSON.stringify({ id: "rs_own", type: "reasoning", encrypted_content: "cipher-same-account", summary: [] }) });
      const foreign: AssistantMessage = { ...assistant, provider: "codex-other", content: [{ type: "thinking", thinking: "", redacted: true, thinkingSignature: JSON.stringify({ id: "rs_other", type: "reasoning", encrypted_content: "cipher-other-account", summary: [] }) }, { type: "text", text: "foreign-visible-text" }] };
      input.messages.push(foreign, assistant, { role: "toolResult", toolCallId: "call_test|fc_test", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 });
    }
    const stream = runtime.streamSimple(model, input, { transport: "sse" });
    for await (const ignored of stream) { void ignored; }
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage ?? "Native subscription request failed");
    assert.equal(result.provider, id);
    assert.equal(result.content.find((item) => item.type === "text")?.text, id);
  }
  assert.deepEqual(requests, ids);
});
