import assert from "node:assert/strict";
import test from "node:test";
import { projectSnapshot } from "../src/project-snapshot.js";

test("a successful project scan clears an old scan error while in-memory updates retain it", () => {
  const active = {
    cwd: "/tmp/project",
    project: { cwd: "/tmp/project", files: [], changes: [], changesError: "old scan failed", terminals: [], refreshedAt: 0 },
    terminals: new Map(),
  };
  assert.equal(projectSnapshot(active).changesError, "old scan failed");
  assert.equal(projectSnapshot(active, { files: [], changes: [] }).changesError, undefined);
});
