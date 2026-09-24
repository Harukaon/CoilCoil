import type { GitCommit } from "@coilcoil/runtime-protocol";

/**
 * 提交历史左边那一列线条图，算法照搬 VS Code 的源代码管理图
 * （src/vs/workbench/contrib/scm/browser/scmHistory.ts，MIT）。
 *
 * 思路：提交按拓扑顺序一行一行往下排，每一行有「进来的泳道」和「出去的泳道」，一条
 * 泳道就是「往下走、等着遇到某个提交」的一根线。遇到这个提交时，等它的第一根泳道
 * 改成等它的第一个父提交，其余等它的泳道在这里汇合消失（分叉点）；合并提交的其余
 * 父提交各开一根新泳道（合并点）。画的时候只看这一行的进出泳道，所以每行独立画一
 * 个小 SVG，拼起来就是连续的图。
 */

export const GRAPH_ROW_HEIGHT = 22;
export const GRAPH_LANE_WIDTH = 11;
const CURVE_RADIUS = 5;

/** 当前分支、它的上游各一种固定颜色，其余泳道轮着用这几种。和 VS Code 默认一致。 */
export const CURRENT_REF_COLOR = "var(--git-graph-ref)";
export const UPSTREAM_REF_COLOR = "var(--git-graph-remote)";
export const LANE_COLORS = ["#FFB000", "#DC267F", "#994F00", "#40B0A6", "#B66DFF"];

export interface GraphLane {
  /** 这根线往下在等哪个提交。 */
  id: string;
  color: string;
}

export interface GraphRow {
  commit: GitCommit;
  head: boolean;
  input: GraphLane[];
  output: GraphLane[];
}

export interface GraphRefs {
  head?: string;
  currentRef?: string;
  upstreamRef?: string;
}

export function refColors(refs: GraphRefs): Map<string, string> {
  const colors = new Map<string, string>();
  if (refs.currentRef) colors.set(refs.currentRef, CURRENT_REF_COLOR);
  if (refs.upstreamRef) colors.set(refs.upstreamRef, UPSTREAM_REF_COLOR);
  return colors;
}

function labelColor(commit: GitCommit | undefined, colors: Map<string, string>): string | undefined {
  for (const ref of commit?.refs ?? []) {
    const color = colors.get(ref.fullName);
    if (color) return color;
  }
  return undefined;
}

export function buildGraph(commits: GitCommit[], refs: GraphRefs = {}): GraphRow[] {
  const colors = refColors(refs);
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  let colorIndex = -1;
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const input = (rows.at(-1)?.output ?? []).map((lane) => ({ ...lane }));
    const output: GraphLane[] = [];
    let firstParentAdded = false;
    for (const lane of input) {
      if (lane.id === commit.hash) {
        // 等这个提交的第一根线接着往下等它的第一个父提交；其余的在这里汇合。
        if (!firstParentAdded && commit.parents[0]) {
          output.push({ id: commit.parents[0], color: labelColor(commit, colors) ?? lane.color });
          firstParentAdded = true;
        }
        continue;
      }
      // 和 VS Code 不同的一点：根提交（没有父提交）不会把别的泳道一起吞掉。显示所有
      // 分支时可能有好几个根提交，别的线得接着往下走。
      output.push({ ...lane });
    }
    for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index += 1) {
      const parent = commit.parents[index]!;
      let color = index === 0 ? labelColor(commit, colors) : labelColor(byHash.get(parent), colors);
      if (!color) {
        colorIndex = (colorIndex + 1) % LANE_COLORS.length;
        color = LANE_COLORS[colorIndex]!;
      }
      output.push({ id: parent, color });
    }
    rows.push({ commit, head: commit.hash === refs.head, input, output });
  }
  return rows;
}

export interface GraphShape {
  width: number;
  paths: { d: string; color: string }[];
  circle: { cx: number; cy: number; color: string; kind: "head" | "merge" | "node" };
}

const x = (lane: number): number => GRAPH_LANE_WIDTH * (lane + 1);

/** 一行的线条和圆点。和 VS Code 的 renderSCMHistoryItemGraph 一一对应。 */
export function graphShape(row: GraphRow): GraphShape {
  const { commit, input, output } = row;
  const H = GRAPH_ROW_HEIGHT;
  const W = GRAPH_LANE_WIDTH;
  const paths: GraphShape["paths"] = [];
  const inputIndex = input.findIndex((lane) => lane.id === commit.hash);
  const circleIndex = inputIndex !== -1 ? inputIndex : input.length;
  const circleColor = output[circleIndex]?.color ?? input[circleIndex]?.color ?? CURRENT_REF_COLOR;

  let outputIndex = 0;
  for (let index = 0; index < input.length; index += 1) {
    const lane = input[index]!;
    if (lane.id === commit.hash) {
      if (index !== circleIndex) {
        // 分叉点：另一根也在等这个提交的线，从上面弯过来汇进圆点。
        paths.push({ color: lane.color, d: `M ${x(index)} 0 A ${W} ${W} 0 0 1 ${W * index} ${W} H ${x(circleIndex)}` });
      } else if (commit.parents.length > 0) {
        // 圆点这条泳道往下接的是第一个父提交；根提交没有，右边的线要往左挪过来。
        outputIndex += 1;
      }
      continue;
    }
    if (outputIndex < output.length && lane.id === output[outputIndex]!.id) {
      if (index === outputIndex) {
        paths.push({ color: lane.color, d: `M ${x(index)} 0 V ${H}` });
      } else {
        // 左边有线在这一行结束了，这根线往左挪一格。
        paths.push({
          color: lane.color,
          d: [
            `M ${x(index)} 0`,
            "V 6",
            `A ${CURVE_RADIUS} ${CURVE_RADIUS} 0 0 1 ${x(index) - CURVE_RADIUS} ${H / 2}`,
            `H ${x(outputIndex) + CURVE_RADIUS}`,
            `A ${CURVE_RADIUS} ${CURVE_RADIUS} 0 0 0 ${x(outputIndex)} ${H / 2 + CURVE_RADIUS}`,
            `V ${H}`,
          ].join(" "),
        });
      }
      outputIndex += 1;
    }
  }

  // 合并点：其余父提交各有一根新线，从圆点横着出去再往下弯。
  for (let index = 1; index < commit.parents.length; index += 1) {
    let parentIndex = -1;
    for (let lane = output.length - 1; lane >= 0; lane -= 1) {
      if (output[lane]!.id === commit.parents[index]) { parentIndex = lane; break; }
    }
    if (parentIndex === -1) continue;
    paths.push({
      color: output[parentIndex]!.color,
      d: `M ${W * parentIndex} ${H / 2} A ${W} ${W} 0 0 1 ${x(parentIndex)} ${H} M ${W * parentIndex} ${H / 2} H ${x(circleIndex)}`,
    });
  }

  if (inputIndex !== -1) paths.push({ color: input[inputIndex]!.color, d: `M ${x(circleIndex)} 0 V ${H / 2}` });
  if (commit.parents.length > 0) paths.push({ color: circleColor, d: `M ${x(circleIndex)} ${H / 2} V ${H}` });

  return {
    width: W * (Math.max(input.length, output.length, 1) + 1),
    paths,
    circle: { cx: x(circleIndex), cy: H / 2, color: circleColor, kind: row.head ? "head" : commit.parents.length > 1 ? "merge" : "node" },
  };
}

/** 展开一个提交看文件时，文件那几行左边接着画的竖线，让图不断开。 */
export function placeholderShape(lanes: GraphLane[]): Pick<GraphShape, "width" | "paths"> {
  return {
    width: GRAPH_LANE_WIDTH * (lanes.length + 1),
    paths: lanes.map((lane, index) => ({ color: lane.color, d: `M ${x(index)} 0 V ${GRAPH_ROW_HEIGHT}` })),
  };
}
