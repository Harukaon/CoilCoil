import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { systemPromptLayerFiles } from "../src/system-prompt-layers.js";

test("system prompt layers keep Pi base and append global before project", (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-system-layers-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const globalPrompt = join(agentDir, "SYSTEM.md");
  const projectPrompt = join(cwd, ".pi", "SYSTEM.md");
  writeFileSync(globalPrompt, "global");
  writeFileSync(projectPrompt, "project");

  assert.deepEqual(systemPromptLayerFiles({ agentDir, cwd, projectTrusted: true }), [
    globalPrompt,
    projectPrompt,
  ]);
  assert.deepEqual(systemPromptLayerFiles({ agentDir, cwd, projectTrusted: false }), [
    globalPrompt,
  ]);
});
