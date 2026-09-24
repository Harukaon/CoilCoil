import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_SIDEBAR_SECTION_ORDER,
  dropSidebarSection,
  resolveSidebarSectionOrder,
  serializeSidebarSectionOrder,
} from "../src/renderer/src/features/workspaces/sidebarSections";

test("nothing stored means projects on top, recent below", () => {
  assert.deepEqual(resolveSidebarSectionOrder(null), ["projects", "recent"]);
  assert.deepEqual(resolveSidebarSectionOrder(""), [...DEFAULT_SIDEBAR_SECTION_ORDER]);
});

test("a stored order round-trips", () => {
  const swapped = dropSidebarSection(["projects", "recent"], "recent", "projects");
  assert.deepEqual(swapped, ["recent", "projects"]);
  assert.deepEqual(resolveSidebarSectionOrder(serializeSidebarSectionOrder(swapped)), ["recent", "projects"]);
});

test("dragging either heading onto the other swaps them", () => {
  assert.deepEqual(dropSidebarSection(["projects", "recent"], "projects", "recent"), ["recent", "projects"]);
  assert.deepEqual(dropSidebarSection(["recent", "projects"], "projects", "recent"), ["projects", "recent"]);
});

test("dropping a heading on itself changes nothing", () => {
  // 拖起来又原地放下是最常见的一次「误操作」，不能因此写一次存储、也不能重排。
  assert.deepEqual(dropSidebarSection(["projects", "recent"], "projects", "projects"), ["projects", "recent"]);
  assert.deepEqual(dropSidebarSection(["recent", "projects"], "recent", "recent"), ["recent", "projects"]);
});

test("a damaged preference can never hide a section", () => {
  // Written by an older build, hand-edited, or truncated - whatever is missing
  // comes back in its default position instead of the section disappearing.
  assert.deepEqual(resolveSidebarSectionOrder("recent"), ["recent", "projects"]);
  assert.deepEqual(resolveSidebarSectionOrder("recent,recent"), ["recent", "projects"]);
  assert.deepEqual(resolveSidebarSectionOrder("nonsense"), ["projects", "recent"]);
  assert.deepEqual(resolveSidebarSectionOrder(" recent , projects "), ["recent", "projects"]);
});

test("两栏是靠拖标题换顺序的，不是靠按钮", () => {
  // 用户的原话：「不行，我要的是拖动换顺序，不是有一个按钮」。这条盯着别再退回去。
  const sidebar = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/features/workspaces/WorkspaceSidebar.tsx"),
    "utf8",
  );
  assert.match(sidebar, /sectionDragProps/, "标题上没有拖动处理");
  assert.match(sidebar, /draggable: true/);
  assert.doesNotMatch(sidebar, /上移|下移/, "又冒出了上移/下移按钮");
});
