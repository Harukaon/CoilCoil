import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitBranch, GitDiff, GitStatus } from "@coilcoil/runtime-protocol";
import { runGitAction } from "../src/git-workspace.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function repository(context: test.TestContext): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-git-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  return { root, repo };
}

const status = (cwd: string) => runGitAction(cwd, { op: "status" }) as Promise<GitStatus>;

test("不在仓库里：repository 是 false", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "coilcoil-not-git-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal((await status(dir)).repository, false);
});

test("还没有提交时：能列出未跟踪文件，暂存和取消暂存都能用", async (context) => {
  const { repo } = repository(context);
  writeFileSync(join(repo, "a.txt"), "a\n");
  let current = await status(repo);
  assert.equal(current.unborn, true);
  assert.equal(current.branch, "main");
  assert.deepEqual(current.files, [{ path: "a.txt", unstaged: "untracked" }]);
  current = await runGitAction(repo, { op: "stage", paths: ["a.txt"] }) as GitStatus;
  assert.deepEqual(current.files, [{ path: "a.txt", staged: "added", unstaged: undefined }]);
  current = await runGitAction(repo, { op: "unstage", paths: ["a.txt"] }) as GitStatus;
  assert.deepEqual(current.files, [{ path: "a.txt", unstaged: "untracked" }]);
});

test("暂存区和工作区分开列；改名带原路径；子目录里也按仓库根目录的路径工作", async (context) => {
  const { repo } = repository(context);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "old.txt"), "same\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  writeFileSync(join(repo, "src", "a.txt"), "one\nTWO\n");
  git(repo, "add", "src/a.txt");
  writeFileSync(join(repo, "src", "a.txt"), "one\nTWO\nthree\n");
  renameSync(join(repo, "old.txt"), join(repo, "new.txt"));
  git(repo, "add", "-A", "old.txt", "new.txt");
  writeFileSync(join(repo, "note md.txt"), "x\n");

  const current = await status(join(repo, "src"));
  assert.equal(current.root, repo);
  const byPath = Object.fromEntries(current.files.map((file) => [file.path, file]));
  assert.deepEqual(byPath["src/a.txt"], { path: "src/a.txt", staged: "modified", unstaged: "modified" });
  assert.deepEqual(byPath["new.txt"], { path: "new.txt", staged: "renamed", unstaged: undefined, originalPath: "old.txt" });
  assert.deepEqual(byPath["note md.txt"], { path: "note md.txt", unstaged: "untracked" }, "带空格的路径");

  const staged = await runGitAction(repo, { op: "diff", path: "src/a.txt", staged: true }) as GitDiff;
  assert.match(staged.patch, /-two\n\+TWO/);
  assert.doesNotMatch(staged.patch, /\+three/, "已暂存的 diff 不含工作区里后来的改动");
  const unstaged = await runGitAction(repo, { op: "diff", path: "src/a.txt", staged: false }) as GitDiff;
  assert.match(unstaged.patch, /\+three/);
  const untracked = await runGitAction(repo, { op: "diff", path: "note md.txt", staged: false }) as GitDiff;
  assert.match(untracked.patch, /\+x/, "未跟踪文件的 diff 是整份新增");
});

test("丢弃：已跟踪的改回去，未跟踪的删掉，暂存区不动", async (context) => {
  const { repo } = repository(context);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(repo, "a.txt"), "changed\n");
  writeFileSync(join(repo, "b.txt"), "staged\n");
  git(repo, "add", "b.txt");
  writeFileSync(join(repo, "c.txt"), "junk\n");
  const current = await runGitAction(repo, { op: "discard", paths: ["a.txt", "c.txt", "b.txt"] }) as GitStatus;
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "a\n");
  assert.equal(existsSync(join(repo, "c.txt")), false);
  assert.deepEqual(current.files, [{ path: "b.txt", staged: "added", unstaged: undefined }]);
});

test("提交：没写说明、没东西可提交都拦下；暂存区为空时可以先全部暂存", async (context) => {
  const { repo } = repository(context);
  writeFileSync(join(repo, "a.txt"), "a\n");
  await assert.rejects(runGitAction(repo, { op: "commit", message: "  " }), /提交说明/);
  await assert.rejects(runGitAction(repo, { op: "commit", message: "x" }), /没有可以提交的改动/);
  const current = await runGitAction(repo, { op: "commit", message: "第一个提交\n\n正文", stageAll: true }) as GitStatus;
  assert.equal(current.unborn, false);
  assert.deepEqual(current.files, []);
  assert.equal(git(repo, "log", "-1", "--format=%B").trim(), "第一个提交\n\n正文");
});

test("分支：列出、新建并切过去、切回来；非法分支名拦下", async (context) => {
  const { repo } = repository(context);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  let current = await runGitAction(repo, { op: "create_branch", name: "feature/x" }) as GitStatus;
  assert.equal(current.branch, "feature/x");
  const list = await runGitAction(repo, { op: "branches" }) as GitBranch[];
  assert.deepEqual(list.map((branch) => [branch.name, branch.current]).sort(), [["feature/x", true], ["main", false]]);
  current = await runGitAction(repo, { op: "checkout", branch: "main" }) as GitStatus;
  assert.equal(current.branch, "main");
  await assert.rejects(runGitAction(repo, { op: "create_branch", name: "bad name" }), /不是合法的分支名/);
  await assert.rejects(runGitAction(repo, { op: "checkout", branch: "--orphan" }), /不是合法的分支名/);
});

test("推送：第一次推送顺手设好上游；拉取只快进", async (context) => {
  const { root, repo } = repository(context);
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  let current = await runGitAction(repo, { op: "push" }) as GitStatus;
  assert.equal(current.upstream, "origin/main");
  assert.equal(current.ahead, 0);

  writeFileSync(join(repo, "a.txt"), "b\n");
  git(repo, "commit", "-q", "-am", "second");
  assert.equal((await status(repo)).ahead, 1);
  current = await runGitAction(repo, { op: "push" }) as GitStatus;
  assert.equal(current.ahead, 0);

  // 另一个克隆推了新提交，这边拉取后快进过去。
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.com");
  writeFileSync(join(other, "a.txt"), "c\n");
  git(other, "commit", "-q", "-am", "third");
  git(other, "push", "-q");
  git(repo, "fetch", "-q");
  assert.equal((await status(repo)).behind, 1);
  current = await runGitAction(repo, { op: "pull" }) as GitStatus;
  assert.equal(current.behind, 0);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "c\n");
});

test("没有远程仓库时推送给出明白的报错", async (context) => {
  const { repo } = repository(context);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  await assert.rejects(runGitAction(repo, { op: "push" }), /还没有配置远程仓库/);
});
