import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkWorkspaceName,
  memoryBucketName,
  rememberedMemoryNames,
  workspaceNamePrompt,
} from "../src/main/workspace-name-guard.ts";

const open = (name: string, path: string) => ({ name, path });

test("名字没人用过就直接放行", () => {
  assert.deepEqual(
    checkWorkspaceName(open("feedmob", "/a/feedmob"), [open("SuoCode", "/a/SuoCode")], ["SuoCode"]),
    { kind: "ok" },
  );
});

test("同一个文件夹再打开一次不算重名", () => {
  assert.deepEqual(
    checkWorkspaceName(open("project", "/a/project"), [open("project", "/a/project")], []),
    { kind: "already-open" },
  );
});

test("另一个已打开的工作区占了这个名字，就不让导入", () => {
  // 记忆是按名字存的：放行就等于把两个项目的记忆合成一份，事后没法拆。
  const verdict = checkWorkspaceName(
    open("project", "/b/project"),
    [open("project", "/a/project")],
    [],
  );
  assert.deepEqual(verdict, { kind: "name-taken", name: "project", other: "/a/project" });
  const prompt = workspaceNamePrompt(verdict);
  assert.equal(prompt?.proceedId, undefined, "重名是拒绝，不该给「继续」这个选项");
  assert.match(prompt?.detail ?? "", /改个名字/);
  assert.match(prompt?.detail ?? "", /\/a\/project/);
});

test("父文件夹已打开，再导入子文件夹：各是各的项目，名字不同就不拦", () => {
  // /Desktop/feedmob 已经打开（是 git 仓库也无所谓），再导入它下面的 fithub。
  assert.deepEqual(
    checkWorkspaceName(open("fithub", "/d/feedmob/fithub"), [open("feedmob", "/d/feedmob")], ["feedmob"]),
    { kind: "ok" },
  );
});

test("只有记忆里见过这个名字，就提示一下让用户自己判断", () => {
  const verdict = checkWorkspaceName(open("project", "/b/project"), [], ["project", "feedmob"]);
  assert.deepEqual(verdict, { kind: "name-remembered", name: "project" });
  const prompt = workspaceNamePrompt(verdict);
  // 这种多半是同一个项目挪了地方，所以是提示不是拦截。
  assert.equal(prompt?.proceedId, 1);
  assert.deepEqual(prompt?.buttons, ["取消", "继续导入"]);
});

test("大小写不同也算同一个名字", () => {
  // 存记忆的目录在 macOS 和 Windows 上都不区分大小写，放行等于撞车。
  assert.equal(
    checkWorkspaceName(open("Project", "/b/Project"), [open("project", "/a/project")], []).kind,
    "name-taken",
  );
  assert.equal(
    checkWorkspaceName(open("PROJECT", "/b/PROJECT"), [], ["project"]).kind,
    "name-remembered",
  );
});

test("放行的时候没有任何弹窗", () => {
  assert.equal(workspaceNamePrompt({ kind: "ok" }), undefined);
  assert.equal(workspaceNamePrompt({ kind: "already-open" }), undefined);
});

test("记忆跟着工作区文件夹走，和 git 无关：仓库里的子目录用它自己的名字", () => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-guard-"));
  const repo = join(root, "feedmob");
  const inside = join(repo, "fithub");
  mkdirSync(inside, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  assert.equal(memoryBucketName(inside), "fithub");
  assert.equal(memoryBucketName(repo), "feedmob");

  const plain = join(root, "notarepo");
  mkdirSync(plain, { recursive: true });
  assert.equal(memoryBucketName(plain), "notarepo");
});

test("记忆目录里已有哪些项目名，读不到就是空的", () => {
  const store = mkdtempSync(join(tmpdir(), "coilcoil-store-"));
  mkdirSync(join(store, "feedmob"));
  mkdirSync(join(store, "SuoCode"));
  writeFileSync(join(store, "GLOBAL.md"), "全局记忆不是项目", "utf8");
  assert.deepEqual(rememberedMemoryNames(store).sort(), ["SuoCode", "feedmob"]);
  assert.deepEqual(rememberedMemoryNames(join(store, "nope")), []);
});
