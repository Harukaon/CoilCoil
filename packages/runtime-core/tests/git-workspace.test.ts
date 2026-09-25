import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitBranch, GitDiff, GitLog, GitRepository, GitStatus } from "@coilcoil/runtime-protocol";
import { limitStatus, runGitAction } from "../src/git-workspace.js";
import { readGitChanges } from "../src/project-helpers.js";

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

test("历史：拓扑顺序、父提交、引用标签；合并提交有两个父提交", async (context) => {
  const { repo } = repository(context);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init", "-m", "正文第一段");
  git(repo, "tag", "v1");
  git(repo, "switch", "-q", "-c", "feature");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "feature work");
  git(repo, "switch", "-q", "main");
  writeFileSync(join(repo, "a.txt"), "a2\n");
  git(repo, "commit", "-q", "-am", "main work");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");

  const history = await runGitAction(repo, { op: "log" }) as GitLog;
  assert.deepEqual(history.commits.map((commit) => commit.subject).slice(0, 1), ["merge feature"]);
  assert.equal(history.commits.length, 4);
  assert.equal(history.hasMore, false);
  assert.equal(history.currentRef, "refs/heads/main");
  const [merge] = history.commits;
  assert.equal(merge!.parents.length, 2);
  assert.equal(history.head, merge!.hash);
  assert.deepEqual(merge!.refs, [{ name: "main", fullName: "refs/heads/main", kind: "branch" }]);
  const initial = history.commits.at(-1)!;
  assert.equal(initial.subject, "init");
  assert.equal(initial.body, "正文第一段");
  assert.deepEqual(initial.parents, []);
  assert.deepEqual(initial.refs, [{ name: "v1", fullName: "refs/tags/v1", kind: "tag" }]);
  // 子提交一定排在父提交前面。
  const position = new Map(history.commits.map((commit, index) => [commit.hash, index]));
  for (const commit of history.commits) for (const parent of commit.parents) assert.ok(position.get(parent)! > position.get(commit.hash)!);

  const limited = await runGitAction(repo, { op: "log", limit: 2 }) as GitLog;
  assert.equal(limited.commits.length, 2);
  assert.equal(limited.hasMore, true);
});

test("历史：默认带上游分支，本地和远程分叉时两边的提交都在；all 时包含别的分支", async (context) => {
  const { root, repo } = repository(context);
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.com");
  writeFileSync(join(other, "a.txt"), "remote\n");
  git(other, "commit", "-q", "-am", "remote work");
  git(other, "push", "-q");
  git(repo, "fetch", "-q");
  writeFileSync(join(repo, "a.txt"), "local\n");
  git(repo, "commit", "-q", "-am", "local work");
  git(repo, "branch", "side", "HEAD~1");
  git(repo, "switch", "-q", "side");
  writeFileSync(join(repo, "c.txt"), "c\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "side work");
  git(repo, "switch", "-q", "main");

  const history = await runGitAction(repo, { op: "log" }) as GitLog;
  assert.deepEqual(history.commits.map((commit) => commit.subject).sort(), ["init", "local work", "remote work"]);
  assert.equal(history.upstreamRef, "refs/remotes/origin/main");
  const remoteCommit = history.commits.find((commit) => commit.subject === "remote work")!;
  assert.deepEqual(remoteCommit.refs.map((ref) => ref.name), ["origin/main"], "origin/HEAD 不重复列出");
  const all = await runGitAction(repo, { op: "log", all: true }) as GitLog;
  assert.ok(all.commits.some((commit) => commit.subject === "side work"));
});

test("历史提交的文件列表和 diff：改名带原路径，根提交是整份新增，合并提交和第一个父提交比", async (context) => {
  const { repo } = repository(context);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nfour\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const rootHash = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "mv", "a.txt", "renamed.txt");
  writeFileSync(join(repo, "new.txt"), "new\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "rename");
  const renameHash = git(repo, "rev-parse", "HEAD").trim();

  assert.deepEqual(await runGitAction(repo, { op: "commit_files", hash: rootHash }), [{ path: "a.txt", state: "added" }]);
  assert.deepEqual(await runGitAction(repo, { op: "commit_files", hash: renameHash }), [
    { path: "new.txt", state: "added" },
    { path: "renamed.txt", originalPath: "a.txt", state: "renamed" },
  ]);
  const rootDiff = await runGitAction(repo, { op: "commit_diff", hash: rootHash, path: "a.txt" }) as GitDiff;
  assert.equal(rootDiff.commit, rootHash);
  assert.match(rootDiff.patch, /\+one\n\+two/);
  const newDiff = await runGitAction(repo, { op: "commit_diff", hash: renameHash, path: "new.txt" }) as GitDiff;
  assert.match(newDiff.patch, /\+new/);

  git(repo, "switch", "-q", "-c", "feature");
  writeFileSync(join(repo, "feature.txt"), "f\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "feature");
  git(repo, "switch", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feature");
  const mergeHash = git(repo, "rev-parse", "HEAD").trim();
  assert.deepEqual(await runGitAction(repo, { op: "commit_files", hash: mergeHash }), [{ path: "feature.txt", state: "added" }]);
  await assert.rejects(runGitAction(repo, { op: "commit_files", hash: "--all" }), /不是提交哈希/);
});

test("上层文件夹里有大量未跟踪文件：按文件夹聚合成一条，不逐个列出", async (context) => {
  const { repo } = repository(context);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  for (const project of ["proj1", "proj2"]) {
    mkdirSync(join(repo, project, "src"), { recursive: true });
    for (let index = 0; index < 300; index += 1) writeFileSync(join(repo, project, "src", `f${index}.ts`), `${index}\n`);
  }
  const current = await status(repo);
  assert.deepEqual(current.files, [{ path: "proj1/", unstaged: "untracked" }, { path: "proj2/", unstaged: "untracked" }]);
  assert.equal(current.total, 2);
  assert.equal(current.truncated, false);
  await assert.rejects(runGitAction(repo, { op: "diff", path: "proj1/", staged: false }), /暂存之后才能看到/);
  const discarded = await runGitAction(repo, { op: "discard", paths: ["proj2/"] }) as GitStatus;
  assert.equal(existsSync(join(repo, "proj2")), false, "未跟踪的文件夹整个删掉");
  assert.deepEqual(discarded.files, [{ path: "proj1/", unstaged: "untracked" }]);
});

test("改动超过上限：只交出上限条数，同时报总数", () => {
  const files = Array.from({ length: 12 }, (_, index) => ({ path: `f${index}`, unstaged: "modified" as const }));
  const limited = limitStatus({ repository: true, detached: false, ahead: 0, behind: 0, unborn: false, files, total: 12, truncated: false }, 5);
  assert.equal(limited.files.length, 5);
  assert.equal(limited.total, 12);
  assert.equal(limited.truncated, true);
  const mixed = limitStatus({
    repository: true, detached: false, ahead: 0, behind: 0, unborn: false, total: 8, truncated: false,
    files: [...files.slice(0, 6), { path: "new-project/", unstaged: "untracked" }, { path: "c.txt", unstaged: "conflicted" }],
  }, 4);
  assert.deepEqual(mixed.files.map((file) => file.path), ["c.txt", "new-project/", "f0", "f1"], "截断时冲突和未跟踪的先留下");
});

test("整个仓库一起暂存、取消暂存、丢弃；.gitignore 管的文件不动", async (context) => {
  const { repo } = repository(context);
  writeFileSync(join(repo, ".gitignore"), "local.env\n");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(repo, "a.txt"), "changed\n");
  mkdirSync(join(repo, "new"));
  writeFileSync(join(repo, "new", "b.txt"), "b\n");
  writeFileSync(join(repo, "local.env"), "SECRET=1\n");
  let current = await runGitAction(repo, { op: "stage_all" }) as GitStatus;
  assert.deepEqual(current.files.map((file) => [file.path, file.staged]), [["a.txt", "modified"], ["new/b.txt", "added"]]);
  current = await runGitAction(repo, { op: "unstage_all" }) as GitStatus;
  assert.ok(current.files.every((file) => !file.staged));
  current = await runGitAction(repo, { op: "discard_all" }) as GitStatus;
  assert.deepEqual(current.files, []);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "a\n");
  assert.equal(existsSync(join(repo, "new")), false);
  assert.equal(readFileSync(join(repo, "local.env"), "utf8"), "SECRET=1\n", "被忽略的文件不删");
});

test("找仓库：工作区本身所在的，加上子文件夹里的；依赖目录不去翻", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-repos-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  for (const path of ["app", "libs/core", "node_modules/pkg"]) {
    mkdirSync(join(root, path), { recursive: true });
    git(join(root, path), "init", "-q", "-b", "main");
  }
  mkdirSync(join(root, "plain"));
  const found = await runGitAction(root, { op: "repositories" }) as GitRepository[];
  assert.deepEqual(found.map((repository) => repository.name), [".", "app", join("libs", "core")]);
  const plain = await runGitAction(join(root, "plain"), { op: "repositories" }) as GitRepository[];
  assert.deepEqual(plain.map((repository) => repository.name), ["."], "在子文件夹里打开时，上层仓库仍然算");
});

test("项目摘要：读 git 失败时带上原因，不是 git 仓库才算没有改动", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "coilcoil-changes-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await readGitChanges(dir), { changes: [] });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".git", "index"), "garbage");
  const broken = await readGitChanges(dir);
  assert.deepEqual(broken.changes, []);
  assert.match(broken.changesError ?? "", /读取 git 改动失败/);
});
