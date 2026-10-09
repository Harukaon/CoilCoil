import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentProfileInfo } from "@coilcoil/runtime-protocol";
import { isValidProfileName } from "../../../packages/workflow/extensions/subagents/profiles.ts";
import {
  DEFAULT_NEW_SUBAGENT_TOOLS,
  SUBAGENT_NAME_RULE,
  changesFiles,
  isCustomSubagent,
  isValidSubagentName,
  newSubagentDraft,
  subagentDraftFromProfile,
  subagentDraftProblem,
  subagentDraftToInput,
  subagentModelOptions,
  subagentToolBlurb,
  type SubagentDraft,
} from "../src/renderer/src/features/runtime/subagentProfiles.ts";

const OFFERED = ["read", "bash", "terminal", "edit", "write", "grep", "ls", "mcp"];

function draft(overrides: Partial<SubagentDraft> = {}): SubagentDraft {
  return { ...newSubagentDraft(), name: "db-expert", description: "Knows the schema", systemPrompt: "You check SQL.", ...overrides };
}

test("the name rule in the form is the one the runtime enforces", () => {
  const names = [
    "db-expert", "a", "a1", "9lives", "snake_case", "x".repeat(48), "x".repeat(49), "",
    "Upper", "has space", "-lead", "_lead", "dot.name", "slash/name", "../escape", "中文",
    "con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9", "com0", "com10", "console", "communication",
  ];
  for (const name of names) {
    assert.equal(isValidSubagentName(name), isValidProfileName(name), JSON.stringify(name));
  }
  // The table above would pass if both were wrong in the same way; pin a few by hand.
  assert.equal(isValidSubagentName("db-expert"), true);
  assert.equal(isValidSubagentName("Upper"), false);
  assert.equal(isValidSubagentName("con"), false);
  assert.equal(isValidSubagentName("x".repeat(49)), false);
});

test("a new subagent starts read-only, for every project, in the working tree, with no model", () => {
  const fresh = newSubagentDraft();
  assert.deepEqual(fresh.tools, ["read", "grep", "ls"]);
  assert.deepEqual(fresh.tools, [...DEFAULT_NEW_SUBAGENT_TOOLS]);
  assert.equal(fresh.scope, "user");
  assert.equal(fresh.worktree, false);
  assert.equal(fresh.model, "");
  assert.equal(changesFiles(fresh.tools), false, "nothing that could change a file is ticked for someone who did not choose it");
  fresh.tools.push("edit");
  assert.deepEqual(newSubagentDraft().tools, ["read", "grep", "ls"], "each draft has its own list");
});

test("only edit and write count as changing files", () => {
  assert.equal(changesFiles(["read", "grep", "ls", "bash", "terminal", "mcp"]), false);
  assert.equal(changesFiles(["read", "edit"]), true);
  assert.equal(changesFiles(["write"]), true);
  assert.equal(changesFiles([]), false);
});

test("creating is refused for the first thing wrong, in plain words", () => {
  const problem = (overrides: Partial<SubagentDraft>, names: string[] = []) => subagentDraftProblem(draft(overrides), "create", OFFERED, names);
  assert.equal(problem({}), undefined);
  assert.equal(problem({ name: "  " }), "请填名字。");
  assert.equal(problem({ name: "DB Expert" }), SUBAGENT_NAME_RULE);
  assert.equal(problem({ name: "nul" }), SUBAGENT_NAME_RULE);
  assert.match(problem({ name: "db-expert" }, ["explore", "db-expert"]) ?? "", /已经有叫「db-expert」的子 Agent/);
  assert.match(problem({ name: "explore" }, ["explore", "worker"]) ?? "", /已经有叫「explore」/, "a built-in name is taken too");
  assert.match(problem({ description: "   " }) ?? "", /请写一句说明/);
  assert.match(problem({ systemPrompt: "\n " }) ?? "", /请写提示词/);
  assert.match(problem({ tools: [] }) ?? "", /请至少选一个工具/);
  assert.match(problem({ tools: ["not-a-tool"] }) ?? "", /请至少选一个工具/, "a tool that is not offered does not count");
  assert.equal(problem({ name: "", description: "", systemPrompt: "", tools: [] }), "请填名字。", "the name comes first");
});

test("editing does not check the name, which cannot change, but still needs the rest", () => {
  const edit = (overrides: Partial<SubagentDraft>) => subagentDraftProblem(draft(overrides), "edit", OFFERED, ["db-expert"]);
  assert.equal(edit({}), undefined, "its own name is not a duplicate of itself");
  assert.match(edit({ description: "" }) ?? "", /请写一句说明/);
  assert.match(edit({ systemPrompt: "" }) ?? "", /请写提示词/);
  assert.match(edit({ tools: [] }) ?? "", /请至少选一个工具/);
});

test("what is sent is trimmed and lists the tools in the order they are offered", () => {
  const input = subagentDraftToInput(
    draft({ name: " db-expert ", description: "  Knows\nthe schema  ", systemPrompt: "\n You check SQL.\n", tools: ["grep", "read", "mystery", "edit"], worktree: true, scope: "project" }),
    OFFERED,
  );
  assert.deepEqual(input, {
    name: "db-expert",
    scope: "project",
    description: "Knows\nthe schema",
    systemPrompt: "You check SQL.",
    tools: ["read", "edit", "grep"],
    worktree: true,
  });
  assert.equal("model" in input, false, "the model goes through the models setting, not the profile file");
});

test("editing opens with what the file holds, and the model chosen for it", () => {
  const profile: SubagentProfileInfo = {
    name: "release", description: "Cuts a release", source: "project", filePath: "/p/.coilcoil/agents/release.md",
    tools: ["read", "bash"], worktree: true, fileModel: undefined, systemPrompt: "You cut releases.",
  };
  assert.deepEqual(subagentDraftFromProfile(profile as SubagentProfileInfo & { source: "project" }, "pierce/gpt"), {
    name: "release", scope: "project", description: "Cuts a release", systemPrompt: "You cut releases.",
    tools: ["read", "bash"], worktree: true, model: "pierce/gpt",
  });
  const copy = subagentDraftFromProfile(profile as SubagentProfileInfo & { source: "project" }, "");
  copy.tools.push("edit");
  assert.deepEqual(profile.tools, ["read", "bash"], "changing the draft does not change the listed profile");
});

test("only the ones the user wrote can be edited or deleted", () => {
  assert.equal(isCustomSubagent({ source: "builtin" }), false);
  assert.equal(isCustomSubagent({ source: "user" }), true);
  assert.equal(isCustomSubagent({ source: "project" }), true);
});

test("the model choices: none first, a model that went away shown but not pickable, then the usable ones", () => {
  const models = [
    { provider: "pierce", providerName: "Pierce", id: "glm", name: "GLM", configured: true },
    { provider: "pierce", providerName: "Pierce", id: "gpt", name: "GPT", configured: true },
  ] as never;
  const plain = subagentModelOptions({ selected: "", models });
  assert.equal(plain[0].value, "");
  assert.match(plain[0].label, /未配置（此子 Agent 不可用）/);
  assert.deepEqual(plain.slice(1).map((option) => option.value), ["pierce/glm", "pierce/gpt"]);

  const withFile = subagentModelOptions({ selected: "", fileModel: "x/y", models });
  assert.match(withFile[0].label, /沿用文件里写的模型（x\/y）/);

  const gone = subagentModelOptions({ selected: "old/model", models });
  assert.deepEqual(gone.map((option) => [option.value, option.disabled ?? false]), [["", false], ["old/model", true], ["pierce/glm", false], ["pierce/gpt", false]]);

  const present = subagentModelOptions({ selected: "pierce/gpt", models });
  assert.equal(present.length, 3, "a model that is available is listed once");
});

test("every tool the runtime offers has a plain-words description", () => {
  for (const tool of OFFERED) assert.notEqual(subagentToolBlurb(tool), "", tool);
  assert.equal(subagentToolBlurb("some-future-tool"), "", "an unknown tool falls back to showing just its name");
});
