import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OPENAI_RESPONSES_WS_API } from "@coilcoil/openai-responses-ws/config";
import { CoilCoilRuntime } from "../src/index.js";

test("the WS transport is exposed as a generic request protocol, selectable by custom providers", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-model-provider-protocols-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
  });

  const snapshot = await runtime.getModelProviderConfiguration();
  assert.ok(snapshot.supportedApis.some((option) => option.id === OPENAI_RESPONSES_WS_API));

  const saved = await runtime.saveModelProviderConfiguration({
    provider: {
      id: "custom-ws-service",
      baseUrl: "https://example.test/v1",
      api: OPENAI_RESPONSES_WS_API,
      disabled: false,
      replaceModels: true,
      models: [{ id: "custom-model" }],
    },
  });
  assert.equal(saved.provider.api, OPENAI_RESPONSES_WS_API);
  assert.equal(saved.provider.baseUrl, "https://example.test/v1");
  assert.deepEqual(saved.provider.models.map((model) => model.id), ["custom-model"]);

  await runtime.dispose();
});
