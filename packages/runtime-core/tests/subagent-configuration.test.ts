import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SubagentConfiguration, SubagentConfigurationInput } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";

interface SubagentConfigurationRuntime {
  agentDir: string;
  getSubagentConfiguration(): Promise<SubagentConfiguration>;
  saveSubagentConfiguration(input: SubagentConfigurationInput): Promise<SubagentConfiguration>;
}

test("subagent models are stored independently for the three built-in profiles", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-subagent-config-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const runtime = Object.create(CoilCoilRuntime.prototype) as SubagentConfigurationRuntime;
  runtime.agentDir = agentDir;

  assert.deepEqual(await runtime.getSubagentConfiguration(), {
    models: { explore: "", worker: "", reviewer: "" },
  });

  const saved = await runtime.saveSubagentConfiguration({
    models: {
      explore: " provider/fast ",
      worker: "provider/code",
      reviewer: "",
    },
  });
  assert.deepEqual(saved, {
    models: {
      explore: "provider/fast",
      worker: "provider/code",
      reviewer: "",
    },
  });
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "subagent-settings.json"), "utf8")), saved);
});

test("legacy single-model subagent settings migrate to all three profiles", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-subagent-config-legacy-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "subagent-settings.json"), JSON.stringify({ model: "provider/legacy" }));
  const runtime = Object.create(CoilCoilRuntime.prototype) as SubagentConfigurationRuntime;
  runtime.agentDir = agentDir;

  assert.deepEqual(await runtime.getSubagentConfiguration(), {
    models: {
      explore: "provider/legacy",
      worker: "provider/legacy",
      reviewer: "provider/legacy",
    },
  });
});

test("subagent configuration rejects incomplete profile maps", async () => {
  const runtime = Object.create(CoilCoilRuntime.prototype) as SubagentConfigurationRuntime;
  runtime.agentDir = join(tmpdir(), "coilcoil-subagent-config-invalid");
  await assert.rejects(
    runtime.saveSubagentConfiguration({ models: { explore: "provider/fast" } } as never),
    /子代理配置无效/,
  );
});
