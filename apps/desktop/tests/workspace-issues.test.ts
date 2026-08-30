import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { issuesFileFor, normalizeIssues, readIssues, writeIssues } from "../src/main/workspace-issues";
import {
  ISSUE_COLUMNS,
  childrenOf,
  issuePrompt,
  issuesInColumn,
  newIssue,
  nextRunnableIssue,
  rejectIssue,
  removeIssue,
  reviewQueue,
  sortIssues,
  upsertIssue,
  withComment,
  withDeferred,
  withStatus,
} from "../src/renderer/src/features/issues/issueModel";

/**
 * 工作区任务面板。盯住的是这套流转本身：待办池不会被拿去做、批阅队列里排谁、
 * 打回是动作不是一列、回复完自动回队列，以及坏文件不能把一块面板清空。
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), "coilcoil-issues-"));
const make = (title: string, priority: "high" | "medium" | "low", at: string, status: "pool" | "ready" | "doing" | "review" | "reply" | "done" = "ready") =>
  ({ ...newIssue(title, "", priority), id: title, createdAt: at, updatedAt: at, status });

test("两个工作区落在两个文件里，同一个工作区每次都落在同一个", () => {
  const dir = scratch();
  const a = issuesFileFor(dir, "/Users/hao/Desktop/project/SuoCode");
  const b = issuesFileFor(dir, "/Users/hao/Desktop/project/vela");
  assert.notEqual(a, b);
  assert.equal(a, issuesFileFor(dir, "/Users/hao/Desktop/project/SuoCode"));
  // 文件名里带得上项目名，翻到这个目录时还认得出哪份是哪个。
  assert.match(a, /SuoCode-[0-9a-f]{12}\.json$/);
});

test("文件不存在或者读坏了，都当作空面板而不是让面板打不开", () => {
  const dir = scratch();
  assert.deepEqual(readIssues(join(dir, "没有这个文件.json")), []);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ 这不是 JSON", "utf8");
  assert.deepEqual(readIssues(broken), []);
});

test("写进去的下次读得回来，认不出来的条目丢掉", () => {
  const file = issuesFileFor(scratch(), "/tmp/demo");
  const issue = newIssue("终端会滚回顶部", "复现步骤……", "high");
  assert.deepEqual(writeIssues(file, [issue, { title: "没有 id" }, null, 7]), [issue]);
  assert.deepEqual(readIssues(file), [issue]);
  assert.match(readFileSync(file, "utf8"), /终端会滚回顶部/);
});

test("状态和优先级认不出来时退回默认——新提的东西默认落在待办池", () => {
  const [issue] = normalizeIssues([{ id: "x", title: "标题", status: "飞了", priority: "紧急" }]);
  assert.equal(issue.status, "pool");
  assert.equal(issue.priority, "medium");
});

test("时间线存进去就是按时间排好的，不是「AI 一摞、我一摞」", () => {
  const [issue] = normalizeIssues([{
    id: "x",
    title: "标题",
    events: [
      { at: "2026-03-01T00:00:00.000Z", by: "agent", kind: "note", text: "第三" },
      { at: "2026-01-01T00:00:00.000Z", by: "user", kind: "comment", text: "第一" },
      { at: "2026-02-01T00:00:00.000Z", by: "user", kind: "comment", text: "第二" },
    ],
  }]);
  assert.deepEqual(issue.events.map((event) => event.text), ["第一", "第二", "第三"]);
});

test("父没了的子任务收成顶层的一条，不会从面板上消失", () => {
  const [orphan] = normalizeIssues([{ id: "child", title: "子任务", parentId: "已经删掉的父" }]);
  assert.equal(orphan.parentId, undefined);
  const kept = normalizeIssues([{ id: "parent", title: "父" }, { id: "child", title: "子", parentId: "parent" }]);
  assert.equal(kept[1].parentId, "parent");
});

test("磁盘写不进去也不抛，调用方仍然拿到收敛后的清单", () => {
  assert.equal(writeIssues(join(tmpdir(), "coilcoil-no-such-dir/x/y/z.json"), [newIssue("标题", "", "low")]).length, 1);
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

test("待办池里的东西不会被拿去做——那只是记下来的想法", () => {
  const issues = [make("只是个想法", "high", "2026-01-01", "pool"), make("真要做的", "low", "2026-01-02")];
  assert.equal(nextRunnableIssue(issues)?.title, "真要做的");
  assert.equal(nextRunnableIssue([make("只是个想法", "high", "2026-01-01", "pool")]), undefined);
});

test("已经有一条在跑的时候一条都不挑——第一版是串行的", () => {
  const issues = [make("在跑", "high", "2026-01-01"), make("排着", "high", "2026-01-02")];
  assert.equal(nextRunnableIssue(withStatus(issues, "在跑", "doing")), undefined);
  assert.equal(nextRunnableIssue(withStatus(issues, "在跑", "review"))?.title, "排着");
});

test("批阅队列：待回复排在待验收前面，标了以后再看的不进队", () => {
  const issues = [
    make("等我验收", "high", "2026-01-01", "review"),
    make("等我拿主意", "low", "2026-01-02", "reply"),
    make("还在待处理", "high", "2026-01-03"),
  ];
  // 待回复是卡着它继续做的，所以先看那条，哪怕它优先级更低。
  assert.deepEqual(reviewQueue(issues).map((issue) => issue.title), ["等我拿主意", "等我验收"]);
  const deferred = withDeferred(issues, "等我验收", true);
  assert.deepEqual(reviewQueue(deferred).map((issue) => issue.title), ["等我拿主意"]);
  // 但它仍然留在待验收那一列里，不是消失了。
  assert.equal(issuesInColumn(deferred, "review").length, 1);
});

test("打回重做是一个动作：退回待处理，理由留在时间线上", () => {
  const rejected = rejectIssue([make("做得不对", "high", "2026-01-01", "review")], "做得不对", "这里不对，重做");
  assert.equal(rejected[0].status, "ready");
  const last = rejected[0].events.at(-1);
  assert.equal(last?.kind, "status");
  assert.match(last?.text ?? "", /打回重做：这里不对，重做/);
  // 「打回重做」不是一列，面板上找不到它。
  assert.ok(!ISSUE_COLUMNS.some((column) => column.name.includes("打回")));
});

test("在待回复上回一句，它自己回到待处理", () => {
  const replied = withComment([make("等我拿主意", "high", "2026-01-01", "reply")], "等我拿主意", "就按第二个方案");
  assert.equal(replied[0].status, "ready");
  assert.equal(replied[0].events.at(-1)?.text, "就按第二个方案");
  // 别的状态上留言只是留言，不会把卡片挪走。
  const noted = withComment([make("在待验收", "high", "2026-01-01", "review")], "在待验收", "先放着");
  assert.equal(noted[0].status, "review");
});

test("挪到别处就不再是「以后再验收」", () => {
  const deferred = withDeferred([make("一条", "high", "2026-01-01", "review")], "一条", true);
  assert.equal(deferred[0].deferred, true);
  assert.equal(withStatus(deferred, "一条", "done")[0].deferred, false);
});

test("六列就是用户定的那六档，完成排在最后", () => {
  assert.deepEqual(ISSUE_COLUMNS.map((column) => column.status), ["pool", "ready", "doing", "review", "reply", "done"]);
});

test("删父连子一起删，不留下认不出来的孤儿", () => {
  const issues = [
    { ...newIssue("父", "", "high"), id: "parent" },
    { ...newIssue("子", "", "low"), id: "child", parentId: "parent" },
    { ...newIssue("别人", "", "low"), id: "other" },
  ];
  assert.deepEqual(childrenOf(issues, "parent").map((issue) => issue.id), ["child"]);
  assert.deepEqual(removeIssue(issues, "parent").map((issue) => issue.id), ["other"]);
});

test("发给它的那段话带着标题、正文和最近几条来回", () => {
  const parent = newIssue("大改造", "", "high");
  const child = { ...newIssue("其中一步", "正文", "high", { parentId: parent.id }), events: [
    { at: "2026-01-01T00:00:00.000Z", by: "user" as const, kind: "comment" as const, text: "注意别动样式" },
  ] };
  const prompt = issuePrompt(child, parent);
  assert.match(prompt, /其中一步/);
  assert.match(prompt, /正文/);
  assert.match(prompt, /大改造/);
  assert.match(prompt, /注意别动样式/);
  assert.match(prompt, /说明你改了什么/);
});

test("同一条提交两次是覆盖不是加一条", () => {
  const issue = newIssue("标题", "", "medium");
  const twice = upsertIssue(upsertIssue([], issue), { ...issue, title: "改过的标题" });
  assert.equal(twice.length, 1);
  assert.equal(twice[0].title, "改过的标题");
});
