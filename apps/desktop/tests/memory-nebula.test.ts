import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryDocumentSnapshot } from "@coilcoil/runtime-protocol";
import {
  GLOBAL_NODE_ID,
  buildMemoryNebula,
  clampZoom,
  groupMemoryProjects,
  nebulaCentre,
  zoomToFit,
} from "../src/renderer/src/features/memory/nebulaLayout.ts";

function document(overrides: Partial<MemoryDocumentSnapshot>): MemoryDocumentSnapshot {
  return {
    scope: "project",
    kind: "index",
    label: "MEMORY",
    filePath: "/store/A/MEMORY.md",
    directory: "/store/A",
    exists: true,
    content: "",
    contentChars: 0,
    maxChars: 5100,
    projectName: "A",
    ...overrides,
  };
}

const globalDocument = document({
  scope: "global",
  label: "GLOBAL",
  filePath: "/store/GLOBAL.md",
  directory: "/store",
  projectName: undefined,
  contentChars: 67,
});

function entry(project: string, name: string, chars = 100): MemoryDocumentSnapshot {
  return document({
    kind: "entry",
    label: name,
    filePath: `/store/${project}/memories/${name}.md`,
    directory: `/store/${project}/memories`,
    projectName: project,
    contentChars: chars,
  });
}

test("按项目分组，索引和正文各归各位", () => {
  const groups = groupMemoryProjects([
    document({ projectName: "B", filePath: "/store/B/MEMORY.md" }),
    entry("A", "部署"),
    document({ projectName: "A", filePath: "/store/A/MEMORY.md" }),
    entry("A", "接口"),
  ]);
  assert.deepEqual(groups.map((group) => group.name), ["A", "B"]);
  assert.equal(groups[0].entries.length, 2);
  assert.equal(groups[0].index?.filePath, "/store/A/MEMORY.md");
  assert.equal(groups[1].entries.length, 0);
});

test("只有正文没有索引的项目照样成组", () => {
  // MEMORY.md 被删掉或者还没写，正文却在——这个项目不能从图上消失。
  const groups = groupMemoryProjects([entry("C", "只剩正文")]);
  assert.deepEqual(groups.map((group) => group.name), ["C"]);
  assert.equal(groups[0].index, undefined);
});

test("全局在圆心，项目绕着它，正文绕着自己的项目", () => {
  const layout = buildMemoryNebula(globalDocument, [
    document({ projectName: "A", filePath: "/store/A/MEMORY.md" }),
    entry("A", "部署"),
    document({ projectName: "B", filePath: "/store/B/MEMORY.md" }),
  ]);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const centre = byId.get(GLOBAL_NODE_ID);
  assert.deepEqual([centre?.x, centre?.y], [0, 0]);
  assert.equal(centre?.childCount, 2);

  const project = byId.get("project:A");
  assert.ok(project && Math.hypot(project.x, project.y) > 0, "项目不该压在圆心上");

  const body = byId.get("/store/A/memories/部署.md");
  assert.ok(body, "正文要有自己的节点");
  assert.equal(body?.parentId, "project:A");
  const distanceToProject = Math.hypot(body!.x - project!.x, body!.y - project!.y);
  const distanceToCentre = Math.hypot(body!.x, body!.y);
  assert.ok(distanceToProject < distanceToCentre, "正文该贴着它自己的项目，而不是贴着圆心");
});

test("连线把整棵树连起来，没有断点", () => {
  const layout = buildMemoryNebula(globalDocument, [
    document({ projectName: "A", filePath: "/store/A/MEMORY.md" }),
    entry("A", "部署"),
    entry("A", "接口"),
  ]);
  assert.equal(layout.links.length, layout.nodes.length - 1, "n 个节点应有 n-1 条边");
  const ids = new Set(layout.nodes.map((node) => node.id));
  for (const link of layout.links) {
    assert.ok(ids.has(link.from) && ids.has(link.to), "连线两端都必须是真实节点");
  }
});

test("同样的输入永远得到同样的位置", () => {
  // 力导向图每次打开都换个样子，昨天在左边的记忆今天在右边。位置必须是算出来的。
  const documents = [document({ projectName: "A" }), entry("A", "部署"), document({ projectName: "B", filePath: "/store/B/MEMORY.md" })];
  const first = buildMemoryNebula(globalDocument, documents);
  const second = buildMemoryNebula(globalDocument, documents);
  assert.deepEqual(first.nodes.map((node) => [node.id, node.x, node.y]), second.nodes.map((node) => [node.id, node.x, node.y]));
});

test("项目越多，外圈越大，不会挤成一团", () => {
  const ring = (count: number): number => {
    const layout = buildMemoryNebula(globalDocument, Array.from({ length: count }, (_, index) =>
      document({ projectName: `P${index}`, filePath: `/store/P${index}/MEMORY.md` })));
    const project = layout.nodes.find((node) => node.kind === "project")!;
    return Math.hypot(project.x, project.y);
  };
  assert.ok(ring(30) > ring(3), "三十个项目的圈必须比三个的大");
});

test("画布装得下最远的节点", () => {
  const layout = buildMemoryNebula(globalDocument, Array.from({ length: 12 }, (_, index) =>
    entry("A", `记忆${index}`)));
  const centre = nebulaCentre(layout);
  for (const node of layout.nodes) {
    assert.ok(centre.x + node.x > 0 && centre.x + node.x < layout.width, `${node.id} 横向越界`);
    assert.ok(centre.y + node.y > 0 && centre.y + node.y < layout.height, `${node.id} 纵向越界`);
  }
});

test("空的记忆库也画得出来", () => {
  const layout = buildMemoryNebula(undefined, []);
  assert.deepEqual(layout.nodes.map((node) => node.id), [GLOBAL_NODE_ID]);
  assert.deepEqual(layout.links, []);
  assert.ok(layout.width > 0 && layout.height > 0);
});

test("缩放有上下限，适应视口时不会放大过头", () => {
  assert.equal(clampZoom(99), 2);
  assert.equal(clampZoom(0), 0.35);
  const layout = buildMemoryNebula(globalDocument, [document({})]);
  // 视口比画布大得多时也停在 1:1，放大的空图只会更难看。
  assert.equal(zoomToFit(layout, 9_000, 9_000), 1);
  assert.ok(zoomToFit(layout, 200, 200) < 1);
  assert.equal(zoomToFit(layout, 0, 0), 1);
});
