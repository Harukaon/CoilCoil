import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  SubagentConfiguration,
  SubagentConfigurationInput,
  SubagentProfilesSnapshot,
} from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";

interface SubagentConfigurationRuntime {
  agentDir: string;
  workflowDir: string;
  getSubagentConfiguration(): Promise<SubagentConfiguration>;
  saveSubagentConfiguration(input: SubagentConfigurationInput): Promise<SubagentConfiguration>;
  listSubagentProfiles(cwd?: string): Promise<SubagentProfilesSnapshot>;
}

const WORKFLOW_DIR = join(import.meta.dirname, "..", "..", "workflow");

function runtimeIn(agentDir: string): SubagentConfigurationRuntime {
  const runtime = Object.create(CoilCoilRuntime.prototype) as SubagentConfigurationRuntime;
  runtime.agentDir = agentDir;
  runtime.workflowDir = WORKFLOW_DIR;
  return runtime;
}

function tempDirectory(context: { after(callback: () => void): void }, label: string): string {
  const root = mkdtempSync(join(tmpdir(), `coilcoil-subagent-${label}-`));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("subagent models are stored per profile name, and an empty choice clears the entry", async (context) => {
  const agentDir = join(tempDirectory(context, "config"), "agent");
  const runtime = runtimeIn(agentDir);

  assert.deepEqual(await runtime.getSubagentConfiguration(), { models: {} });

  const saved = await runtime.saveSubagentConfiguration({
    models: { explore: " provider/fast ", worker: "provider/code", reviewer: "" },
  });
  assert.deepEqual(saved, { models: { explore: "provider/fast", worker: "provider/code" } });
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "subagent-settings.json"), "utf8")), saved);
  assert.deepEqual(await runtime.getSubagentConfiguration(), saved);
});

test("any profile can have a model, including ones the product does not ship", async (context) => {
  const runtime = runtimeIn(join(tempDirectory(context, "custom"), "agent"));
  const saved = await runtime.saveSubagentConfiguration({
    models: { hacker: "provider/hack", "db-expert": "provider/db" },
  });
  assert.deepEqual(saved.models, { hacker: "provider/hack", "db-expert": "provider/db" });
});

test("saving names only some profiles: the rest keep the model they had", async (context) => {
  // A panel only knows the profiles of the project it is open on. If saving replaced the
  // whole map, opening another project and pressing save would drop a project profile's model.
  const runtime = runtimeIn(join(tempDirectory(context, "merge"), "agent"));
  await runtime.saveSubagentConfiguration({
    models: { explore: "provider/fast", worker: "provider/code", "project-only": "provider/proj" },
  });
  const saved = await runtime.saveSubagentConfiguration({ models: { explore: "", reviewer: "provider/review" } });
  assert.deepEqual(saved.models, {
    worker: "provider/code",
    "project-only": "provider/proj",
    reviewer: "provider/review",
  });
});

test("legacy single-model subagent settings migrate to the three profiles that existed then", async (context) => {
  const agentDir = join(tempDirectory(context, "legacy"), "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "subagent-settings.json"), JSON.stringify({ model: "provider/legacy" }));
  const runtime = runtimeIn(agentDir);

  assert.deepEqual(await runtime.getSubagentConfiguration(), {
    models: {
      explore: "provider/legacy",
      worker: "provider/legacy",
      reviewer: "provider/legacy",
    },
  });
});

test("a legacy model does not override a profile the file spells out, even one that is cleared", async (context) => {
  const agentDir = join(tempDirectory(context, "legacy-mixed"), "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "subagent-settings.json"),
    JSON.stringify({ model: "provider/legacy", models: { worker: "", reviewer: "provider/review" } }),
  );
  const runtime = runtimeIn(agentDir);

  assert.deepEqual((await runtime.getSubagentConfiguration()).models, {
    explore: "provider/legacy",
    reviewer: "provider/review",
  });
});

test("subagent configuration rejects input that is not a map of names to model strings", async (context) => {
  const runtime = runtimeIn(join(tempDirectory(context, "invalid"), "agent"));
  for (const input of [undefined, {}, { models: "provider/fast" }, { models: ["provider/fast"] }, { models: { explore: 1 } }]) {
    await assert.rejects(runtime.saveSubagentConfiguration(input as never), /子代理配置无效/, JSON.stringify(input));
  }
});

test("a settings entry cannot rewrite the prototype of the map it lives in", async (context) => {
  const agentDir = join(tempDirectory(context, "proto"), "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "subagent-settings.json"), '{"models":{"__proto__":"provider/evil","explore":"provider/fast"}}');
  const runtime = runtimeIn(agentDir);

  assert.deepEqual((await runtime.getSubagentConfiguration()).models, { explore: "provider/fast" });
  const saved = await runtime.saveSubagentConfiguration({ models: JSON.parse('{"__proto__":"provider/evil","worker":"provider/code"}') });
  assert.deepEqual(saved.models, { explore: "provider/fast", worker: "provider/code" });
  assert.equal(({} as Record<string, unknown>).evil, undefined);
  assert.equal(Object.getPrototypeOf(saved.models), Object.prototype);
});

test("the profile list merges built-in, user and project profiles the way the subagent tool does", async (context) => {
  const root = tempDirectory(context, "list");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(join(project, ".coilcoil", "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "agents", "db-expert.md"),
    '---\nname: db-expert\ndescription: "Knows the database schema"\ntools: [read, grep]\nmodel: provider/in-file\n---\n\nYou know the schema.\n',
  );
  writeFileSync(
    join(project, ".coilcoil", "agents", "release.md"),
    "---\nname: release\ndescription: Cuts a release\nworktree: true\n---\nFollow the release checklist.\n",
  );
  const runtime = runtimeIn(agentDir);

  const withProject = await runtime.listSubagentProfiles(project);
  const names = withProject.profiles.map((profile) => profile.name);
  for (const builtin of ["explore", "reviewer", "worker"]) assert.ok(names.includes(builtin), builtin);
  const sources = withProject.profiles.map((profile) => profile.source);
  assert.deepEqual(sources, [...sources].sort((left, right) => ["builtin", "user", "project"].indexOf(left) - ["builtin", "user", "project"].indexOf(right)));
  assert.equal(names.at(-1), "release");

  const dbExpert = withProject.profiles.find((profile) => profile.name === "db-expert");
  assert.deepEqual(
    { ...dbExpert, filePath: undefined },
    {
      name: "db-expert",
      description: "Knows the database schema",
      source: "user",
      filePath: undefined,
      tools: ["read", "grep"],
      worktree: false,
      fileModel: "provider/in-file",
      systemPrompt: "You know the schema.",
    },
  );
  assert.equal(dbExpert?.filePath, join(agentDir, "agents", "db-expert.md"));

  const release = withProject.profiles.find((profile) => profile.name === "release");
  assert.equal(release?.source, "project");
  assert.equal(release?.worktree, true);
  // No tool list of its own: it is granted the default set, which the form also offers.
  assert.deepEqual(release?.tools, withProject.availableTools);
  assert.ok(withProject.availableTools.includes("read") && withProject.availableTools.includes("mcp"));

  // Without an open project, the project's own profiles are not listed.
  const withoutProject = await runtime.listSubagentProfiles();
  assert.equal(withoutProject.profiles.some((profile) => profile.name === "release"), false);
  assert.equal(withoutProject.profiles.some((profile) => profile.name === "db-expert"), true);
});

test("a user profile with a built-in's name replaces it in the list, as it does when dispatching", async (context) => {
  const agentDir = join(tempDirectory(context, "override"), "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "explore.md"), "---\nname: explore\ndescription: My own explorer\n---\nLook around.\n");
  const profiles = (await runtimeIn(agentDir).listSubagentProfiles()).profiles;
  const explores = profiles.filter((profile) => profile.name === "explore");
  assert.equal(explores.length, 1);
  assert.equal(explores[0]?.source, "user");
  assert.equal(explores[0]?.description, "My own explorer");
});
