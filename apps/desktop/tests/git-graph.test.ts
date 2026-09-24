import assert from "node:assert/strict";
import test from "node:test";
import type { GitCommit } from "@coilcoil/runtime-protocol";
import { buildGraph, CURRENT_REF_COLOR, graphShape, LANE_COLORS, placeholderShape, UPSTREAM_REF_COLOR } from "../src/renderer/src/features/git/gitGraph.ts";

function commit(hash: string, parents: string[], refs: string[] = []): GitCommit {
  return {
    hash, shortHash: hash, parents, author: "a", email: "a@example.com", date: 0, subject: hash, body: "",
    refs: refs.map((fullName) => ({ fullName, name: fullName.replace(/^refs\/(heads|remotes)\//, ""), kind: fullName.startsWith("refs/remotes/") ? "remote" : "branch" })),
  };
}

// M 合并了 F；F 和 A 都从 B 分出来；R 是根提交。拓扑顺序，子提交在前。
const HISTORY = [
  commit("M", ["A", "F"], ["refs/heads/main"]),
  commit("F", ["B"]),
  commit("A", ["B"]),
  commit("B", ["R"]),
  commit("R", []),
];

const lanes = (list: { id: string }[]): string[] => list.map((lane) => lane.id);

test("泳道：合并点开出第二条线，分叉点两条线汇成一条，根提交之后没有线", () => {
  const rows = buildGraph(HISTORY, { head: "M", currentRef: "refs/heads/main" });
  assert.deepEqual(rows.map((row) => [row.commit.hash, lanes(row.input), lanes(row.output)]), [
    ["M", [], ["A", "F"]],
    ["F", ["A", "F"], ["A", "B"]],
    ["A", ["A", "B"], ["B", "B"]],
    ["B", ["B", "B"], ["R"]],
    ["R", ["R"], []],
  ]);
  assert.equal(rows[0]!.head, true);
  // 当前分支那条主线用当前分支的颜色，合并进来的那条轮到第一种泳道颜色。
  assert.equal(rows[0]!.output[0]!.color, CURRENT_REF_COLOR);
  assert.equal(rows[0]!.output[1]!.color, LANE_COLORS[0]);
  assert.equal(rows[3]!.output[0]!.color, CURRENT_REF_COLOR, "汇合后留下的是左边那条（主线）");
});

test("每行的形状：HEAD、合并点横着出去、分叉点从右边弯进来、侧线直着往下", () => {
  const rows = buildGraph(HISTORY, { head: "M", currentRef: "refs/heads/main" });
  const merge = graphShape(rows[0]!);
  assert.equal(merge.circle.kind, "head");
  assert.equal(merge.circle.cx, 11);
  assert.equal(merge.width, 33);
  assert.ok(merge.paths.some((path) => path.d.startsWith("M 11 11 A 11 11 0 0 1 22 22")), "合并点：朝第二条泳道弯下去");

  const side = graphShape(rows[1]!);
  assert.equal(side.circle.cx, 22, "F 在第二条泳道上");
  assert.ok(side.paths.some((path) => path.d === "M 11 0 V 22"), "主线直着穿过这一行");

  const fork = graphShape(rows[3]!);
  assert.equal(fork.circle.cx, 11);
  assert.ok(fork.paths.some((path) => path.d.startsWith("M 22 0 A 11 11 0 0 1 11 11")), "分叉点：右边那条弯进圆点");

  const root = graphShape(rows[4]!);
  assert.equal(root.paths.some((path) => path.d.includes("V 22") && path.d.startsWith("M 11 11")), false, "根提交下面不再画线");
  assert.equal(root.circle.kind, "node");

  const notHead = graphShape({ ...rows[0]!, head: false });
  assert.equal(notHead.circle.kind, "merge");
});

test("上游和当前分支分叉：两条线各用自己的颜色，在共同祖先处汇合", () => {
  const rows = buildGraph([
    commit("L", ["B"], ["refs/heads/main"]),
    commit("U", ["B"], ["refs/remotes/origin/main"]),
    commit("B", []),
  ], { head: "L", currentRef: "refs/heads/main", upstreamRef: "refs/remotes/origin/main" });
  assert.deepEqual(rows.map((row) => lanes(row.output)), [["B"], ["B", "B"], []]);
  assert.equal(rows[1]!.output[1]!.color, UPSTREAM_REF_COLOR);
  assert.equal(graphShape(rows[1]!).circle.cx, 22, "上游的提交画在第二条泳道");
});

test("显示所有分支时有两个根提交：一个根提交不会把另一条线吞掉", () => {
  const rows = buildGraph([commit("X", ["R1"]), commit("Y", ["R2"]), commit("R1", []), commit("R2", [])]);
  assert.deepEqual(rows.map((row) => lanes(row.output)), [["R1"], ["R1", "R2"], ["R2"], []]);
  const shape = graphShape(rows[2]!);
  assert.ok(shape.paths.some((path) => path.d.includes("V 6")), "右边那条线往左挪一格");
});

test("展开提交时文件行接着画竖线", () => {
  const rows = buildGraph(HISTORY);
  assert.deepEqual(placeholderShape(rows[1]!.output).paths.map((path) => path.d), ["M 11 0 V 22", "M 22 0 V 22"]);
});
