import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCatalogIndexFromSources,
  candidateKeys,
  catalogSourceLabel,
  lookupModelMetaInIndex,
  mergeCatalogEntries,
  mergeSelectedUpstreamModels,
  thinkingLevelMapFromLevels,
  thinkingLevelsFromMap,
  thinkingLevelsFromReasoningOptions,
} from "../src/renderer/src/features/settings/modelCatalog.ts";

test("candidateKeys normalizes provider prefixes and free variants", () => {
  assert.deepEqual(candidateKeys("openai/gpt-4o"), ["openai/gpt-4o", "gpt-4o"]);
  assert.deepEqual(candidateKeys("gpt-4o:free"), ["gpt-4o:free", "gpt-4o"]);
  assert.deepEqual(candidateKeys("  "), []);
});

test("dual-source merge prefers models.dev then fills blanks from LiteLLM", () => {
  const meta = mergeCatalogEntries([
    {
      source: "LiteLLM",
      contextWindow: 200_000,
      maxTokens: 16_384,
      input: ["text"],
      reasoning: true,
    },
    {
      source: "models.dev",
      contextWindow: 128_000,
      input: ["text", "image"],
      name: "GPT-4o",
    },
  ]);
  assert.equal(meta.contextWindow, 128_000);
  assert.equal(meta.maxTokens, 16_384);
  assert.deepEqual(meta.input, ["text", "image"]);
  assert.equal(meta.reasoning, true);
  assert.equal(meta.name, "GPT-4o");
  assert.deepEqual(meta.sources, ["models.dev", "LiteLLM"]);
  assert.equal(catalogSourceLabel(meta), "models.dev + LiteLLM");
});

test("catalog lookup matches short ids against provider-prefixed entries", () => {
  const index = buildCatalogIndexFromSources(
    {
      openai: {
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            name: "GPT-4o",
            attachment: true,
            reasoning: false,
            modalities: { input: ["text", "image"] },
            limit: { context: 128000, output: 16384 },
          },
        },
      },
    },
    [
      {
        id: "openai/gpt-4o",
        max_input_tokens: 128000,
        max_output_tokens: 16384,
        supports_vision: true,
        supports_reasoning: false,
      },
    ],
  );

  const byShort = lookupModelMetaInIndex(index, "gpt-4o");
  assert.equal(byShort.contextWindow, 128000);
  assert.equal(byShort.maxTokens, 16384);
  assert.deepEqual(byShort.input, ["text", "image"]);
  assert.ok(byShort.sources.includes("models.dev"));

  const byPrefixed = lookupModelMetaInIndex(index, "openai/gpt-4o");
  assert.equal(byPrefixed.contextWindow, 128000);
  assert.ok(byPrefixed.sources.length >= 1);

  const missing = lookupModelMetaInIndex(index, "totally-unknown-model-xyz");
  assert.deepEqual(missing.sources, []);
  assert.equal(catalogSourceLabel(missing), "未匹配");
});

test("LiteLLM-only source still enriches when models.dev is unavailable", () => {
  const index = buildCatalogIndexFromSources(undefined, [
    {
      id: "deepseek-chat",
      max_input_tokens: 65536,
      max_output_tokens: 8192,
      supports_vision: false,
      supports_reasoning: true,
    },
  ]);
  const meta = lookupModelMetaInIndex(index, "deepseek-chat");
  assert.equal(meta.contextWindow, 65536);
  assert.equal(meta.maxTokens, 8192);
  assert.deepEqual(meta.input, ["text"]);
  assert.equal(meta.reasoning, true);
  assert.deepEqual(meta.sources, ["LiteLLM"]);
});

test("mergeSelectedUpstreamModels keeps existing fields and only adds new ids", () => {
  const existing = [
    { id: "kept-local", note: "mine" },
    { id: "shared", note: "original" },
  ];
  const { next, added } = mergeSelectedUpstreamModels(
    existing,
    ["shared", "new-one", "new-one"],
    (id) => ({ id, note: "created" }),
  );
  assert.equal(added.length, 1);
  assert.deepEqual(next, [
    { id: "kept-local", note: "mine" },
    { id: "shared", note: "original" },
    { id: "new-one", note: "created" },
  ]);
});

test("models.dev effort options become Pi thinking levels", () => {
  assert.deepEqual(
    thinkingLevelsFromReasoningOptions([{ type: "effort", values: ["none", "low", "medium", "high"] }]),
    ["off", "low", "medium", "high"],
  );
  assert.deepEqual(
    thinkingLevelsFromReasoningOptions([{ type: "effort", values: ["high", "max"] }]),
    ["high", "max"],
  );
  // A toggle or a token budget says nothing about the effort vocabulary.
  assert.equal(thinkingLevelsFromReasoningOptions([{ type: "toggle" }]), undefined);
  assert.equal(thinkingLevelsFromReasoningOptions([{ type: "budget_tokens", min: 1024 }]), undefined);
  assert.equal(thinkingLevelsFromReasoningOptions([]), undefined);
  assert.equal(thinkingLevelsFromReasoningOptions(undefined), undefined);
});

test("a models.dev index carries the levels a model accepts", () => {
  const index = buildCatalogIndexFromSources({
    openai: {
      models: {
        "gpt-5.6": {
          id: "gpt-5.6",
          name: "GPT-5.6",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
          limit: { context: 400_000, output: 128_000 },
        },
      },
    },
  });
  const meta = lookupModelMetaInIndex(index, "gpt-5.6");
  assert.deepEqual(meta.thinkingLevels, ["off", "low", "medium", "high", "xhigh"]);
});

test("a level set round-trips through Pi's thinkingLevelMap", () => {
  const map = thinkingLevelMapFromLevels(["off", "medium", "high", "max"]);
  assert.deepEqual(map, {
    off: "off",
    minimal: null,
    low: null,
    medium: "medium",
    high: "high",
    xhigh: null,
    max: "max",
  });
  assert.deepEqual(thinkingLevelsFromMap(map, true), ["off", "medium", "high", "max"]);
});

test("an unstated map keeps Pi's default ladder and a non-reasoning model has none", () => {
  assert.deepEqual(thinkingLevelsFromMap(undefined, true), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(thinkingLevelsFromMap({}, true), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(thinkingLevelsFromMap(undefined, false), ["off"]);
});
