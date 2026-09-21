/**
 * The bug report of 2026-09-21, turned into tests.
 *
 * Every case here failed before the fix: a removed skill that could not be
 * deleted, re-enabled or reinstalled; `save_json` asking for a field the schema
 * never offered; a full `mcp.json` handed to the model with a live API key in
 * it; write operations answering with the state from before the write.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { SkillConfigurationSnapshot, SkillEntry } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";
import { installSetupRpc, setupRpcReplyChannel } from "../src/runtime-setup-rpc.js";
import { SETUP_RPC_REQUEST_CHANNEL } from "../src/runtime-constants.js";
import {
  MASKED_SECRET_VALUE,
  maskMcpJsonText,
  restoreMcpJsonText,
} from "../src/setup-secrets.js";

interface SkillRuntime {
  agentDir: string;
  mcpCwd(cwd?: string): string;
  getSkillConfiguration(cwd?: string): Promise<SkillConfigurationSnapshot>;
  skillSettingsManager(cwd?: string): { getSkillPaths(): string[]; setSkillPaths(paths: string[]): void; flush(): Promise<void> };
  reloadActiveSessionResources(label?: string): void;
  updateActiveSkillConfiguration(cwd: string, snapshot: SkillConfigurationSnapshot): void;
  setSkillEnabled(filePath: string, enabled: boolean, cwd?: string): Promise<SkillConfigurationSnapshot>;
  removeSkill(filePath: string, cwd?: string): Promise<SkillConfigurationSnapshot>;
  deleteSkill(filePath: string, cwd?: string): Promise<SkillConfigurationSnapshot>;
  expandSkillPath(path: string): string;
  addSkillPath(path: string, cwd?: string): Promise<SkillConfigurationSnapshot>;
}

function snapshot(agentDir: string, skills: SkillEntry[], removedSkills: SkillEntry[] = []): SkillConfigurationSnapshot {
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
    removedSkills,
    diagnostics: [],
  };
}

function managedSkill(baseDir: string, filePath: string, name = "demo"): SkillEntry {
  return {
    name,
    description: "demo skill",
    filePath,
    baseDir,
    source: "user",
    enabled: true,
    disableModelInvocation: false,
    scope: "user",
  };
}

test("被 remove 隐藏的技能仍然删得掉：文件不再永久残留", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-skill-removed-delete-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const skillDir = join(agentDir, "skills", "demo");
  const filePath = join(skillDir, "SKILL.md");
  const cwd = join(root, "project");
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "# demo\n");

  const entry = managedSkill(skillDir, filePath);
  const runtime = Object.create(CoilCoilRuntime.prototype) as SkillRuntime;
  runtime.agentDir = agentDir;
  runtime.mcpCwd = (requested) => requested ?? cwd;
  // The state after `remove`: hidden from `skills`, still listed as removed.
  let current = snapshot(agentDir, [], [entry]);
  runtime.getSkillConfiguration = async () => current;
  let paths = ["!skills/demo/SKILL.md"];
  runtime.skillSettingsManager = () => ({
    getSkillPaths: () => paths,
    setSkillPaths: (next) => { paths = next; },
    flush: async () => undefined,
  });
  runtime.reloadActiveSessionResources = () => undefined;
  runtime.updateActiveSkillConfiguration = (_cwd, next) => { current = next; };

  await runtime.deleteSkill(filePath, cwd);

  assert.equal(existsSync(skillDir), false, "磁盘上的技能目录必须真的删掉");
  assert.deepEqual(paths, [], "settings 里的 ! 屏蔽记录也要一起清掉");
});

test("被 remove 隐藏的技能可以用 enable 恢复，disable 则明确拒绝", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-skill-removed-enable-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const skillDir = join(agentDir, "skills", "demo");
  const filePath = join(skillDir, "SKILL.md");
  const cwd = join(root, "project");
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "# demo\n");

  const entry = managedSkill(skillDir, filePath);
  const runtime = Object.create(CoilCoilRuntime.prototype) as SkillRuntime;
  runtime.agentDir = agentDir;
  runtime.mcpCwd = () => cwd;
  let current = snapshot(agentDir, [], [entry]);
  runtime.getSkillConfiguration = async () => current;
  let paths = ["!skills/demo/SKILL.md"];
  runtime.skillSettingsManager = () => ({
    getSkillPaths: () => paths,
    setSkillPaths: (next) => { paths = next; },
    flush: async () => undefined,
  });
  runtime.reloadActiveSessionResources = () => undefined;
  runtime.updateActiveSkillConfiguration = (_cwd, next) => { current = next; };

  await runtime.setSkillEnabled(filePath, true, cwd);
  assert.deepEqual(paths, ["+skills/demo/SKILL.md"], "enable 必须把 ! 换成 +，技能才回得来");

  paths = ["!skills/demo/SKILL.md"];
  await assert.rejects(() => runtime.setSkillEnabled(filePath, false, cwd), /已处于移除状态/);
});

test("重复 remove 不报错：同一个状态再要一次不是错误", async () => {
  const agentDir = "/agent";
  const entry = managedSkill("/agent/skills/demo", "/agent/skills/demo/SKILL.md");
  const runtime = Object.create(CoilCoilRuntime.prototype) as SkillRuntime;
  runtime.agentDir = agentDir;
  runtime.mcpCwd = () => "/project";
  const current = snapshot(agentDir, [], [entry]);
  runtime.getSkillConfiguration = async () => current;

  const result = await runtime.removeSkill(entry.filePath, "/project");
  assert.deepEqual(result.removedSkills, [entry]);
});

test("装同名技能会被直接拒绝，而不是悄悄复制一份 -2", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-skill-duplicate-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const installedDir = join(agentDir, "skills", "canvas-design");
  const sourceDir = join(root, "source", "canvas-design");
  const cwd = join(root, "project");
  mkdirSync(installedDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const frontmatter = "---\nname: canvas-design\ndescription: draws things\n---\n\n# canvas\n";
  writeFileSync(join(installedDir, "SKILL.md"), frontmatter);
  writeFileSync(join(sourceDir, "SKILL.md"), frontmatter);

  const runtime = Object.create(CoilCoilRuntime.prototype) as SkillRuntime;
  runtime.agentDir = agentDir;
  runtime.mcpCwd = () => cwd;
  runtime.expandSkillPath = (path) => path;
  runtime.getSkillConfiguration = async () => snapshot(agentDir, [
    managedSkill(installedDir, join(installedDir, "SKILL.md"), "canvas-design"),
  ]);

  await assert.rejects(() => runtime.addSkillPath(sourceDir, cwd), /已经装过同名技能/);
  assert.equal(existsSync(join(agentDir, "skills", "canvas-design-2")), false, "不能留下第二份副本");
});

test("mcp.json 整文读出来带掩码，改完回写能还原原值", () => {
  const document = `${JSON.stringify({
    mcpServers: {
      keenable: {
        url: "https://api.keenable.ai/mcp",
        headers: { "X-API-Key": "keen_real_secret", "X-Trace": "on" },
      },
      local: { command: "npx", env: { GITHUB_TOKEN: "ghp_real", MODE: "fast" } },
    },
  }, null, 2)}\n`;

  const masked = maskMcpJsonText(document);
  assert.doesNotMatch(masked, /keen_real_secret/);
  assert.doesNotMatch(masked, /ghp_real/);
  assert.match(masked, /X-Trace": "on"/, "普通字段不该被打码");
  assert.match(masked, /MODE": "fast"/);

  const restored = restoreMcpJsonText(masked, document);
  assert.match(restored, /keen_real_secret/, "掩码原样回写表示不改，必须还原");
  assert.match(restored, /ghp_real/);

  const edited = masked.replace("https://api.keenable.ai/mcp", "https://api.keenable.ai/v2/mcp");
  assert.match(restoreMcpJsonText(edited, document), /v2\/mcp/, "改过的字段要按新值写入");

  // 一个没有原值可还原的掩码，写进去就是一个坏掉的 Server。
  assert.throws(
    () => restoreMcpJsonText(`${JSON.stringify({
      mcpServers: { fresh: { url: "https://x/mcp", headers: { Authorization: MASKED_SECRET_VALUE } } },
    }, null, 2)}\n`, document),
    /还是掩码/,
  );
});

function setupHost(overrides: Record<string, unknown>): Record<string, unknown> {
  const fail = async () => { throw new Error("unused"); };
  return {
    getMcpConfiguration: async () => ({ configPath: "/tmp/mcp.json", imports: [], servers: [] }),
    getMcpJson: fail,
    saveMcpJson: fail,
    saveMcpServer: fail,
    removeMcpServer: fail,
    setMcpServerEnabled: fail,
    discoverMcpServers: fail,
    importMcpServers: fail,
    enableMcpImports: fail,
    connectMcpServer: fail,
    startMcpAuth: fail,
    awaitMcpAuthCallback: fail,
    finishMcpAuth: fail,
    awaitMcpAuth: fail,
    cancelMcpAuth: fail,
    completeMcpAuth: fail,
    logoutMcpServer: fail,
    setSessionMcpServerEnabled: fail,
    getSkillConfiguration: fail,
    setSkillEnabled: fail,
    removeSkill: fail,
    deleteSkill: fail,
    addSkillPath: fail,
    removeSkillPath: fail,
    setSessionSkillEnabled: fail,
    ...overrides,
  };
}

function ask(bus: ReturnType<typeof createEventBus>, requestId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const reply = new Promise<unknown>((resolve) => {
    bus.on(setupRpcReplyChannel(requestId), (raw) => resolve(raw));
  });
  bus.emit(SETUP_RPC_REQUEST_CHANNEL, { version: 1, requestId, method, params });
  return reply;
}

test("mcp_get_json 不再把密钥明文交给模型", async () => {
  const bus = createEventBus();
  const document = `${JSON.stringify({
    mcpServers: { keenable: { url: "https://api.keenable.ai/mcp", headers: { "X-API-Key": "keen_real_secret" } } },
  }, null, 2)}\n`;
  installSetupRpc(setupHost({ getMcpJson: async () => ({ path: "/tmp/mcp.json", content: document }) }) as never, bus, () => undefined);
  const answered = await ask(bus, "get-json", "mcp_get_json") as { success: boolean; data: { document: { content: string } } };
  assert.equal(answered.success, true);
  assert.doesNotMatch(JSON.stringify(answered), /keen_real_secret/);
  assert.match(answered.data.document.content, /X-API-Key": "••••••"/);
});

test("mcp_save_json 同时认 content 和工具真正传来的 text", async () => {
  const bus = createEventBus();
  const document = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
  const saved: string[] = [];
  installSetupRpc(setupHost({
    getMcpJson: async () => ({ path: "/tmp/mcp.json", content: document }),
    saveMcpJson: async (content: string) => {
      saved.push(content);
      return { configPath: "/tmp/mcp.json", imports: [], servers: [] };
    },
  }) as never, bus, () => undefined);

  const next = `${JSON.stringify({ mcpServers: { probe: { command: "npx" } } }, null, 2)}\n`;
  const viaText = await ask(bus, "save-json-text", "mcp_save_json", { text: next }) as { success: boolean };
  assert.equal(viaText.success, true, "工具传的是 text，必须收得下");
  const viaContent = await ask(bus, "save-json-content", "mcp_save_json", { content: next }) as { success: boolean };
  assert.equal(viaContent.success, true);
  assert.equal(saved.length, 2);
  assert.match(saved[0]!, /probe/);
});

test("工具能发出的每个 method，运行时都接得住", async () => {
  // 这正是 P0-2 的形状：两边各写各的字段名，谁也没发现对不上，直到用户去配一个
  // MCP 才发现唯一的合规通道是坏的。这条测试把两边钉在一起。
  const { resolveMcpMethod, resolveSkillMethod } = await import("../../workflow/extensions/setup-tool.js");
  const ops = {
    mcp: ["list", "save", "get_json", "save_json", "remove", "enable", "disable", "discover", "import",
      "enable_imports", "parse_snippet", "connect", "auth_start", "auth_await_each", "auth_finish",
      "auth_await", "auth_cancel", "auth_complete", "logout", "session_enable", "session_disable"],
    skill: ["list", "install", "enable", "disable", "remove", "delete", "remove_path", "session_enable", "session_disable"],
  };
  const methods = new Set<string>([
    ...ops.mcp.map((op) => resolveMcpMethod(op)).filter((method): method is string => Boolean(method)),
    ...ops.skill.map((op) => resolveSkillMethod(op)).filter((method): method is string => Boolean(method)),
  ]);
  assert.equal(methods.size >= ops.mcp.length, true, "每个 op 都要能解析成 method");

  const bus = createEventBus();
  installSetupRpc(setupHost({}) as never, bus, () => undefined);
  for (const method of methods) {
    const answered = await ask(bus, `contract-${method}`, method) as { success: boolean; error?: { message: string } };
    // 缺参数是应该报的，说「不支持这个方法」就是两边对不上了。
    if (!answered.success) assert.doesNotMatch(answered.error?.message ?? "", /不支持的配置方法/, method);
  }
});

test("被 remove 过的 MCP Server 重新保存时，黑名单记录会被清掉", (context) => {
  // 报告点名要核实的一条：mcp 侧和 skill 侧用了同样的「黑名单文件」写法，
  // 会不会也一删永不能加回来。答案是不会——保存时会先把墓碑清掉。
  const root = mkdtempSync(join(tmpdir(), "coilcoil-mcp-tombstone-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "mcp-removed-servers.json"), `${JSON.stringify({ servers: ["node_repl", "playwright"] })}\n`);

  const runtime = Object.create(CoilCoilRuntime.prototype) as {
    agentDir: string;
    readRemovedMcpServers(): Set<string>;
    clearMcpServerRemovedLocally(name: string): void;
  };
  Object.defineProperty(runtime, "agentDir", { value: agentDir });

  assert.equal(runtime.readRemovedMcpServers().has("node_repl"), true);
  runtime.clearMcpServerRemovedLocally("node_repl");
  assert.equal(runtime.readRemovedMcpServers().has("node_repl"), false, "重新保存同名 Server 必须能把它放回来");
  assert.equal(runtime.readRemovedMcpServers().has("playwright"), true, "别人的墓碑不要动");
});
