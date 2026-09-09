/**
 * 任务面板那条后台运行的端到端检查——用真模型跑一次。
 *
 * 单元测试拿假运行时验的是「催几轮、兜底、超时」这些判断；这里验的是接线：扩展有
 * 没有被真的加载、那两个工具模型看不看得见、回复文件有没有真的写出来、以及最要紧
 * 的一条——工作区的会话目录是不是从头到尾一个文件都没多。
 *
 * 用的是你自己的凭据，但复制到一个临时 agent 目录里跑：只读 auth.json 和
 * models.json 两个文件，绝不碰你正在用的那份配置和会话。
 *
 *   npm run smoke:issue
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realAgentDir = process.env.COILCOIL_SMOKE_SOURCE_AGENT_DIR
  ?? join(homedir(), "Library", "Application Support", "@coilcoil", "desktop", "agent");

const temporaryRoot = mkdtempSync(join(tmpdir(), "coilcoil-issue-smoke-"));
const agentDir = join(temporaryRoot, "agent");
const sessionDir = join(temporaryRoot, "sessions");
const projectDir = join(temporaryRoot, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, "README.md"), "# 冒烟用的空项目\n", "utf8");

let copied = 0;
for (const name of ["auth.json", "models.json", "model-runtime-options.json"]) {
  const source = join(realAgentDir, name);
  if (!existsSync(source)) continue;
  copyFileSync(source, join(agentDir, name));
  copied += 1;
}
// 只把「默认用哪个模型」搬过来。整份 settings.json 里还有 MCP、技能这些东西，冒烟
// 不需要它们，带过来反而会去连服务器、弹授权。
const realSettings = join(realAgentDir, "settings.json");
if (existsSync(realSettings)) {
  const { defaultProvider, defaultModel, defaultThinkingLevel } = JSON.parse(readFileSync(realSettings, "utf8"));
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ defaultProvider, defaultModel, defaultThinkingLevel }, null, 2)}\n`,
    "utf8",
  );
}
if (!copied) {
  process.stdout.write(`没有找到可用的凭据（${realAgentDir}），跳过。\n`);
  rmSync(temporaryRoot, { recursive: true, force: true });
  process.exit(0);
}

const child = fork(join(root, "apps/desktop/out/main/runtime.js"), [], {
  env: {
    ...process.env,
    COILCOIL_AGENT_DIR: agentDir,
    COILCOIL_SESSION_DIR: sessionDir,
    COILCOIL_LEGACY_AGENT_DIR: join(temporaryRoot, "no-legacy"),
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let runtimeError = "";
child.stderr.on("data", (chunk) => { runtimeError += chunk; });

const pending = new Map();
/** 任务跑起来之后界面本来就收不到事件，这里只是留着看有没有漏出来。 */
const events = [];
let nextId = 0;
child.on("message", (message) => {
  if (message && typeof message === "object" && "event" in message) { events.push(message.event); return; }
  const entry = pending.get(message?.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error));
});

function request(command, runtimeId) {
  const id = `issue-smoke-${++nextId}`;
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    child.send({ id, runtimeId, command });
  });
}

function fail(message) {
  process.stderr.write(`${message}\n${runtimeError}\n`);
  child.kill("SIGKILL");
  rmSync(temporaryRoot, { recursive: true, force: true });
  process.exit(1);
}

try {
  const bootstrap = await request({ type: "bootstrap" });
  const configuration = bootstrap.configuration;
  if (!configuration.provider || !configuration.modelId || !configuration.configuredProviders.includes(configuration.provider)) {
    process.stdout.write("这台机器上没有配好的默认模型，跳过。\n");
    child.kill("SIGTERM");
    rmSync(temporaryRoot, { recursive: true, force: true });
    process.exit(0);
  }

  const started = Date.now();
  const result = await request({
    type: "run_issue",
    cwd: projectDir,
    issueId: "smoke-issue",
    prompt: "【任务面板】冒烟\n\n什么都不用改。直接调用 issue_reply，summary 写「ok」。",
    maxTurns: 3,
  });

  assert.equal(result.kind, "reply", `它没有交结论：${JSON.stringify(result)}`);
  assert.ok(result.text.trim().length > 0, "结论是空的");
  assert.ok(result.turns >= 1);

  // 最要紧的一条：工作区的会话目录必须一个文件都没多。
  assert.deepEqual(readdirSync(sessionDir), [], "这条运行在工作区的会话目录里留下了东西");
  const runs = readdirSync(join(agentDir, "issues", "runs"));
  assert.equal(runs.length, 1, "运行现场应该留在 agent/issues/runs 下");
  assert.ok(existsSync(join(agentDir, "issues", "runs", runs[0], "reply.json")), "回复文件没写出来");

  process.stdout.write(
    `任务后台运行冒烟通过（${Math.round((Date.now() - started) / 1000)} 秒，${result.turns} 轮）：${result.text.trim().slice(0, 60)}\n`,
  );
  child.kill("SIGTERM");
  rmSync(temporaryRoot, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  fail(`任务后台运行冒烟失败：${error instanceof Error ? error.message : String(error)}`);
}
