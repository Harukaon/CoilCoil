import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MemoryConfigurationSnapshot,
  MemorySettings,
} from "@suocode/runtime-protocol";
import { SuoCodeRuntime } from "../src/index.js";

interface MemoryRuntime {
  agentDir: string;
  mcpCwd(cwd?: string): string;
  getMemoryConfiguration(cwd?: string): Promise<MemoryConfigurationSnapshot>;
  saveMemoryConfiguration(input: {
    settings: MemorySettings;
    globalContent: string;
    projectContent?: string;
    projectContents?: Array<{ filePath: string; content: string }>;
  }, cwd?: string): Promise<MemoryConfigurationSnapshot>;
  reloadActiveSessionResources(label?: string): void;
}

test("memory configuration reads and saves global and project documents", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-memory-config-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const storageRoot = join(root, "memory");
  const project = join(root, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  const previousStorage = process.env.PI_PROJECT_MEMORY_DIR;
  process.env.PI_PROJECT_MEMORY_DIR = storageRoot;
  const runtime = Object.create(SuoCodeRuntime.prototype) as MemoryRuntime;
  runtime.agentDir = agentDir;
  runtime.mcpCwd = (cwd) => cwd ?? project;
  let reloads = 0;
  runtime.reloadActiveSessionResources = () => { reloads += 1; };

  try {
    const initial = await runtime.getMemoryConfiguration(project);
    assert.equal(initial.settings.projectMaxChars, 1_000);
    assert.equal(initial.settings.globalMaxChars, 2_000);
    assert.equal(initial.global.exists, false);
    assert.equal(initial.project?.exists, false);

    const settings: MemorySettings = {
      ...initial.settings,
      projectMaxChars: 1_500,
      globalMaxChars: 3_000,
      generationRules: "只保留稳定约定",
      autoSummarize: false,
    };
    const saved = await runtime.saveMemoryConfiguration({
      settings,
      globalContent: "用户偏好：中文回复。",
      projectContent: "项目约定：单文件不超过 600 行。",
    }, project);

    assert.deepEqual(saved.settings, settings);
    assert.equal(saved.global.content, "用户偏好：中文回复。");
    assert.equal(saved.project?.content, "项目约定：单文件不超过 600 行。");
    assert.equal(saved.global.contentChars, Array.from(saved.global.content).length);
    assert.equal(reloads, 1);
    assert.equal(existsSync(join(agentDir, "memory-settings.json")), true);
    assert.equal(readFileSync(saved.global.filePath, "utf8"), "用户偏好：中文回复。");
  } finally {
    if (previousStorage === undefined) delete process.env.PI_PROJECT_MEMORY_DIR;
    else process.env.PI_PROJECT_MEMORY_DIR = previousStorage;
  }
});

test("memory configuration lists every project in the store, not just the open one", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-memory-projects-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const storageRoot = join(root, "memory");
  const project = join(root, "project-open");
  mkdirSync(join(project, ".git"), { recursive: true });
  // Two projects this machine is not currently working in, one of them empty.
  mkdirSync(join(storageRoot, "project-old"), { recursive: true });
  writeFileSync(join(storageRoot, "project-old", "MEMORY.md"), "旧项目：只用 pnpm。");
  mkdirSync(join(storageRoot, "project-blank"), { recursive: true });
  const previousStorage = process.env.PI_PROJECT_MEMORY_DIR;
  process.env.PI_PROJECT_MEMORY_DIR = storageRoot;
  const runtime = Object.create(SuoCodeRuntime.prototype) as MemoryRuntime;
  runtime.agentDir = join(root, "agent");
  runtime.mcpCwd = (cwd) => cwd ?? project;
  runtime.reloadActiveSessionResources = () => undefined;

  try {
    const listed = await runtime.getMemoryConfiguration(project);
    assert.deepEqual(listed.projects.map((document) => document.projectName), ["project-old", "project-open"]);
    assert.equal(listed.projects.find((document) => document.projectName === "project-old")?.content, "旧项目：只用 pnpm。");
    // The open project is listed before it has a file, because it is the one the
    // user is most likely to write; a stored project with no file at all is not.
    assert.equal(listed.projects.find((document) => document.projectName === "project-open")?.exists, false);
    assert.equal(listed.project?.filePath, listed.projects.find((document) => document.projectName === "project-open")?.filePath);

    const target = listed.projects.find((document) => document.projectName === "project-old")!;
    const saved = await runtime.saveMemoryConfiguration({
      settings: listed.settings,
      globalContent: "",
      projectContents: [{ filePath: target.filePath, content: "旧项目：迁到 npm 了。" }],
    }, project);
    assert.equal(saved.projects.find((document) => document.projectName === "project-old")?.content, "旧项目：迁到 npm 了。");
    assert.equal(readFileSync(target.filePath, "utf8"), "旧项目：迁到 npm 了。");

    // A path the store never listed is refused, whatever it points at.
    const outside = join(root, "escape.md");
    await assert.rejects(
      runtime.saveMemoryConfiguration({
        settings: listed.settings,
        globalContent: "",
        projectContents: [{ filePath: outside, content: "不该写到这里" }],
      }, project),
      /未知的项目记忆/,
    );
    assert.equal(existsSync(outside), false);
  } finally {
    if (previousStorage === undefined) delete process.env.PI_PROJECT_MEMORY_DIR;
    else process.env.PI_PROJECT_MEMORY_DIR = previousStorage;
  }
});
