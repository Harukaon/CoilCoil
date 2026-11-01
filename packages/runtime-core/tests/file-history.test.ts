import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DiagnosticLog } from "@coilcoil/diagnostics";
import {
  FILE_BACKUP_ENTRY_TYPE,
  FILE_RESTORE_ENTRY_TYPE,
  fileHistoryExtension,
  messagesWithFileChanges,
  navigateWithCheckpoint,
  previewRewind,
} from "../src/runtime-checkpoints.js";

/**
 * 一个只有分支的假会话：用户消息、Agent 的 edit / write（走真的扩展处理函数）都按顺序
 * 追加成条目，和 Pi 写会话文件的顺序一样。
 */
function harness(context: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-file-history-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(join(cwd, "projA"), { recursive: true });
  mkdirSync(join(cwd, "projB"), { recursive: true });
  const log = new DiagnosticLog({ directory: join(agentDir, "logs"), process: "runtime" });
  const branch: SessionEntry[] = [];
  let next = 0;
  const append = (entry: Record<string, unknown>): string => {
    const id = `e${next += 1}`;
    branch.push({ id, parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...entry } as SessionEntry);
    return id;
  };
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const extension = fileHistoryExtension(agentDir, log);
  const factory = typeof extension === "function" ? extension : extension.factory;
  void factory({
    on: (name: string, fn: typeof handler) => { if (name === "tool_call") handler = fn; },
    appendEntry: (customType: string, data: unknown) => append({ type: "custom", customType, data }),
  } as never);
  const sessionManager = {
    getBranch: () => [...branch],
    appendCustomEntry: (customType: string, data: unknown) => append({ type: "custom", customType, data }),
  };
  let cancelNavigation = false;
  let onNavigate: (() => void) | undefined;
  const session = {
    sessionManager,
    navigateTree: async () => { onNavigate?.(); return { cancelled: cancelNavigation }; },
  } as unknown as AgentSession;
  return {
    agentDir,
    cwd,
    branch,
    file: (path: string) => join(cwd, path),
    user: () => append({ type: "message", message: { role: "user", content: "hi" } }),
    /** Agent 改一个文件：先过扩展（备份），再真的写。 */
    async edit(path: string, content: string, toolName = "edit") {
      await handler!({ type: "tool_call", toolCallId: `t${next}`, toolName, input: { path } }, { cwd, sessionManager });
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    },
    cancelNextNavigation: () => { cancelNavigation = true; },
    onNavigate: (callback: () => void) => { onNavigate = callback; },
    rewind: (entryId: string) => navigateWithCheckpoint({ agentDir, session, entryId, restoreCode: true, log }),
  };
}

const backups = (branch: SessionEntry[]) => branch.filter((entry) => entry.type === "custom" && entry.customType === FILE_BACKUP_ENTRY_TYPE);

test("同一条消息里同一个文件只备份第一次，下一条消息再备份", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "v0");
  h.user();
  await h.edit("projA/a.txt", "v1");
  await h.edit("projA/a.txt", "v2");
  assert.equal(backups(h.branch).length, 1);
  h.user();
  await h.edit("projA/a.txt", "v3");
  assert.equal(backups(h.branch).length, 2);
});

test("只回退 Agent 改过的文件：同一个文件夹下别的项目原样不动", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "original");
  writeFileSync(h.file("projB/b.txt"), "b-original");
  const first = h.user();
  await h.edit("projA/a.txt", "agent-1");
  await h.edit("projA/new.txt", "created", "write");
  const second = h.user();
  await h.edit("projA/a.txt", "agent-2");
  // 用户自己（或另一个项目）在这期间改的文件，Agent 没碰过。
  writeFileSync(h.file("projB/b.txt"), "b-user-edit");

  assert.deepEqual([...messagesWithFileChanges(h.branch)].sort(), [first, second].sort());
  const preview = previewRewind(h.agentDir, h.cwd, h.branch, first);
  assert.deepEqual(preview.files.map((file) => `${file.state}:${file.path}`).sort(), ["added:projA/new.txt", "modified:projA/a.txt"]);

  await h.rewind(first);
  assert.equal(readFileSync(h.file("projA/a.txt"), "utf8"), "original");
  assert.equal(existsSync(h.file("projA/new.txt")), false);
  assert.equal(readFileSync(h.file("projB/b.txt"), "utf8"), "b-user-edit");
  assert.ok(h.branch.some((entry) => entry.type === "custom" && entry.customType === FILE_RESTORE_ENTRY_TYPE));
});

test("回到后面那条消息：恢复成那条消息发出时的样子", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "original");
  h.user();
  await h.edit("projA/a.txt", "after-first");
  const second = h.user();
  await h.edit("projA/a.txt", "after-second");
  await h.rewind(second);
  assert.equal(readFileSync(h.file("projA/a.txt"), "utf8"), "after-first");
});

test("和当时一样的文件不算改动；Agent 删掉的文件回退时重建", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "same");
  writeFileSync(h.file("projA/gone.txt"), "keep me");
  const first = h.user();
  await h.edit("projA/a.txt", "same");
  await h.edit("projA/gone.txt", "x");
  rmSync(h.file("projA/gone.txt"));
  const preview = previewRewind(h.agentDir, h.cwd, h.branch, first);
  assert.deepEqual(preview.files.map((file) => `${file.state}:${file.path}`), ["deleted:projA/gone.txt"]);
  await h.rewind(first);
  assert.equal(readFileSync(h.file("projA/gone.txt"), "utf8"), "keep me");
});

test("会话没切过去就把文件换回来", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "original");
  const first = h.user();
  await h.edit("projA/a.txt", "agent");
  await h.edit("projA/new.txt", "created", "write");
  h.cancelNextNavigation();
  const result = await h.rewind(first);
  assert.equal(result.cancelled, true);
  assert.equal(readFileSync(h.file("projA/a.txt"), "utf8"), "agent");
  assert.equal(readFileSync(h.file("projA/new.txt"), "utf8"), "created");
});

test("太大的文件不备份，预览里单独列出来", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
  const first = h.user();
  await h.edit("projA/big.bin", "small");
  const preview = previewRewind(h.agentDir, h.cwd, h.branch, first);
  assert.deepEqual(preview.files, []);
  assert.deepEqual(preview.skipped, ["projA/big.bin"]);
});

test("回溯时当前文件已超过备份上限：跳过它，取消导航不丢失大文件", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.bin"), "original");
  const first = h.user();
  await h.edit("projA/a.bin", "agent");
  const large = Buffer.alloc(5 * 1024 * 1024 + 1, 7);
  writeFileSync(h.file("projA/a.bin"), large);
  h.cancelNextNavigation();
  await h.rewind(first);
  assert.ok(readFileSync(h.file("projA/a.bin")).equals(large), "取消导航后必须保留当前完整大文件");
  const preview = previewRewind(h.agentDir, h.cwd, h.branch, first);
  assert.deepEqual(preview.files, []);
  assert.deepEqual(preview.skipped, ["projA/a.bin"]);
});

test("回溯时文件已换成符号链接：保留链接和其他项目的目标文件", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "original");
  writeFileSync(h.file("projB/b.txt"), "user data");
  const first = h.user();
  await h.edit("projA/a.txt", "agent");
  rmSync(h.file("projA/a.txt"));
  symlinkSync(h.file("projB/b.txt"), h.file("projA/a.txt"));
  await h.rewind(first);
  assert.equal(readFileSync(h.file("projB/b.txt"), "utf8"), "user data");
  assert.ok(lstatSync(h.file("projA/a.txt")).isSymbolicLink());
  assert.deepEqual(previewRewind(h.agentDir, h.cwd, h.branch, first).skipped, ["projA/a.txt"]);
});

test("多文件回溯中第二个写入失败：第一个文件自动撤销，会话不切换", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "a-original");
  writeFileSync(h.file("projA/b.txt"), "b-original");
  const first = h.user();
  await h.edit("projA/a.txt", "a-agent");
  await h.edit("projA/b.txt", "b-agent");
  chmodSync(h.file("projA/b.txt"), 0o444);
  try {
    await assert.rejects(h.rewind(first), /EACCES|EPERM/);
    assert.equal(readFileSync(h.file("projA/a.txt"), "utf8"), "a-agent");
    assert.equal(readFileSync(h.file("projA/b.txt"), "utf8"), "b-agent");
    assert.equal(h.branch.some((entry) => entry.type === "custom" && entry.customType === FILE_RESTORE_ENTRY_TYPE), false);
  } finally {
    chmodSync(h.file("projA/b.txt"), 0o644);
  }
});

test("空文件与不存在分开恢复，重复回溯不改变结果", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/empty.txt"), "");
  const first = h.user();
  await h.edit("projA/empty.txt", "nonempty");
  await h.edit("projA/created.txt", "", "write");
  for (let index = 0; index < 2; index += 1) {
    await h.rewind(first);
    assert.equal(existsSync(h.file("projA/empty.txt")), true);
    assert.equal(readFileSync(h.file("projA/empty.txt")).length, 0);
    assert.equal(existsSync(h.file("projA/created.txt")), false);
  }
});

test("导航抛错时撤销全部文件，回溯记录不写入", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "original");
  const first = h.user();
  await h.edit("projA/a.txt", "agent");
  await h.edit("projA/new.txt", "created", "write");
  h.onNavigate(() => { throw new Error("navigation failed"); });
  await assert.rejects(h.rewind(first), /navigation failed/);
  assert.equal(readFileSync(h.file("projA/a.txt"), "utf8"), "agent");
  assert.equal(readFileSync(h.file("projA/new.txt"), "utf8"), "created");
  assert.equal(h.branch.some((entry) => entry.type === "custom" && entry.customType === FILE_RESTORE_ENTRY_TYPE), false);
});

test("撤销回溯失败会报告错误，并继续恢复其余文件", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "a-original");
  writeFileSync(h.file("projA/b.txt"), "b-original");
  const first = h.user();
  await h.edit("projA/a.txt", "a-agent");
  await h.edit("projA/b.txt", "b-agent");
  h.cancelNextNavigation();
  h.onNavigate(() => { chmodSync(h.file("projA/b.txt"), 0o444); });
  try {
    await assert.rejects(h.rewind(first), /撤销回退失败/);
    assert.equal(readFileSync(h.file("projA/a.txt"), "utf8"), "a-agent");
  } finally {
    chmodSync(h.file("projA/b.txt"), 0o644);
  }
});

test("回溯时新增文件已被替换成目录或悬空链接：保留当前数据并跳过", async (context) => {
  const h = harness(context);
  const first = h.user();
  await h.edit("projA/new.txt", "created", "write");
  await h.edit("projA/link.txt", "created", "write");
  rmSync(h.file("projA/new.txt"));
  mkdirSync(h.file("projA/new.txt"));
  writeFileSync(h.file("projA/new.txt/keep"), "user data");
  rmSync(h.file("projA/link.txt"));
  symlinkSync(h.file("projA/missing.txt"), h.file("projA/link.txt"));
  await h.rewind(first);
  assert.equal(readFileSync(h.file("projA/new.txt/keep"), "utf8"), "user data");
  assert.ok(lstatSync(h.file("projA/link.txt")).isSymbolicLink());
  assert.deepEqual(previewRewind(h.agentDir, h.cwd, h.branch, first).skipped, ["projA/new.txt", "projA/link.txt"]);
});

test("回溯时父目录被换成符号链接：不写入另一个项目", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "original");
  writeFileSync(h.file("projB/a.txt"), "other project");
  const first = h.user();
  await h.edit("projA/a.txt", "agent");
  renameSync(h.file("projA"), h.file("original-project"));
  symlinkSync(h.file("projB"), h.file("projA"), "dir");
  await h.rewind(first);
  assert.equal(readFileSync(h.file("projB/a.txt"), "utf8"), "other project");
  assert.equal(readFileSync(h.file("original-project/a.txt"), "utf8"), "agent");
  assert.deepEqual(previewRewind(h.agentDir, h.cwd, h.branch, first).skipped, ["projA/a.txt"]);
});

test("备份时已经存在的目录链接可以正常回溯，尚不存在的多层目录也可恢复", async (context) => {
  const h = harness(context);
  writeFileSync(h.file("projA/a.txt"), "original");
  symlinkSync(h.file("projA"), h.file("alias"), "dir");
  const first = h.user();
  await h.edit("alias/a.txt", "agent");
  await h.edit("new/nested/empty.txt", "", "write");
  await h.rewind(first);
  assert.equal(readFileSync(h.file("projA/a.txt"), "utf8"), "original");
  assert.ok(lstatSync(h.file("alias")).isSymbolicLink());
  assert.equal(existsSync(h.file("new/nested/empty.txt")), false);
});
