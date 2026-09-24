import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  lookupModelCatalogMeta,
  resetModelCatalogMemo,
} from "../src/model-catalog-source.js";

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("runtime 模型目录从 models.dev、OpenRouter 和 LiteLLM 合并并写入缓存", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-model-catalog-"));
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
    resetModelCatalogMemo();
    rmSync(root, { recursive: true, force: true });
  });
  resetModelCatalogMemo();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("models.dev")) {
      return response({ openai: { models: {
        "gpt-5": {
          id: "gpt-5",
          name: "GPT-5",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }],
          limit: { context: 400000, output: 128000 },
        },
      } } });
    }
    if (url.includes("openrouter.ai")) {
      return response({ data: [{
        id: "openai/gpt-5",
        context_length: 400000,
        architecture: { input_modalities: ["text", "image"] },
        top_provider: { max_completion_tokens: 128000 },
      }] });
    }
    return response({ data: [{
      id: "gpt-5",
      max_input_tokens: 400000,
      max_output_tokens: 128000,
      supports_vision: true,
      supports_reasoning: true,
    }], has_more: false });
  };

  const result = await lookupModelCatalogMeta(root, ["gpt-5"]);
  assert.deepEqual(result.availableSources, ["models.dev", "OpenRouter", "LiteLLM"]);
  assert.equal(result.entries[0]?.contextWindow, 400000);
  assert.equal(result.entries[0]?.maxTokens, 128000);
  assert.deepEqual(result.entries[0]?.input, ["text", "image"]);
  assert.deepEqual(result.entries[0]?.thinkingLevels, ["off", "low", "high"]);
  const cachePath = join(root, "model-catalog-cache.json");
  assert.equal(existsSync(cachePath), true);
  assert.match(readFileSync(cachePath, "utf8"), /openRouter/);
});
