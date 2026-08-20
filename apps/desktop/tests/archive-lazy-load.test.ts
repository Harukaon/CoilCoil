import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";
import {
  ARCHIVE_ROW_BATCH,
  filterArchivedSessionGroups,
  initialArchiveTarget,
  pendingArchiveTargets,
} from "../src/renderer/src/features/workspaces/archiveSessions.ts";

const project = (name: string): ProjectSelection => ({ name, path: `/p/${name}`, kind: "workspace" });
const session = (title: string): SessionSummary => ({
  id: title, path: `/s/${title}`, cwd: "/p", title,
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", messageCount: 1,
});

const projects = [project("a"), project("b"), project("c")];

test("opening reads the active project, not every project", () => {
  assert.equal(initialArchiveTarget(projects, projects[1]), "/p/b");
  // Reading every project up front re-scanned every session file of every
  // project just to show a handful of rows.
  assert.equal(initialArchiveTarget(projects, null), "/p/a");
  assert.equal(initialArchiveTarget(projects, project("gone")), "/p/a");
  assert.equal(initialArchiveTarget([], projects[0]), undefined);
});

test("only unread, not-in-flight projects are requested", () => {
  assert.deepEqual(pendingArchiveTargets(projects, { "/p/a": [] }, ["/p/b"]), ["/p/c"]);
  assert.deepEqual(pendingArchiveTargets(projects, { "/p/a": [], "/p/b": [], "/p/c": [] }, []), []);
  // An empty archive still counts as read, so it is never requested again.
  assert.deepEqual(pendingArchiveTargets(projects, {}, []), ["/p/a", "/p/b", "/p/c"]);
});

test("an unread project shows as pending rather than as empty", () => {
  const groups = filterArchivedSessionGroups(projects, { "/p/a": [session("x")] }, "");
  assert.deepEqual(groups.map((group) => [group.project.name, group.pending]), [["a", false], ["b", true], ["c", true]]);
});

test("a loaded group holds rows back until it is expanded", () => {
  const many = Array.from({ length: ARCHIVE_ROW_BATCH + 5 }, (_, index) => session(`s${index}`));
  const [collapsed] = filterArchivedSessionGroups([projects[0]], { "/p/a": many }, "");
  assert.equal(collapsed?.sessions.length, ARCHIVE_ROW_BATCH);
  assert.equal(collapsed?.hidden, 5);

  const [opened] = filterArchivedSessionGroups([projects[0]], { "/p/a": many }, "", ["/p/a"]);
  assert.equal(opened?.sessions.length, many.length);
  assert.equal(opened?.hidden, 0);
});

test("a search shows every match and drops groups that have none", () => {
  const many = Array.from({ length: ARCHIVE_ROW_BATCH + 5 }, (_, index) => session(`keep-${index}`));
  const loaded = { "/p/a": many, "/p/b": [session("other")], "/p/c": [] };
  const groups = filterArchivedSessionGroups(projects, loaded, "keep");
  assert.deepEqual(groups.map((group) => group.project.name), ["a"], "Groups without a match should drop out.");
  assert.equal(groups[0]?.sessions.length, many.length, "A search should not be truncated by the collapsed batch.");
  assert.equal(groups[0]?.hidden, 0);
});
