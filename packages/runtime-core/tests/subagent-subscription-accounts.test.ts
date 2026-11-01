import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { ModelRuntime, SessionManager, createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { createChildSession, reopenChildSession, type ChildSessionHandle } from "@coilcoil/workflow/extensions/subagents/child.js";
import { syncSubscriptionAccounts, writeSubscriptionAccounts } from "../src/subscription-accounts.js";
const ids = ["claude-first", "claude-second", "codex-first", "codex-second"];
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


test("fresh and resumed children use the selected second Claude/Codex subscription without borrowing sibling credentials", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "coil-child-accounts-"));
  const handles = new Set<ChildSessionHandle>();
  t.after(async () => { for (const handle of handles) await handle.dispose(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "auth.json"), JSON.stringify(Object.fromEntries(ids.map((id) => [id,
    { type: "oauth", access: token(id), refresh: `fake-${id}`, expires: Date.now() + 3600000 }]))));
  writeSubscriptionAccounts(root, ids.map((id) => ({ id, name: id, provider: id.startsWith("claude") ? "anthropic" : "openai-codex" })));
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  await syncSubscriptionAccounts(models, root);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, options: RequestInit) => {
    const headers = new Headers(options.headers);
    const id = ids.find((candidate) => headers.get("Authorization") === `Bearer ${token(candidate)}`);
    assert.ok(id, "only the configured fake account may authenticate this offline request");
    calls.push(id);
    if (id.startsWith("codex")) assert.equal(headers.get("chatgpt-account-id"), `account-${id}`);
    const raw = headers.get("content-encoding") === "zstd" ? zstdDecompressSync(Buffer.from(options.body as Uint8Array)).toString() : String(options.body);
    const body = JSON.parse(raw);
    return new Response(id.startsWith("claude") ? claudeStream(id, body.model) : codexStream(id, body.model),
      { headers: { "Content-Type": "text/event-stream" } });
  });
  const useSse = (handle: ChildSessionHandle) => {
    handles.add(handle);
    const stream = handle.session.agent.streamFunction;
    handle.session.agent.streamFunction = (model, context, options) => stream(model, context, { ...options, transport: "sse" });
  };
  for (const id of ["claude-second", "codex-second"]) {
    const model = models.getModels().find((candidate) => candidate.provider === id)!;
    const first = await createChildSession({ cwd: root, agentDir: root, parentSessionDir: join(root, "sessions"),
      parentSessionId: id, model: model as never, tools: ["read"], onEvent: () => undefined });
    useSse(first);
    await first.prompt("Reply with the selected account name");
    const reply = first.session.messages.filter((message) => message.role === "assistant").at(-1)!;
    assert.equal(reply.stopReason, "stop", reply.errorMessage ?? "unexpected stop");
    assert.equal(reply.provider, id);
    const path = first.sessionFile!;
    await first.dispose();
    handles.delete(first);
    const resumed = await reopenChildSession({ cwd: root, agentDir: root, sessionFile: path, tools: ["read"], onEvent: () => undefined });
    useSse(resumed);
    assert.equal(resumed.session.model?.provider, id);
    await resumed.prompt("Continue using the same account");
    const final = resumed.session.messages.filter((message) => message.role === "assistant").at(-1)!;
    assert.equal(final.stopReason, "stop", final.errorMessage ?? "unexpected stop");
    assert.equal(final.provider, id);
  }
  assert.deepEqual(calls, ["claude-second", "claude-second", "codex-second", "codex-second"]);
});

test("the headless worker extension registers named subscriptions before CLI model selection", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "coil-worker-accounts-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "auth.json"), JSON.stringify(Object.fromEntries(ids.map((id) => [id,
    { type: "oauth", access: token(id), refresh: `fake-${id}`, expires: Date.now() + 3600000 }]))));
  writeSubscriptionAccounts(root, ids.map((id) => ({ id, name: id, provider: id.startsWith("claude") ? "anthropic" : "openai-codex" })));
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const services = await createAgentSessionServices({ cwd: root, agentDir: root, modelRuntime: models,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../../workflow/extensions/providers/subscription-extension.ts", import.meta.url))] } });
  assert.deepEqual(services.diagnostics, []);
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  for (const id of ids) {
    assert.ok(services.modelRuntime.getModels().some((model) => model.provider === id));
    assert.ok(await services.modelRuntime.checkAuth(id));
  }
});

test("children reject logged-out or removed selected accounts instead of switching to a sibling", async (t) => {
  for (const selected of ["claude-second", "codex-second"]) {
    for (const unavailable of ["logged-out", "removed"] as const) {
      await t.test(`${selected}: ${unavailable}`, async (t) => {
        const root = mkdtempSync(join(tmpdir(), "coil-child-missing-account-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const accounts = ids.map((id) => ({ id, name: id, provider: id.startsWith("claude") ? "anthropic" as const : "openai-codex" as const }));
        writeSubscriptionAccounts(root, accounts);
        const credentials = Object.fromEntries(ids.map((id) => [id,
          { type: "oauth", access: token(id), refresh: `fake-${id}`, expires: Date.now() + 3600000 }]));
        writeFileSync(join(root, "auth.json"), JSON.stringify(credentials));
        const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
        await syncSubscriptionAccounts(models, root);
        const model = models.getModels().find((candidate) => candidate.provider === selected)!;
        writeFileSync(join(root, "settings.json"), JSON.stringify({ defaultProvider: selected.replace("second", "first"), defaultModel: model.id }));
        const session = SessionManager.create(root, join(root, "sessions"));
        session.appendModelChange(selected, model.id);
        session.appendMessage({ role: "user", content: "Saved task", timestamp: Date.now() });
        session.appendMessage({ role: "assistant", provider: selected, model: model.id, api: model.api,
          content: [{ type: "text", text: "Saved reply" }], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        const sessionFile = session.getSessionFile()!;
        const original = readFileSync(sessionFile, "utf8");
        if (unavailable === "logged-out") {
          delete credentials[selected];
          writeFileSync(join(root, "auth.json"), JSON.stringify(credentials));
        } else {
          writeSubscriptionAccounts(root, accounts.filter((account) => account.id !== selected), [selected]);
        }
        const failure = unavailable === "logged-out" ? /指定的账号未登录/ : /指定的模型不可用/;
        await assert.rejects(reopenChildSession({ cwd: root, agentDir: root, sessionFile,
          tools: ["read"], onEvent: () => undefined }), failure);
        assert.equal(readFileSync(sessionFile, "utf8"), original, "failed restore must preserve the recorded account and history");
        await assert.rejects(createChildSession({ cwd: root, agentDir: root, parentSessionDir: join(root, "sessions"),
          parentSessionId: selected, model: model as never, tools: ["read"], onEvent: () => undefined }), failure);
      });
    }
  }
});
