import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryDocumentSnapshot } from "@coilcoil/runtime-protocol";
import {
  ENTRY_SIZE,
  GLOBAL_NODE_ID,
  buildMemoryNebula,
  entryBlockShape,
  groupMemoryProjects,
  type NebulaNode,
} from "../src/renderer/src/features/memory/nebulaLayout.ts";

function document(overrides: Partial<MemoryDocumentSnapshot>): MemoryDocumentSnapshot {
  return {
    scope: "project", kind: "index", label: "MEMORY",
    filePath: "/store/A/MEMORY.md", directory: "/store/A",
    exists: true, content: "", contentChars: 0, maxChars: 5100, projectName: "A",
    ...overrides,
  };
}

const globalDocument = document({
  scope: "global", label: "GLOBAL", filePath: "/store/GLOBAL.md",
  directory: "/store", projectName: undefined, contentChars: 67,
});

function entry(project: string, name: string): MemoryDocumentSnapshot {
  return document({
    kind: "entry", label: name, filePath: `/store/${project}/memories/${name}.md`,
    directory: `/store/${project}/memories`, projectName: project, contentChars: 100,
  });
}

/** Two drawn cards sharing space. This is the bug the first version shipped. */
function overlappingPairs(nodes: readonly NebulaNode[]): string[] {
  const clashes: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (Math.abs(a.x - b.x) * 2 < a.width + b.width && Math.abs(a.y - b.y) * 2 < a.height + b.height) {
        clashes.push(`${a.id} × ${b.id}`);
      }
    }
  }
  return clashes;
}

/** The store this was designed against: nine projects, sixty-five memories. */
function realisticStore(): MemoryDocumentSnapshot[] {
  const counts: Record<string, number> = {
    EveleLabTest: 0, Home: 13, SuoCode: 2, "ai-learning": 0,
    feedmob: 27, project: 1, shijieshuju3: 5, unity2: 17, 生视频: 0,
  };
  return Object.entries(counts).flatMap(([name, count]) => [
    document({ projectName: name, filePath: `/store/${name}/MEMORY.md` }),
    ...Array.from({ length: count }, (_, index) => entry(name, `记忆${index}`)),
  ]);
}

test("按项目分组，索引和正文各归各位", () => {
  const groups = groupMemoryProjects([
    document({ projectName: "B", filePath: "/store/B/MEMORY.md" }),
    entry("A", "部署"),
    document({ projectName: "A", filePath: "/store/A/MEMORY.md" }),
  ]);
  assert.deepEqual(groups.map((group) => group.name), ["A", "B"]);
  assert.equal(groups[0].entries.length, 1);
  assert.equal(groups[1].entries.length, 0);
});

test("只有正文没有索引的项目照样成组", () => {
  const groups = groupMemoryProjects([entry("C", "只剩正文")]);
  assert.deepEqual(groups.map((group) => group.name), ["C"]);
  assert.equal(groups[0].index, undefined);
});

test("默认全部收起：一个项目一张卡，没有一条记忆铺在图上", () => {
  // 65 条记忆同时画出来，在任何缩放下都读不了——这是第一版最根本的错。
  const layout = buildMemoryNebula(globalDocument, realisticStore());
  assert.equal(layout.nodes.filter((node) => node.kind === "entry").length, 0);
  assert.equal(layout.nodes.length, 10, "一个全局加九个项目");
});

test("收起状态下没有任何两张卡重叠", () => {
  assert.deepEqual(overlappingPairs(buildMemoryNebula(globalDocument, realisticStore()).nodes), []);
});

test("展开最大的那个项目，仍然没有卡片重叠", () => {
  // 27 条的块很宽；如果只按高度让位，处在圆环侧面的块会压回自己的项目卡上。
  const layout = buildMemoryNebula(globalDocument, realisticStore(), new Set(["feedmob"]));
  assert.equal(layout.nodes.filter((node) => node.kind === "entry").length, 27);
  assert.deepEqual(overlappingPairs(layout.nodes), []);
});

test("九个项目全部展开，七十五张卡也互不重叠", () => {
  const all = new Set(["Home", "SuoCode", "feedmob", "project", "shijieshuju3", "unity2"]);
  const layout = buildMemoryNebula(globalDocument, realisticStore(), all);
  assert.equal(layout.nodes.length, 75);
  assert.deepEqual(overlappingPairs(layout.nodes), []);
});

test("展开的项目把邻居推开，而不是画到它们身上", () => {
  const closed = buildMemoryNebula(globalDocument, realisticStore());
  const open = buildMemoryNebula(globalDocument, realisticStore(), new Set(["feedmob"]));
  const ringRadius = (layout: ReturnType<typeof buildMemoryNebula>): number => {
    const project = layout.nodes.find((node) => node.id === "project:Home")!;
    return Math.hypot(project.x, project.y);
  };
  assert.ok(ringRadius(open) > ringRadius(closed), "展开后外圈必须变大");
});

test("记忆块摆成近似方形，不会拉成一长条", () => {
  assert.deepEqual(entryBlockShape(0), { columns: 0, rows: 0, width: 0, height: 0 });
  assert.equal(entryBlockShape(1).columns, 1);
  assert.equal(entryBlockShape(4).columns, 2);
  assert.equal(entryBlockShape(27).columns, 4, "再多也不超过四列，否则块比屏幕还宽");
  assert.equal(entryBlockShape(27).rows, 7);
});

test("卡片尺寸就是样式里的尺寸——两边对不上就会重叠", () => {
  // 第一版按每张卡 34px 排，实际画出来 140px，于是 92 对卡片压在一起。
  const layout = buildMemoryNebula(globalDocument, realisticStore(), new Set(["SuoCode"]));
  for (const node of layout.nodes.filter((item) => item.kind === "entry")) {
    assert.equal(node.width, ENTRY_SIZE.width);
    assert.equal(node.height, ENTRY_SIZE.height);
  }
});

test("每个展开的项目只牵一条线到它的块，不是每条记忆一条", () => {
  const layout = buildMemoryNebula(globalDocument, realisticStore(), new Set(["feedmob"]));
  const toEntries = layout.links.filter((link) => link.to.includes("/memories/"));
  assert.equal(toEntries.length, 1);
  assert.equal(layout.links.filter((link) => link.from === GLOBAL_NODE_ID).length, 9);
});

test("空的记忆库也画得出来", () => {
  const layout = buildMemoryNebula(undefined, []);
  assert.deepEqual(layout.nodes.map((node) => node.id), [GLOBAL_NODE_ID]);
  assert.deepEqual(layout.links, []);
  assert.ok(layout.width > 0 && layout.height > 0);
});
