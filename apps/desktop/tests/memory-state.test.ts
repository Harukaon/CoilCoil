import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MEMORY_SCOPE,
  memoryEditorExpanded,
  memoryMaxChars,
} from "../src/renderer/src/features/memory/memoryState.ts";

test("project memory editor starts collapsed", () => {
  assert.equal(DEFAULT_MEMORY_SCOPE, "project");
  assert.equal(memoryEditorExpanded("project", "/memory/project-a.md", new Set()), false);
});

test("project memory editors expand independently by project document", () => {
  const expanded = new Set(["/memory/project-a.md"]);
  assert.equal(memoryEditorExpanded("project", "/memory/project-a.md", expanded), true);
  assert.equal(memoryEditorExpanded("project", "/memory/project-b.md", expanded), false);
  assert.equal(memoryEditorExpanded("global", "/memory/global.md", new Set()), true);
});

test("draft memory limits drive counters and hints before saving", () => {
  const settings = {
    globalEnabled: true,
    projectEnabled: true,
    autoSummarize: true,
    globalMaxChars: 3_000,
    projectMaxChars: 2_000,
    generationRules: "",
  };
  const staleDocument = { maxChars: 1_000 } as never;
  assert.equal(memoryMaxChars("project", settings, staleDocument), 2_000);
  assert.equal(memoryMaxChars("global", settings, staleDocument), 3_000);
});
