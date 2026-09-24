import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CheckpointStore, checkpointsSupported } from "../src/checkpoint-store.js";

function setup(context: test.TestContext): { workspace: string; data: string } {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-checkpoint-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const data = join(root, "data");
  mkdirSync(workspace);
  return { workspace, data };
}

test("快照再回退：改过的恢复、删掉的回来、之后新建的删掉，被忽略的不动", async (context) => {
  const { workspace, data } = setup(context);
  writeFileSync(join(workspace, "a.txt"), "original\n");
  writeFileSync(join(workspace, "gone.txt"), "will be deleted\n");
  writeFileSync(join(workspace, ".gitignore"), "build/\n");
  mkdirSync(join(workspace, "node_modules"));
  writeFileSync(join(workspace, "node_modules", "dep.js"), "dep\n");
  const store = new CheckpointStore(workspace, data);
  const checkpoint = await store.snapshot();
  assert.match(checkpoint, /^[0-9a-f]{40,64}$/);
  assert.equal(await store.snapshot(), checkpoint, "没改文件就复用同一个快照");

  writeFileSync(join(workspace, "a.txt"), "changed by agent\n");
  unlinkSync(join(workspace, "gone.txt"));
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "new.ts"), "new\n");
  mkdirSync(join(workspace, "build"));
  writeFileSync(join(workspace, "build", "out.js"), "built\n");
  writeFileSync(join(workspace, "node_modules", "dep.js"), "upgraded\n");

  const changes = await store.changesSince(checkpoint);
  assert.deepEqual(changes, [
    { path: "a.txt", state: "modified" },
    { path: "gone.txt", state: "deleted" },
    { path: "src/new.ts", state: "added" },
  ]);

  const { backup, files } = await store.restore(checkpoint);
  assert.deepEqual(files, changes);
  assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "original\n");
  assert.equal(readFileSync(join(workspace, "gone.txt"), "utf8"), "will be deleted\n");
  assert.equal(existsSync(join(workspace, "src", "new.ts")), false);
  assert.equal(readFileSync(join(workspace, "build", "out.js"), "utf8"), "built\n", ".gitignore 里的不动");
  assert.equal(readFileSync(join(workspace, "node_modules", "dep.js"), "utf8"), "upgraded\n", "默认排除的依赖目录不动");
  assert.deepEqual(await store.changesSince(checkpoint), []);

  // 回退前的样子存成了 backup，退错了还能退回去。
  await store.restore(backup);
  assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "changed by agent\n");
  assert.equal(readFileSync(join(workspace, "src", "new.ts"), "utf8"), "new\n");
});

test("用户自己的 git 仓库完全不受影响：HEAD、暂存区、未跟踪状态都不变", async (context) => {
  const { workspace, data } = setup(context);
  const git = (...args: string[]): string => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(workspace, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(workspace, "a.txt"), "two\n");
  git("add", "a.txt");
  writeFileSync(join(workspace, "untracked.txt"), "u\n");
  const before = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), branches: git("branch", "-a") };

  const store = new CheckpointStore(workspace, data);
  const checkpoint = await store.snapshot();
  writeFileSync(join(workspace, "a.txt"), "three\n");
  await store.restore(checkpoint);

  assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "two\n");
  assert.deepEqual({ head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), branches: git("branch", "-a") }, before);
  assert.equal(existsSync(join(workspace, ".git", "refs", "heads", "checkpoints")), false);
});

test("不对家目录和磁盘根目录做快照", () => {
  assert.equal(checkpointsSupported(homedir()), false);
  assert.equal(checkpointsSupported("/"), false);
  assert.equal(checkpointsSupported(join(homedir(), "project")), true);
});
