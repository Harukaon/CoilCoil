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
  setupGuide,
  SETUP_MASKED_VALUE,
  summarizeBundledDoc,
} from "../extensions/setup-guide.ts";
import {
  COILCOIL_TOOL_NAME,
  SETUP_RPC_REPLY_PREFIX,
  SETUP_RPC_REQUEST_CHANNEL,
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

test("guide 三个 topic 都有教程，且点了名目录", () => {
  const agentDir = join(tmpdir(), "agent");
  for (const topic of ["skill", "mcp", "auth"] as const) {
    const text = setupGuide(topic, agentDir);
    assert.ok(text.length > 100, topic);
  }
  assert.match(setupGuide("skill", agentDir), /SKILL\.md/);
  assert.match(setupGuide("skill", agentDir), /bash\/cp 自己拷/);
  assert.match(setupGuide("mcp", agentDir), /mcp\.json/);
  assert.match(setupGuide("mcp", agentDir), /parse_snippet/);
  assert.match(setupGuide("auth", agentDir), /auth_start/);
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

