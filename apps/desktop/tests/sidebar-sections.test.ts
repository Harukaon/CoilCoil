import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SIDEBAR_SECTION_ORDER,
  moveSidebarSection,
  resolveSidebarSectionOrder,
  serializeSidebarSectionOrder,
} from "../src/renderer/src/features/workspaces/sidebarSections";

test("nothing stored means the order the sidebar has always opened with", () => {
  assert.deepEqual(resolveSidebarSectionOrder(null), ["recent", "projects"]);
  assert.deepEqual(resolveSidebarSectionOrder(""), [...DEFAULT_SIDEBAR_SECTION_ORDER]);
});

test("a stored order round-trips", () => {
  const swapped = moveSidebarSection(["recent", "projects"], "projects", "up");
  assert.deepEqual(swapped, ["projects", "recent"]);
  assert.deepEqual(resolveSidebarSectionOrder(serializeSidebarSectionOrder(swapped)), ["projects", "recent"]);
});

test("either heading's control performs the same swap", () => {
  assert.deepEqual(moveSidebarSection(["recent", "projects"], "recent", "down"), ["projects", "recent"]);
  assert.deepEqual(moveSidebarSection(["projects", "recent"], "recent", "up"), ["recent", "projects"]);
});

test("moving past either end leaves the order alone", () => {
  assert.deepEqual(moveSidebarSection(["recent", "projects"], "recent", "up"), ["recent", "projects"]);
  assert.deepEqual(moveSidebarSection(["recent", "projects"], "projects", "down"), ["recent", "projects"]);
});

test("a damaged preference can never hide a section", () => {
  // Written by an older build, hand-edited, or truncated - whatever is missing
  // comes back in its default position instead of the section disappearing.
  assert.deepEqual(resolveSidebarSectionOrder("projects"), ["projects", "recent"]);
  assert.deepEqual(resolveSidebarSectionOrder("projects,projects"), ["projects", "recent"]);
  assert.deepEqual(resolveSidebarSectionOrder("nonsense"), ["recent", "projects"]);
  assert.deepEqual(resolveSidebarSectionOrder(" projects , recent "), ["projects", "recent"]);
});
