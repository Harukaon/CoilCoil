import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import coilcoilSetupTool from "../../workflow/extensions/setup-tool.js";
import { CoilCoilRuntime } from "../src/index.js";
import { installSetupRpc } from "../src/runtime-setup-rpc.js";
import { resetModelCatalogMemo } from "../src/model-catalog-source.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, any>;
  isError: boolean;
}

type RegisteredTool = {
  execute: (...args: any[]) => Promise<ToolResult>;
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function startProviderServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "upstream-model", name: "Upstream Model" }] }));
      return;
    }
    if (request.url === "/v1/chat/completions") {
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未绑定端口。");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

test("真实 runtime 通过 model setup RPC 保存、reload、拉取并测试服务商", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "coilcoil-model-setup-integration-"));
  const { server, baseUrl } = await startProviderServer();
  const runtime = new CoilCoilRuntime({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("models.dev")) {
      return jsonResponse({ integration: { models: {
        "upstream-model": {
          id: "upstream-model",
          name: "Catalog Model",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }],
          modalities: { input: ["text", "image"] },
          limit: { context: 200000, output: 12000 },
        },
      } } });
    }
    if (url.includes("openrouter.ai")) {
      return jsonResponse({ data: [{
        id: "openai/upstream-model",
        context_length: 200000,
        architecture: { input_modalities: ["text", "image"] },
        top_provider: { max_completion_tokens: 12000 },
      }] });
    }
    if (url.includes("api.litellm.ai")) {
      return jsonResponse({ data: [{
        id: "upstream-model",
        max_input_tokens: 200000,
        max_output_tokens: 12000,
        supports_vision: true,
        supports_reasoning: true,
      }], has_more: false });
    }
    if (!originalFetch) throw new Error("测试环境没有 fetch。");
    return originalFetch(input, init);
  };
  resetModelCatalogMemo();
  context.after(async () => {
    globalThis.fetch = originalFetch;
    resetModelCatalogMemo();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const bus = createEventBus();
  installSetupRpc(runtime, bus, () => undefined);
  let registered: RegisteredTool | undefined;
  coilcoilSetupTool({
    events: bus,
    registerTool(tool: RegisteredTool) {
      registered = tool;
    },
  } as never);
  assert.ok(registered);
  const invoke = (params: Record<string, unknown>): Promise<ToolResult> => registered!.execute(
    "integration-tool-call",
    params,
    new AbortController().signal,
    () => undefined,
    { cwd: root },
  );

  const saved = await invoke({ area: "model", op: "save", provider: {
      id: "integration-provider",
      name: "Integration Provider",
      baseUrl,
      api: "openai-completions",
      replaceModels: true,
      models: [{
        id: "integration-model",
        contextWindow: 123456,
        maxTokens: 4096,
        reasoning: true,
        input: ["text", "image"],
        thinkingLevelMap: { off: "off", high: "high" },
      }],
      apiKey: "integration-secret",
    },
  });
  assert.equal(saved.isError, false, saved.content[0]?.text ?? "");

  const listed = await invoke({ area: "model", op: "list" });
  assert.equal(listed.isError, false, listed.content[0]?.text ?? "");
  const configuration = listed.details.configuration as { providers: Array<Record<string, any>> };
  const provider = configuration.providers.find((entry) => entry.id === "integration-provider");
  assert.ok(provider);
  assert.equal(provider.apiKeyConfigured, true);
  assert.equal(provider.models[0].contextWindow, 123456);
  assert.equal(provider.models[0].maxTokens, 4096);
  assert.deepEqual(provider.models[0].input, ["text", "image"]);
  assert.doesNotMatch(JSON.stringify(listed), /integration-secret/);
  assert.match(await readFile(join(root, "agent", "auth.json"), "utf8"), /integration-secret/);

  const patched = await invoke({
    area: "model",
    op: "save",
    provider: { id: "integration-provider", models: [{ id: "integration-model", contextWindow: 200000 }] },
  });
  assert.equal(patched.isError, false, patched.content[0]?.text ?? "");
  const afterPatch = await invoke({ area: "model", op: "list" });
  const patchedProvider = (afterPatch.details.configuration as { providers: Array<Record<string, any>> }).providers
    .find((entry) => entry.id === "integration-provider");
  assert.equal(patchedProvider?.models[0].contextWindow, 200000);
  assert.equal(patchedProvider?.models[0].maxTokens, 4096);
  assert.deepEqual(patchedProvider?.models[0].input, ["text", "image"]);

  const fetched = await invoke({
    area: "model",
    op: "fetch_models",
    request: { baseUrl, api: "openai-completions", provider: "integration-provider" },
  });
  assert.equal(fetched.isError, false, fetched.content[0]?.text ?? "");
  const fetchedModel = fetched.details.result?.models?.[0];
  assert.equal(fetchedModel.contextWindow, 200000);
  assert.equal(fetchedModel.maxTokens, 12000);
  assert.deepEqual(fetchedModel.input, ["text", "image"]);
  assert.deepEqual(fetchedModel.thinkingLevels, ["off", "low", "high"]);
  assert.deepEqual(fetched.details.metadata?.availableSources, ["models.dev", "OpenRouter", "LiteLLM"]);

  const tested = await invoke({
    area: "model",
    op: "test",
    request: { baseUrl, api: "openai-completions", provider: "integration-provider", modelId: "upstream-model" },
  });
  assert.equal(tested.isError, false, tested.content[0]?.text ?? "");
  assert.equal(tested.details.result?.ok, true);

  const disabled = await invoke({ area: "model", op: "disable", providerId: "integration-provider" });
  assert.equal(disabled.isError, false, disabled.content[0]?.text ?? "");
  assert.equal(disabled.details.result?.provider?.disabled, true);

  const forbidden = await invoke({ area: "model", op: "set_default" });
  assert.equal(forbidden.isError, true);
  assert.match(forbidden.content[0]?.text ?? "", /不提供 set_default/);
});
