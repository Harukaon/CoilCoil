import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCatalogIndexFromSources,
  lookupModelMetaInIndex,
  thinkingLevelsFromReasoningOptions,
} from "../src/model-catalog.ts";

test("OpenRouter 元数据填充上下文、输出上限和图片能力", () => {
  const index = buildCatalogIndexFromSources(undefined, undefined, [
    {
      id: "openai/gpt-4o",
      name: "OpenAI: GPT-4o",
      context_length: 128000,
      architecture: { input_modalities: ["text", "image"] },
      top_provider: { max_completion_tokens: 16384 },
      supported_parameters: ["temperature"],
    },
  ]);
  const meta = lookupModelMetaInIndex(index, "openai/gpt-4o");
  assert.equal(meta.name, "OpenAI: GPT-4o");
  assert.equal(meta.contextWindow, 128000);
  assert.equal(meta.maxTokens, 16384);
  assert.deepEqual(meta.input, ["text", "image"]);
  assert.deepEqual(meta.sources, ["OpenRouter"]);
});

test("models.dev 的 effort 词汇仍映射成 Pi Thinking 级别", () => {
  assert.deepEqual(
    thinkingLevelsFromReasoningOptions([{ type: "effort", values: ["none", "low", "high"] }]),
    ["off", "low", "high"],
  );
});
