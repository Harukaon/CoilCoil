import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentDirFromEnv,
  isSensitiveConfigKey,
  missingEnvPlaceholders,
  readBundledDoc,
  modelSetupGuide,
  setupGuide,
  SETUP_MASKED_VALUE,
  summarizeBundledDoc,
} from "../extensions/setup-guide.ts";
import {
  COILCOIL_TOOL_NAME,
  CoilcoilParams,
  isDisableOp,
  resolveMcpMethod,
  resolveModelMethod,
  resolveSkillMethod,
  sessionMcpText,
  SETUP_RPC_REPLY_PREFIX,
  SETUP_RPC_REQUEST_CHANNEL,
  skillDoneText,
} from "../extensions/setup-tool.ts";
// 通道常量按值断言，不跨包导入 runtime-core（strip-types 下 .js 后缀跨包解析不了）。
const CORE_REQUEST_CHANNEL = "coilcoil:setup:rpc:v1:request";
const CORE_REPLY_PREFIX = "coilcoil:setup:rpc:v1:reply:";
const setupRpcReplyChannel = (requestId: string): string => `${CORE_REPLY_PREFIX}${requestId}`;
// installSetupRpc 的行为（脱敏回显、掩码回写还原、无会话直说）在
// runtime-core 那侧有自己的测试覆盖；这里只断通道常量按值一致。

test("通道常量两边一致，改一边另一边跟着变", () => {
  assert.equal(SETUP_RPC_REQUEST_CHANNEL, CORE_REQUEST_CHANNEL);
  assert.equal(SETUP_RPC_REPLY_PREFIX, CORE_REPLY_PREFIX);
  assert.equal(setupRpcReplyChannel("abc"), "coilcoil:setup:rpc:v1:reply:abc");
});

test("工具名就叫 coilcoil，一个顶三个", () => {
  assert.equal(COILCOIL_TOOL_NAME, "coilcoil");
});

test("guide 四个 topic 都有教程，且点了名目录", () => {
  const agentDir = join(tmpdir(), "agent");
  for (const topic of ["skill", "mcp", "auth", "model"] as const) {
    const text = setupGuide(topic, agentDir);
    assert.ok(text.length > 100, topic);
  }
  assert.match(setupGuide("skill", agentDir), /SKILL\.md/);
  assert.match(setupGuide("skill", agentDir), /bash\/cp 自己拷/);
  assert.match(setupGuide("mcp", agentDir), /mcp\.json/);
  assert.match(setupGuide("mcp", agentDir), /parse_snippet/);
  assert.match(setupGuide("auth", agentDir), /auth_start/);
  assert.match(setupGuide("model", agentDir), /contextWindow/);
  assert.match(modelSetupGuide(), /OpenRouter/);
  assert.match(modelSetupGuide(), /auth_respond/);
});

test("agent 目录跟着 PI_CODING_AGENT_DIR 走", () => {
  assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "/tmp/foo" } as NodeJS.ProcessEnv), "/tmp/foo");
  assert.match(agentDirFromEnv({} as NodeJS.ProcessEnv), /\.pi/);
});

test("敏感键规则和面板一致", () => {
  assert.equal(isSensitiveConfigKey("GITHUB_TOKEN"), true);
  assert.equal(isSensitiveConfigKey("apiKey"), true);
  assert.equal(isSensitiveConfigKey("command"), false);
  assert.equal(SETUP_MASKED_VALUE, "••••••");
});

test("缺的环境变量能点名", () => {
  const missing = missingEnvPlaceholders(
    {
      command: "npx",
      args: ["-y", "x"],
      env: { KEY: "${MISSING_ONE}" },
      url: undefined,
      headers: {},
    },
    {},
  );
  assert.deepEqual(missing, ["MISSING_ONE"]);
});

test("文档按名读，超长截断标出来", () => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-setup-doc-"));
  try {
    const workflowDir = join(root, "packages", "workflow");
    const docsDir = join(root, "docs");
    mkdirSync(join(workflowDir, "extensions"), { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(root, "README.md"), "# hi\n");
    writeFileSync(join(docsDir, "architecture.md"), `${"x".repeat(100)}\n`);
    const found = readBundledDoc(workflowDir, "architecture");
    assert.match(found.path, /architecture\.md$/);
    const preview = summarizeBundledDoc(found.path, found.content, 10);
    assert.equal(preview.truncated, true);
    assert.match(preview.content, /只读了前 10 字/);
    assert.throws(() => readBundledDoc(workflowDir, "nope"), /没有这份文档/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("model area 的 schema 覆盖面板模型能力和凭据字段", () => {
  const schema = CoilcoilParams as unknown as { properties: Record<string, Record<string, any>> };
  assert.equal(schema.properties.area.enum?.includes("model"), true);
  const provider = schema.properties.provider;
  for (const field of ["id", "baseUrl", "api", "models", "modelsMode", "apiKey", "credential"]) {
    assert.ok(provider.properties?.[field], `provider.${field} 必须在 schema 里`);
  }
  const model = provider.properties?.models?.items as { properties?: Record<string, unknown> };
  for (const field of ["contextWindow", "maxTokens", "reasoning", "thinkingLevelMap", "input", "cost", "samplingParams", "headers", "compat"]) {
    assert.ok(model.properties?.[field], `provider.models[].${field} 必须在 schema 里`);
  }
  for (const op of ["list", "save", "fetch_models", "catalog", "test", "auth_start", "auth_status", "auth_await", "auth_respond", "auth_cancel", "logout", "ws_get", "ws_save"]) {
    assert.ok(resolveModelMethod(op), `model op「${op}」必须存在`);
  }
  assert.equal(resolveModelMethod("set_default"), undefined);
  assert.equal(resolveModelMethod("use"), undefined);
  assert.equal(resolveModelMethod("summarizer"), undefined);
});

test("save 的 server 参数有完整字段，不是一个空 schema", () => {
  // 空 schema（Type.Any）序列化成 {}：模型看不出要填什么，provider 也可能直接把
  // 这个参数丢掉——save 于是永远收到「缺少 server」，唯一合规的配置通道是坏的。
  const schema = CoilcoilParams as unknown as { properties: Record<string, Record<string, unknown>> };
  const server = schema.properties.server as { properties?: Record<string, unknown>; type?: string };
  assert.equal(server.type, "object");
  for (const field of ["name", "scope", "transport", "command", "url", "env", "headers", "args"]) {
    assert.ok(server.properties?.[field], `server.${field} 必须在 schema 里`);
  }
  const servers = schema.properties.servers as { type?: string };
  const imports = schema.properties.imports as { type?: string };
  assert.equal(servers.type, "array");
  assert.equal(imports.type, "array");
});

test("guide 里写的 op 名字必须真的能调用", () => {
  const guide = setupGuide("skill", "/agent");
  const mentioned = [...guide.matchAll(/op=([a-z_]+)/g)].map((match) => match[1]!);
  assert.ok(mentioned.length >= 4);
  for (const op of mentioned) {
    assert.ok(resolveSkillMethod(op), `教程提到的 skill op「${op}」必须存在`);
  }
  // 报告里踩的就是这条：教程写 disable_session，实际叫 session_disable。
  assert.doesNotMatch(guide, /op=disable_session/);
  assert.match(guide, /op=session_disable/);
  // 旧名仍然认，免得别处的旧文案继续把人带沟里。
  assert.equal(resolveSkillMethod("disable_session"), "skill_set_session_enabled");
  assert.equal(resolveMcpMethod("disable_session"), "mcp_set_session_enabled");
});

test("开关类 op 不填 enabled 也能判断开还是关", () => {
  assert.equal(isDisableOp("disable"), true);
  assert.equal(isDisableOp("session_disable"), true);
  assert.equal(isDisableOp("disable_session"), true);
  assert.equal(isDisableOp("enable"), false);
  assert.equal(isDisableOp("session_enable"), false);
});

test("删除类操作不再复用「装完」的文案", () => {
  assert.match(skillDoneText("skill_install", true), /已装好/);
  assert.match(skillDoneText("skill_delete", true), /已删除/);
  assert.doesNotMatch(skillDoneText("skill_delete", true), /装完/);
  // 移除是可逆的，必须把回头路说清楚，否则用户以为技能废了。
  assert.match(skillDoneText("skill_remove", true), /op=enable/);
  assert.match(skillDoneText("skill_remove", true), /op=delete/);
  assert.match(skillDoneText("skill_set_enabled", false), /已停用/);
  assert.equal(skillDoneText("skill_list", true), "");
});

test("会话级 MCP 开关说人话，救不回来的情况直说", () => {
  const inspection = (server: Record<string, unknown>): unknown => ({ inspection: { mcp: { servers: [server] } } });
  assert.match(
    sessionMcpText(true, "ollama-search", inspection({ name: "ollama-search", disabled: true })),
    /op=enable/,
  );
  assert.match(
    sessionMcpText(true, "ollama-search", inspection({ name: "ollama-search", disabled: false })),
    /恢复可见/,
  );
  assert.match(
    sessionMcpText(false, "ollama-search", inspection({ name: "ollama-search", disabled: false })),
    /当前会话已停用/,
  );
  assert.match(sessionMcpText(true, "typo", inspection({ name: "other" })), /没有「typo」/);
  // 那句「做完了，但运行时没说什么」不该再出现在任何分支里。
  assert.doesNotMatch(
    sessionMcpText(true, "ollama-search", inspection({ name: "ollama-search" })),
    /没说什么/,
  );
});
