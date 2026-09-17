import assert from "node:assert/strict";
import test from "node:test";
import type { McpConfigurationSnapshot, SkillEntry } from "@coilcoil/runtime-protocol";
import { buildSlashMenuItems } from "../src/renderer/src/features/composer/useSlashSkills.ts";

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

test("技能仍然是写进输入框", () => {
  const items = buildSlashMenuItems([skill("pdf")], []);
  assert.equal(items.find((item) => item.id === "skill:/skills/pdf.md")?.insert, "/skill:pdf ");
});
