import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillConfigurationSnapshot, SkillEntry } from "@suocode/runtime-protocol";
import test from "node:test";
import { SuoCodeRuntime } from "../src/index.js";
import { skillIsRemoved } from "../src/skill-overrides.js";

interface DeleteSkillRuntime {
  agentDir: string;
  mcpCwd(cwd?: string): string;
  getSkillConfiguration(cwd?: string): Promise<SkillConfigurationSnapshot>;
  skillSettingsManager(cwd?: string): { getSkillPaths(): string[]; setSkillPaths(paths: string[]): void };
  reloadActiveSessionResources(label?: string): void;
  updateActiveSkillConfiguration(cwd: string, snapshot: SkillConfigurationSnapshot): void;
  removeSkill(filePath: string, cwd?: string): Promise<SkillConfigurationSnapshot>;
  deleteSkill(filePath: string, cwd?: string): Promise<SkillConfigurationSnapshot>;
  expandSkillPath(path: string): string;
  addSkillPath(path: string, cwd?: string): Promise<SkillConfigurationSnapshot>;
}

function snapshot(agentDir: string, skills: SkillEntry[]): SkillConfigurationSnapshot {
  return {
    agentDir,
    userSkillsDir: join(agentDir, "skills"),
    projectSkillsDir: join(agentDir, "project-skills"),
    agentsSkillsDir: join(agentDir, "agents-skills"),
    skillPaths: [],
    projectSkillPaths: [],
    customSkillPaths: [],
    enableSkillCommands: true,
    skills,
    diagnostics: [],
  };
}

function userSkill(baseDir: string, filePath: string): SkillEntry {
  return {
    name: "demo",
    description: "demo skill",
    filePath,
    baseDir,
    source: "user",
    enabled: true,
    disableModelInvocation: false,
    scope: "user",
  };
}

function agentsSkill(baseDir: string, filePath: string): SkillEntry {
  return { ...userSkill(baseDir, filePath), source: "agents" };
}

test("deleteSkill removes a managed user skill and its stale override", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-skill-delete-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const skillDir = join(agentDir, "skills", "demo");
  const filePath = join(skillDir, "SKILL.md");
  const cwd = join(root, "project");
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "# demo\n");

  const entry = userSkill(skillDir, filePath);
  const runtime = Object.create(SuoCodeRuntime.prototype) as DeleteSkillRuntime;
  runtime.agentDir = agentDir;
  runtime.mcpCwd = (requested) => requested ?? cwd;
  let current = snapshot(agentDir, [entry]);
  runtime.getSkillConfiguration = async () => current;
  let paths = ["skills/demo/SKILL.md", "other-skill"];
  runtime.skillSettingsManager = () => ({
    getSkillPaths: () => paths,
    setSkillPaths: (next) => { paths = next; },
  });
  runtime.reloadActiveSessionResources = () => undefined;
  runtime.updateActiveSkillConfiguration = (_resolvedCwd, next) => { current = next; };

  current = await runtime.deleteSkill(filePath, cwd);

  assert.equal(existsSync(skillDir), false);
  assert.deepEqual(paths, ["other-skill"]);
  assert.deepEqual(current.skills, [entry]);
});

test("removeSkill removes an Agents skill import without deleting its source", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-skill-remove-agents-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const skillDir = join(root, ".agents", "skills", "eval");
  const filePath = join(skillDir, "SKILL.md");
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "# eval\n");

  const entry = agentsSkill(skillDir, filePath);
  const runtime = Object.create(SuoCodeRuntime.prototype) as DeleteSkillRuntime;
  runtime.agentDir = agentDir;
  runtime.mcpCwd = () => cwd;
  let paths: string[] = [];
  let current = snapshot(agentDir, [entry]);
  runtime.getSkillConfiguration = async () => current;
  runtime.skillSettingsManager = () => ({
    getSkillPaths: () => paths,
    setSkillPaths: (next) => {
      paths = next;
      current = snapshot(agentDir, []);
    },
  });
  runtime.reloadActiveSessionResources = () => undefined;
  runtime.updateActiveSkillConfiguration = (_resolvedCwd, next) => { current = next; };

  current = await runtime.removeSkill(filePath, cwd);

  assert.equal(existsSync(filePath), true);
  assert.deepEqual(paths, ["!skills/eval/SKILL.md"]);
  assert.deepEqual(current.skills, []);
  assert.equal(skillIsRemoved(entry, cwd, agentDir, paths, []), true);
});

test("deleteSkill refuses a user-scoped skill outside the managed directory", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-skill-delete-external-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const externalDir = join(root, "external", "demo");
  const filePath = join(externalDir, "SKILL.md");
  mkdirSync(externalDir, { recursive: true });
  writeFileSync(filePath, "# external\n");
  const entry = userSkill(externalDir, filePath);
  const runtime = Object.create(SuoCodeRuntime.prototype) as DeleteSkillRuntime;
  runtime.agentDir = agentDir;
  runtime.mcpCwd = () => root;
  runtime.getSkillConfiguration = async () => snapshot(agentDir, [entry]);

  await assert.rejects(() => runtime.deleteSkill(filePath), /只能删除 SuoCode 自维护目录中的技能/);
  assert.equal(existsSync(externalDir), true);
});

test("addSkillPath rejects invalid skills before copying them", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-skill-import-invalid-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const sourceDir = join(root, "imported-skills");
  const invalidDir = join(sourceDir, "missing-description");
  const cwd = join(root, "project");
  mkdirSync(invalidDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(invalidDir, "SKILL.md"), "# Missing description\n");

  const runtime = Object.create(SuoCodeRuntime.prototype) as DeleteSkillRuntime;
  runtime.agentDir = agentDir;
  runtime.mcpCwd = () => cwd;
  runtime.expandSkillPath = (path) => path;

  await assert.rejects(
    () => runtime.addSkillPath(sourceDir, cwd),
    /missing-description\/SKILL\.md：description is required/,
  );
  assert.equal(existsSync(join(agentDir, "skills", "imported-skills")), false);
});

test("deleteSkill removes a managed invalid diagnostic left by an old import", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-skill-delete-invalid-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const skillDir = join(agentDir, "skills", "broken");
  const filePath = join(skillDir, "SKILL.md");
  const cwd = join(root, "project");
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "# broken\n");

  const runtime = Object.create(SuoCodeRuntime.prototype) as DeleteSkillRuntime;
  runtime.agentDir = agentDir;
  runtime.mcpCwd = () => cwd;
  const current = snapshot(agentDir, []);
  current.diagnostics = [{ type: "warning", message: "description is required", path: filePath }];
  runtime.getSkillConfiguration = async () => current;
  runtime.reloadActiveSessionResources = () => undefined;
  runtime.updateActiveSkillConfiguration = () => undefined;

  await runtime.deleteSkill(filePath, cwd);

  assert.equal(existsSync(skillDir), false);
});
