import assert from "node:assert/strict";
import test from "node:test";
import type { ModelOption } from "@coilcoil/runtime-protocol";
import { memoryWorkerModels, memoryWorkerProviders } from "../src/renderer/src/features/memory/MemoryWorkerSettings.tsx";

const models = [
  { provider: "claude-secondary", providerName: "Claude 账户二", id: "model/a", name: "A", configured: true },
  { provider: "codex-secondary", providerName: "Codex 账户二", id: "model/b", name: "B", configured: true },
  { provider: "unconfigured", providerName: "无凭据", id: "model/c", name: "C", configured: false },
] as ModelOption[];

test("memory worker selector includes configured subscription aliases and scopes models to their provider", () => {
  assert.deepEqual(memoryWorkerProviders(models).map((option) => option.value), ["", "claude-secondary", "codex-secondary"]);
  assert.deepEqual(memoryWorkerModels(models, "codex-secondary").map((option) => option.value), ["", "model/b"]);
  assert.equal(memoryWorkerModels(models, "codex-secondary")[0].disabled, true);
});

test("removed worker selections remain visible as unavailable rather than silently following the conversation", () => {
  assert.equal(memoryWorkerProviders(models, "removed").at(-1)?.disabled, true);
  assert.equal(memoryWorkerProviders(models, "removed").at(-1)?.value, "removed");
  assert.equal(memoryWorkerModels(models, "claude-secondary", "removed-model").at(-1)?.disabled, true);
  assert.equal(memoryWorkerModels(models, "claude-secondary", "removed-model").at(-1)?.value, "removed-model");
});
