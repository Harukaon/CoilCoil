import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
