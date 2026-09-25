import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const session = {
    sessionManager,
    navigateTree: async () => ({ cancelled: cancelNavigation }),
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
      writeFileSync(join(cwd, path), content);
    },
    cancelNextNavigation: () => { cancelNavigation = true; },
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
