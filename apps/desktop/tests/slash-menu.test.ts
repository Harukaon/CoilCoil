import assert from "node:assert/strict";
import test from "node:test";
import type { McpConfigurationSnapshot, SkillEntry } from "@coilcoil/runtime-protocol";
import { buildSlashMenuItems, findSlashToken, resolveSlashMenu } from "../src/renderer/src/features/composer/useSlashSkills.ts";

function server(name: string, disabled = false): McpConfigurationSnapshot["servers"][number] {
  return { name, scope: "global", transport: "stdio", command: "npx thing", disabled } as never;
}

function skill(name: string): SkillEntry {
  return { name, description: `${name} 的说明`, filePath: `/skills/${name}.md`, enabled: true } as never;
}

test("选中一个 MCP 服务器是写进输入框，不是跳去设置页", () => {
  const items = buildSlashMenuItems([], [server("chrome-devtools")]);
  const row = items.find((item) => item.id === "mcp:chrome-devtools");
  assert.ok(row, "应该有这台服务器那一行");
  assert.equal(row.insert, "/mcp chrome-devtools ", "菜单里那行原样写进输入框，交给 Agent 判断");
  assert.equal(row.openSettings, undefined, "不能再把人踢去设置页");
});

test("已停用的服务器仍然跳设置——写进去也用不了", () => {
  const items = buildSlashMenuItems([], [server("已关掉的", true)]);
  const row = items.find((item) => item.id === "mcp:已关掉的");
  assert.ok(row);
  assert.equal(row.insert, undefined);
  assert.equal(row.openSettings, "mcp");
});

test("/mcp 和 /skills 这两条本来就是设置入口，保持原样", () => {
  const items = buildSlashMenuItems([], []);
  assert.equal(items.find((item) => item.id === "action:mcp")?.openSettings, "mcp");
  assert.equal(items.find((item) => item.id === "action:skills")?.openSettings, "skills");
});

test("/compact 在菜单里，选中是写进输入框而不是跳设置", () => {
  const items = buildSlashMenuItems([], []);
  const row = items.find((item) => item.id === "command:compact");
  assert.ok(row, "手动压缩得能在菜单里找得到，否则等于不存在");
  assert.equal(row.title, "/compact");
  // 写进输入框而不自带空格：直接回车就是压缩，想补要求再自己接着敲。
  assert.equal(row.insert, "/compact");
  assert.equal(row.openSettings, undefined);
});

test("技能仍然是写进输入框", () => {
  const items = buildSlashMenuItems([skill("pdf")], []);
  assert.equal(items.find((item) => item.id === "skill:/skills/pdf.md")?.insert, "/skill:pdf ");
});

test("斜杠后面带空格的查询照样能筛——/mcp chrome-devtools 这种名字本身就带空格", () => {
  assert.deepEqual(findSlashToken("/ xxx", 5), { query: "xxx", start: 0, end: 5, lineStart: true });
  assert.deepEqual(findSlashToken("/mcp chrome", 11), { query: "mcp chrome", start: 0, end: 11, lineStart: true });
  // 光标停在中间一个词上时，查询只到那个词为止。
  assert.deepEqual(findSlashToken("/mcp chrome", 4), { query: "mcp", start: 0, end: 4, lineStart: true });
  // 句子里带斜杠的普通文字：从那个斜杠算到光标所在的词。
  assert.deepEqual(findSlashToken("路径 /a/b 不存在", 8), { query: "a/b 不存在", start: 3, end: 11, lineStart: false });
  assert.deepEqual(findSlashToken("路径是 /a/b", 8), { query: "a/b", start: 4, end: 8, lineStart: false });
});

test("命令中间的斜杠只是正文的一部分", () => {
  assert.deepEqual(findSlashToken("看 / 记忆", 6), { query: "记忆", start: 2, end: 6, lineStart: false });
  assert.deepEqual(findSlashToken("看 /a/b", 6), { query: "a/b", start: 2, end: 6, lineStart: false });
});

test("给筛选词加空格不影响结果，/mcp 这种名字本身就带空格", () => {
  const items = buildSlashMenuItems([], []);
  assert.equal(resolveSlashMenu(items, findSlashToken("/ mcp", 5)).items.length, 1, "带空格也要能筛到");
  assert.equal(resolveSlashMenu(items, findSlashToken("/", 1)).items.length, items.length, "没写筛选词时列全部");
});

test("行首敲错命令说没有匹配，句子里写到斜杠就不挡着人", () => {
  const items = buildSlashMenuItems([], []);
  assert.equal(resolveSlashMenu(items, findSlashToken("/ xxx", 5)).active, true, "行首是在敲命令，说没匹配而不是默默消失");
  assert.equal(resolveSlashMenu(items, findSlashToken("看 /a/b 不存在", 12)).active, false, "中文正文里的斜杠不该弹菜单");
});

test("命令选完接着写正文时菜单收起，不挡着正在写的那句话", () => {
  const items = buildSlashMenuItems([skill("pdf")], []);
  assert.equal(resolveSlashMenu(items, findSlashToken("/skill:pdf 帮我总结这份文件", 20)).active, false);
  assert.equal(resolveSlashMenu(items, findSlashToken("/mcp beeswax 看下这个网页", 22)).active, false);
  // 命令还没写完时还是列出来让选。
  assert.equal(resolveSlashMenu(items, findSlashToken("/skill:pd", 9)).items.length, 1);
});
