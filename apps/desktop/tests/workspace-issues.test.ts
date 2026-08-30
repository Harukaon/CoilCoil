import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { issuesFileFor, normalizeIssues, readIssues, writeIssues } from "../src/main/workspace-issues";
import {
  ISSUE_COLUMNS,
  issuePrompt,
  issuesInColumn,
  newIssue,
  nextRunnableIssue,
  removeIssue,
  sortIssues,
  upsertIssue,
  withNote,
  withStatus,
  userNote,
} from "../src/renderer/src/features/issues/issueModel";

/**
 * 工作区看板。盯的是三件事：坏文件不能把一块看板清空，「挨个做」的顺序确实按
 * 优先级走，以及「完成」不会被 agent 自己推上去——那一步只有用户能点。
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), "coilcoil-issues-"));
const make = (title: string, priority: "high" | "medium" | "low", at: string) =>
  ({ ...newIssue(title, "", priority), id: title, createdAt: at });

test("两个工作区落在两个文件里，同一个工作区每次都落在同一个", () => {
  const dir = scratch();
  const a = issuesFileFor(dir, "/Users/hao/Desktop/project/SuoCode");
  const b = issuesFileFor(dir, "/Users/hao/Desktop/project/vela");
  assert.notEqual(a, b);
  assert.equal(a, issuesFileFor(dir, "/Users/hao/Desktop/project/SuoCode"));
  // 文件名里带得上项目名，翻到这个目录时还认得出哪份是哪个。
  assert.match(a, /SuoCode-[0-9a-f]{12}\.json$/);
});

test("文件不存在或者读坏了，都当作空看板而不是让面板打不开", () => {
  const dir = scratch();
  assert.deepEqual(readIssues(join(dir, "没有这个文件.json")), []);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ 这不是 JSON", "utf8");
  assert.deepEqual(readIssues(broken), []);
});

test("写进去的下次读得回来，认不出来的条目丢掉", () => {
  const file = issuesFileFor(scratch(), "/tmp/demo");
  const issue = newIssue("终端会滚回顶部", "复现步骤……", "high");
  const written = writeIssues(file, [issue, { title: "没有 id" }, null, 7]);
  assert.deepEqual(written, [issue]);
  assert.deepEqual(readIssues(file), [issue]);
  assert.match(readFileSync(file, "utf8"), /终端会滚回顶部/);
});

test("状态和优先级认不出来时退回默认，而不是让整条消失", () => {
  const [issue] = normalizeIssues([{ id: "x", title: "标题", status: "飞了", priority: "紧急" }]);
  assert.equal(issue.status, "todo");
  assert.equal(issue.priority, "medium");
});

test("磁盘写不进去也不抛，调用方仍然拿到收敛后的清单", () => {
  const issue = newIssue("标题", "", "low");
  assert.deepEqual(writeIssues(join(tmpdir(), "coilcoil-no-such-dir/x/y/z.json"), [issue]).length, 1);
});

test("挨个做的顺序：先看优先级，同级先提的先做", () => {
  const issues = [
    make("低-早", "low", "2026-01-01"),
    make("高-晚", "high", "2026-03-01"),
    make("中-早", "medium", "2026-01-02"),
    make("高-早", "high", "2026-02-01"),
  ];
  assert.deepEqual(sortIssues(issues).map((issue) => issue.title), ["高-早", "高-晚", "中-早", "低-早"]);
  assert.equal(nextRunnableIssue(issues)?.title, "高-早");
});

test("已经有一条在跑的时候一条都不挑——第一版是串行的", () => {
  const issues = [make("在跑", "high", "2026-01-01"), make("排着", "high", "2026-01-02")];
  assert.equal(nextRunnableIssue(withStatus(issues, "在跑", "doing")), undefined);
  // 跑完移到待验收之后，下一条才轮得到。
  assert.equal(nextRunnableIssue(withStatus(issues, "在跑", "review"))?.title, "排着");
});

test("待验收、待回复、完成都不会被当成待办重新跑一遍", () => {
  for (const status of ["review", "reply", "done"] as const) {
    assert.equal(nextRunnableIssue([{ ...make("一条", "high", "2026-01-01"), status }]), undefined);
  }
});

test("发给 agent 的那段话里带着标题和正文，并且要它自己说清楚做了什么", () => {
  const prompt = issuePrompt(newIssue("标题", "正文", "high"));
  assert.match(prompt, /标题/);
  assert.match(prompt, /正文/);
  assert.match(prompt, /说明你改了什么/);
});

test("五列就是用户在浏览器里用的那五列，完成排在最后", () => {
  assert.deepEqual(ISSUE_COLUMNS.map((column) => column.status), ["todo", "doing", "review", "reply", "done"]);
});

test("改状态、留言、删除都不动别的条目", () => {
  const a = make("a", "high", "2026-01-01");
  const b = make("b", "low", "2026-01-02");
  const moved = withStatus([a, b], "a", "done");
  assert.equal(moved[0].status, "done");
  assert.deepEqual(moved[1], b);
  const noted = withNote(moved, "b", userNote("打回重做"));
  assert.equal(noted[1].notes[0].text, "打回重做");
  assert.equal(noted[0].notes.length, 0);
  assert.deepEqual(removeIssue(noted, "a").map((issue) => issue.id), ["b"]);
});

test("同一条 Issue 提交两次是覆盖不是加一条", () => {
  const issue = newIssue("标题", "", "medium");
  const once = upsertIssue([], issue);
  const twice = upsertIssue(once, { ...issue, title: "改过的标题" });
  assert.equal(twice.length, 1);
  assert.equal(twice[0].title, "改过的标题");
  assert.equal(issuesInColumn(twice, "todo").length, 1);
});
