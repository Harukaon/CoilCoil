import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENAI_RESPONSES_WS_API, readOpenAIResponsesWsConfig, resolveOpenAIResponsesWsEndpoints, writeOpenAIResponsesWsConfig } from "../src/config.ts";
import { mapOpenAIResponsesWsCatalog } from "../src/models.ts";
import { adaptPiCodexTransportSource, loadOpenAIResponsesWsApiProvider, loadOpenAIResponsesWsStream } from "../src/transport.ts";

test("publishes only compiled JavaScript as production entry points", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    exports: Record<string, string | { import?: string }>;
    pi?: { extensions?: string[] };
  };
  const productionEntries = [
    ...Object.values(manifest.exports).map((entry) => typeof entry === "string" ? entry : entry.import),
    ...(manifest.pi?.extensions ?? []),
  ].filter((entry): entry is string => Boolean(entry));
  assert.ok(productionEntries.length > 0);
  assert.ok(productionEntries.every((entry) => entry.endsWith(".js") || entry.endsWith(".json")));
  assert.ok(productionEntries.every((entry) => !entry.includes("/src/")));
});

test("normalizes compatible service roots into model and inference endpoints", () => {
  assert.deepEqual(resolveOpenAIResponsesWsEndpoints("http://127.0.0.1:8317/v1"), {
    inferenceBaseUrl: "http://127.0.0.1:8317/backend-api/",
    modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=pi",
  });
});

test("reads the legacy filename once and writes only the SuoCode-owned config", () => {
  const directory = mkdtempSync(join(tmpdir(), "suocode-responses-ws-config-"));
  try {
    writeFileSync(join(directory, "cliproxyapi.json"), JSON.stringify({ baseUrl: "http://legacy", apiKey: "legacy-key" }));
    assert.equal(readOpenAIResponsesWsConfig(directory).apiKey, "legacy-key");
    const path = writeOpenAIResponsesWsConfig(directory, { baseUrl: "http://new", apiKey: "new-key" });
    assert.equal(path, join(directory, "openai-responses-ws.json"));
    assert.equal(readOpenAIResponsesWsConfig(directory).apiKey, "new-key");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("maps remote model capabilities to Pi models", () => {
  const catalog = mapOpenAIResponsesWsCatalog({ models: [{
    slug: "gpt-test",
    display_name: "GPT Test",
    context_window: 230000,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    service_tiers: ["priority"],
  }] });
  assert.equal(catalog.models[0]?.id, "gpt-test");
  assert.equal(catalog.models[0]?.contextWindow, 230000);
  assert.deepEqual(catalog.models[0]?.input, ["text", "image"]);
  assert.deepEqual(catalog.fastModelIds, ["gpt-test"]);
});

test("adapts the Pi transport without an account id or SSE fallback", () => {
  const source = `
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai"]);
function extractAccountId(token) {\n  throw new Error(token);\n}
const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
headers.set("chatgpt-account-id", accountId);
const output = { api: "openai-codex-responses" };
recordWebSocketFailure(cacheSessionId, error);
if (websocketStarted) { throw error; }
recordWebSocketSseFallback(cacheSessionId);
break;
`;
  const adapted = adaptPiCodexTransportSource(source);
  assert.match(adapted, /return ""/);
  assert.match(adapted, /openai-responses-ws/);
  assert.match(adapted, /suocode-openai-responses-ws/);
  assert.doesNotMatch(adapted, /recordWebSocketSseFallback\(cacheSessionId\)/);
});

test("loads the adapted transport from the bundled Pi build", async () => {
  const stream = await loadOpenAIResponsesWsStream(new Set());
  assert.equal(typeof stream, "function");
});

test("exposes the WS transport as a generic api provider", async () => {
  const provider = await loadOpenAIResponsesWsApiProvider();
  assert.equal(provider.api, OPENAI_RESPONSES_WS_API);
  assert.equal(typeof provider.stream, "function");
  assert.equal(typeof provider.streamSimple, "function");
});
