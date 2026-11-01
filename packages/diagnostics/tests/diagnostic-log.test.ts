import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DiagnosticLogEntry } from "@coilcoil/runtime-protocol";
import { DiagnosticLog } from "../src/log-file.ts";
import { CONTENT_OMITTED, REDACTED, redact } from "../src/redact.ts";
import { listDiagnosticLogFiles } from "../src/archive.ts";

function temporaryDirectory(context: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-diagnostics-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function readEntries(path: string): DiagnosticLogEntry[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("每条日志都是一行 JSON，带进程、范围和事件名", (context) => {
  const directory = temporaryDirectory(context);
  const log = new DiagnosticLog({ directory, process: "runtime" });
  log.info("run-state", "run_state_published", { running: false, reason: "agent_settled" });
  const entries = readEntries(log.filePath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].process, "runtime");
  assert.equal(entries[0].scope, "run-state");
  assert.equal(entries[0].event, "run_state_published");
  assert.deepEqual(entries[0].data, { running: false, reason: "agent_settled" });
  assert.equal(typeof entries[0].ts, "number");
});

test("低于当前级别的日志在写入前就被丢掉", (context) => {
  const directory = temporaryDirectory(context);
  const log = new DiagnosticLog({ directory, process: "main", level: "warn" });
  log.info("ipc", "ignored");
  log.warn("ipc", "kept");
  assert.deepEqual(readEntries(log.filePath).map((entry) => entry.event), ["kept"]);
});

test("错误带上 message 和 stack", (context) => {
  const directory = temporaryDirectory(context);
  const log = new DiagnosticLog({ directory, process: "main" });
  log.error("process", "uncaught_exception", new Error("炸了"));
  const [entry] = readEntries(log.filePath);
  assert.equal(entry.error?.message, "炸了");
  assert.match(entry.error?.stack ?? "", /Error: 炸了/);
});

test("超过上限时轮转，旧内容压缩归档且tail贯穿归档", async (context) => {
  const directory = temporaryDirectory(context);
  const log = new DiagnosticLog({ directory, process: "runtime", maxBytes: 400 });
  for (let index = 0; index < 20; index += 1) log.info("bulk", `entry_${index}`);
  await log.flush();
  assert.ok(listDiagnosticLogFiles(directory).some((file) => file.compressed), "应该产生gzip轮转文件");
  const live = readEntries(log.filePath);
  assert.ok(live.length > 0 && live.length < 20, "活动文件只保留轮转之后的部分");
  assert.equal(live.at(-1)?.event, "entry_19");
  assert.equal(log.tail(20).length, 20);
  assert.equal(log.tail(1)[0]?.event, "entry_19");
});

test("tail 读回最近的条目，坏掉的半行不会让它整体失败", (context) => {
  const directory = temporaryDirectory(context);
  const log = new DiagnosticLog({ directory, process: "runtime" });
  log.info("abort", "abort_requested");
  log.info("abort", "abort_delivered");
  // 进程在写到一半时死掉，最后一行是残的。
  writeFileSync(log.filePath, `${readFileSync(log.filePath, "utf8")}{"ts":1,"level":"in`);
  const tail = log.tail(10);
  assert.deepEqual(tail.map((entry) => entry.event), ["abort_requested", "abort_delivered"]);
});

test("目录不可写时静默停用，不抛异常", (context) => {
  const root = temporaryDirectory(context);
  // 用一个文件占住本该是目录的位置，让 mkdir 和写入都失败。
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "not a directory");
  const log = new DiagnosticLog({ directory: blocked, process: "main" });
  assert.doesNotThrow(() => log.error("process", "uncaught_exception", new Error("仍然不能抛")));
});

test("凭据类字段一律脱敏", () => {
  const data = redact({
    provider: "pierce",
    apiKey: "sk-live-abcdefg", password: 123456,
    headers: { Authorization: "Bearer xyz", "X-Trace": "keep-me" },
    nested: { refresh_token: "r-1", modelId: "gpt-5.6-sol" },
  });
  assert.equal(data?.apiKey, REDACTED);
  assert.equal(data?.password, REDACTED);
  assert.equal((data?.headers as Record<string, unknown>).Authorization, REDACTED);
  assert.equal((data?.headers as Record<string, unknown>)["X-Trace"], "keep-me");
  assert.equal((data?.nested as Record<string, unknown>).refresh_token, REDACTED);
  assert.equal((data?.nested as Record<string, unknown>).modelId, "gpt-5.6-sol");
  assert.equal(data?.provider, "pierce");
});

test("超长字符串被截断并标注原长度", () => {
  const data = redact({ detail: "x".repeat(5_000), output: "private tool result" });
  assert.match(String(data?.detail), /^x+…（共 5000 字符）$/);
  assert.ok(String(data?.detail).length < 2_100);
  assert.equal(data?.output, CONTENT_OMITTED);
});

test("循环引用不会让日志卡死", () => {
  const value: Record<string, unknown> = { name: "loop" };
  value.self = value;
  assert.deepEqual(redact(value), { name: "loop", self: "[循环引用]" });
});

test("token 数量不是凭据，别把它也脱敏了", () => {
  // 压缩日志里的 tokensBefore / estimatedTokensAfter 就是因为键名里有 token 被抹
  // 掉的，等到真要查「压缩到底在多大的时候触发的」，日志里只剩「已脱敏」。
  const data = redact({ tokensBefore: 384198, estimatedTokensAfter: 229081, accessToken: "sk-live-123",
    token: 123456, verificationToken: 8675309, inputTokens: 320, contextWindowTokens: 100_000, firstTokenMs: 42 });
  assert.equal(data?.tokensBefore, 384198);
  assert.equal(data?.estimatedTokensAfter, 229081);
  assert.equal(data?.accessToken, REDACTED, "字符串的凭据照旧不能出现");
  assert.equal(data?.token, REDACTED);
  assert.equal(data?.verificationToken, REDACTED);
  assert.equal(data?.inputTokens, 320);
  assert.equal(data?.contextWindowTokens, 100_000);
  assert.equal(data?.firstTokenMs, 42);
});

test("stderr中驼峰和JSON格式的请求体标记也不能留下消息正文", () => {
  const data = redact({ stderrTail: [
    'requestBody={"draft":"PRIVATE_RAW_BODY"}',
    'responsePayload={"text":"PRIVATE_RESPONSE"}',
    'toolArguments={"text":"PRIVATE_ARGUMENT"}',
    '{"responseBody":{"draft":"PRIVATE_JSON_BODY"}}',
  ] });
  const text = JSON.stringify(data);
  for (const marker of ["PRIVATE_RAW_BODY", "PRIVATE_RESPONSE", "PRIVATE_ARGUMENT", "PRIVATE_JSON_BODY"]) assert.ok(!text.includes(marker));
});
