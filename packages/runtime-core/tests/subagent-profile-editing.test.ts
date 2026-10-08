import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  SaveSubagentProfileInput,
  SubagentConfiguration,
  SubagentConfigurationInput,
  SubagentProfileScope,
  SubagentProfilesSnapshot,
} from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";

/**
 * Creating, changing and deleting the subagent profiles a user writes.
 *
 * A profile is a Markdown file the subagent tool parses when a session starts, so the
 * property that matters is that what the form writes reads back as the same profile, and
 * that nothing else on disk is touched: not a built-in, not a file this code cannot read.
 */

interface ProfileRuntime {
  agentDir: string;
  workflowDir: string;
  getSubagentConfiguration(): Promise<SubagentConfiguration>;
  saveSubagentConfiguration(input: SubagentConfigurationInput): Promise<SubagentConfiguration>;
  listSubagentProfiles(cwd?: string): Promise<SubagentProfilesSnapshot>;
  saveSubagentProfile(input: SaveSubagentProfileInput, cwd?: string): Promise<SubagentProfilesSnapshot>;
  deleteSubagentProfile(name: string, scope: SubagentProfileScope, cwd?: string): Promise<SubagentProfilesSnapshot>;
}

const WORKFLOW_DIR = join(import.meta.dirname, "..", "..", "workflow");

function setup(context: { after(callback: () => void): void }): { runtime: ProfileRuntime; agentDir: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-subagent-edit-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const runtime = Object.create(CoilCoilRuntime.prototype) as ProfileRuntime;
  runtime.agentDir = agentDir;
  runtime.workflowDir = WORKFLOW_DIR;
  return { runtime, agentDir, project };
}

const valid: SaveSubagentProfileInput = {
  name: "db-expert",
  scope: "user",
  description: "Answers questions about the database schema",
  systemPrompt: "You know the schema.\n\nAnswer from the migrations.",
  tools: ["read", "grep", "ls"],
  worktree: false,
};

test("a saved profile reads back as the same profile, and the list shows it", async (context) => {
  const { runtime, agentDir } = setup(context);
  const snapshot = await runtime.saveSubagentProfile(valid);

  const saved = snapshot.profiles.find((profile) => profile.name === "db-expert");
  assert.ok(saved);
  assert.equal(saved.source, "user");
  assert.equal(saved.description, valid.description);
  assert.equal(saved.systemPrompt, valid.systemPrompt);
  assert.deepEqual(saved.tools, ["read", "grep", "ls"]);
  assert.equal(saved.worktree, false);
  assert.equal(saved.filePath, join(agentDir, "agents", "db-expert.md"));
  assert.ok(snapshot.profiles.some((profile) => profile.name === "worker" && profile.source === "builtin"), "the built-in ones are still there");
});

test("what the form writes survives awkward text: quotes, colons, a line of dashes, several lines", async (context) => {
  const { runtime } = setup(context);
  const awkward: SaveSubagentProfileInput = {
    ...valid,
    name: "tricky",
    description: '  Says "hi": checks\nthe thing --- twice  ',
    systemPrompt: "---\nnot a header\n---\n\nname: someone-else\ntools: [mcp]\n",
    tools: ["read", "edit", "write", "bash", "terminal"],
    worktree: true,
  };
  const saved = (await runtime.saveSubagentProfile(awkward)).profiles.find((profile) => profile.name === "tricky");
  assert.ok(saved);
  assert.equal(saved.description, 'Says "hi": checks the thing --- twice', "one line, whitespace collapsed, nothing else lost");
  assert.equal(saved.systemPrompt, awkward.systemPrompt.trim(), "a body that looks like a header stays a body");
  assert.deepEqual(saved.tools, ["read", "edit", "write", "bash", "terminal"]);
  assert.equal(saved.worktree, true);
  assert.equal((await runtime.listSubagentProfiles()).profiles.filter((profile) => profile.name === "someone-else").length, 0);
});

test("saving again changes the file in place; the model the file names is kept", async (context) => {
  const { runtime, agentDir } = setup(context);
  const dir = join(agentDir, "agents");
  mkdirSync(dir, { recursive: true });
  // Written by hand: a different file name from the profile name, and a model of its own.
  writeFileSync(
    join(dir, "legacy-file.md"),
    '---\nname: db-expert\ndescription: "old"\nmodel: provider/in-file\ntools: [read]\n---\n\nOld prompt.\n',
  );
  const snapshot = await runtime.saveSubagentProfile({ ...valid, description: "new description" });
  const saved = snapshot.profiles.find((profile) => profile.name === "db-expert");
  assert.equal(saved?.description, "new description");
  assert.equal(saved?.fileModel, "provider/in-file", "the model written in the file is not dropped by an edit");
  assert.equal(saved?.filePath, join(dir, "legacy-file.md"), "it is the same file, not a second one");
  assert.deepEqual(readdirSync(dir), ["legacy-file.md"]);
});

test("a project profile goes in the project's folder and needs a project", async (context) => {
  const { runtime, agentDir, project } = setup(context);
  await assert.rejects(runtime.saveSubagentProfile({ ...valid, scope: "project" }), /没有打开项目/);
  assert.equal(existsSync(join(agentDir, "agents")), false, "a refused save leaves nothing behind");

  const snapshot = await runtime.saveSubagentProfile({ ...valid, scope: "project" }, project);
  const saved = snapshot.profiles.find((profile) => profile.name === "db-expert");
  assert.equal(saved?.source, "project");
  assert.equal(saved?.filePath, join(project, ".coilcoil", "agents", "db-expert.md"));
  // It is only listed while that project is the open one.
  assert.equal((await runtime.listSubagentProfiles()).profiles.some((profile) => profile.name === "db-expert"), false);
});

test("the same name may exist for the user and for a project; the project one is what is listed", async (context) => {
  const { runtime, project } = setup(context);
  await runtime.saveSubagentProfile({ ...valid, description: "for everyone" });
  const snapshot = await runtime.saveSubagentProfile({ ...valid, scope: "project", description: "for this project" }, project);
  const shown = snapshot.profiles.filter((profile) => profile.name === "db-expert");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].source, "project");
  assert.equal(shown[0].description, "for this project");
});

test("a built-in's name cannot be taken, and a file that is not a profile is never overwritten", async (context) => {
  const { runtime, agentDir } = setup(context);
  for (const name of ["explore", "hacker", "reviewer", "worker"]) {
    await assert.rejects(runtime.saveSubagentProfile({ ...valid, name }), /内置子 Agent 的名字/, name);
  }
  assert.equal(existsSync(join(agentDir, "agents", "worker.md")), false, "nothing was written under a built-in's name");

  const dir = join(agentDir, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.md"), "my own notes, no front matter\n");
  await assert.rejects(runtime.saveSubagentProfile({ ...valid, name: "notes" }), /已经存在，但不是能识别的子 Agent 文件/);
  assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "my own notes, no front matter\n", "the file is untouched");
});

test("input that cannot make a usable profile is refused with a reason, and writes nothing", async (context) => {
  const { runtime, agentDir } = setup(context);
  const cases: Array<[Partial<SaveSubagentProfileInput> | unknown, RegExp]> = [
    [{ name: "" }, /名字/],
    [{ name: "Has Space" }, /名字/],
    [{ name: "UPPER" }, /名字/],
    [{ name: "../escape" }, /名字/],
    [{ name: "a/b" }, /名字/],
    [{ name: "x".repeat(49) }, /名字/],
    [{ name: "con" }, /名字/],
    [{ name: "__proto__" }, /名字/],
    [{ description: "   " }, /说明/],
    [{ description: "d".repeat(401) }, /说明太长/],
    [{ systemPrompt: " \n " }, /提示词/],
    [{ systemPrompt: "p".repeat(30_001) }, /提示词太长/],
    [{ tools: [] }, /至少选一个工具/],
    [{ tools: ["read", "rm-rf"] }, /只能选列表里有的/],
    [{ tools: "read" }, /至少选一个工具/],
    [{ scope: "builtin" }, /保存位置无效/],
    [{ scope: undefined }, /保存位置无效/],
    [null, /子 Agent 配置无效/],
  ];
  for (const [patch, message] of cases) {
    const input = patch === null ? null : { ...valid, ...(patch as object) };
    await assert.rejects(runtime.saveSubagentProfile(input as SaveSubagentProfileInput), message, JSON.stringify(patch));
  }
  assert.equal(existsSync(join(agentDir, "agents")), false, "no refused save created the folder");
});

test("a profile name cannot reach outside the profile folder", async (context) => {
  const { runtime, agentDir } = setup(context);
  await assert.rejects(runtime.saveSubagentProfile({ ...valid, name: "../../outside" }), /名字/);
  assert.equal(existsSync(join(agentDir, "outside.md")), false);
  assert.equal(existsSync(join(agentDir, "..", "outside.md")), false);
  await assert.rejects(runtime.deleteSubagentProfile("../../outside", "user"), /没有找到/);
});

test("a tool a hand-written profile uses, but the form does not offer, is kept when it is edited", async (context) => {
  const { runtime, agentDir } = setup(context);
  const dir = join(agentDir, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "finder.md"), "---\nname: finder\ndescription: Finds files\ntools: [read, find]\n---\n\nFind things.\n");
  const before = (await runtime.listSubagentProfiles()).profiles.find((profile) => profile.name === "finder");
  assert.deepEqual(before?.tools, ["read", "find"]);
  const after = (await runtime.saveSubagentProfile({
    ...valid, name: "finder", description: "Finds files, faster", tools: before!.tools,
  })).profiles.find((profile) => profile.name === "finder");
  assert.deepEqual(after?.tools, ["read", "find"]);
});

test("deleting removes the file and the model chosen for it, and leaves everything else", async (context) => {
  const { runtime, agentDir } = setup(context);
  await runtime.saveSubagentProfile(valid);
  await runtime.saveSubagentProfile({ ...valid, name: "other" });
  await runtime.saveSubagentConfiguration({ models: { "db-expert": "provider/a", other: "provider/b", worker: "provider/c" } });

  const snapshot = await runtime.deleteSubagentProfile("db-expert", "user");
  assert.equal(snapshot.profiles.some((profile) => profile.name === "db-expert"), false);
  assert.equal(snapshot.profiles.some((profile) => profile.name === "other"), true);
  assert.equal(existsSync(join(agentDir, "agents", "db-expert.md")), false);
  assert.equal(existsSync(join(agentDir, "agents", "other.md")), true);
  assert.deepEqual(
    (await runtime.getSubagentConfiguration()).models,
    { other: "provider/b", worker: "provider/c" },
    "only the deleted profile's model went with it",
  );
});

test("deleting a project profile keeps the model while a user profile of that name still exists", async (context) => {
  const { runtime, project } = setup(context);
  await runtime.saveSubagentProfile(valid);
  await runtime.saveSubagentProfile({ ...valid, scope: "project" }, project);
  await runtime.saveSubagentConfiguration({ models: { "db-expert": "provider/a" } });

  const snapshot = await runtime.deleteSubagentProfile("db-expert", "project", project);
  assert.equal(snapshot.profiles.find((profile) => profile.name === "db-expert")?.source, "user", "the user's one shows through again");
  assert.deepEqual((await runtime.getSubagentConfiguration()).models, { "db-expert": "provider/a" });
});

test("deleting something that is not there, or a built-in, is an error and removes nothing", async (context) => {
  const { runtime, agentDir } = setup(context);
  await runtime.saveSubagentProfile(valid);
  await assert.rejects(runtime.deleteSubagentProfile("missing", "user"), /没有找到要删除的子 Agent/);
  // A built-in lives in neither the user's nor the project's folder, so it cannot be deleted from either.
  await assert.rejects(runtime.deleteSubagentProfile("worker", "user"), /没有找到要删除的子 Agent/);
  await assert.rejects(runtime.deleteSubagentProfile("worker", "builtin" as SubagentProfileScope), /保存位置无效/);
  await assert.rejects(runtime.deleteSubagentProfile("db-expert", "project"), /没有打开项目/);
  assert.equal(existsSync(join(agentDir, "agents", "db-expert.md")), true);
  assert.ok(existsSync(join(WORKFLOW_DIR, "agents", "worker.md")), "the shipped profile is still on disk");
});
