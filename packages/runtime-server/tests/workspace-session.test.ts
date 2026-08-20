import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSnapshot, SessionSummary } from "@coilcoil/runtime-protocol";
import { selectWorkspaceSessionPath } from "../src/workspace-session.js";

function summary(path: string, pinned = false): SessionSummary {
  return {
    id: path,
    path,
    cwd: "/project",
    title: path,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messageCount: 0,
    pinned,
  };
}

function snapshot(path: string, cwd = "/project"): SessionSnapshot {
  return { session: { ...summary(path), cwd } } as SessionSnapshot;
}

test("workspace reload keeps the live selected session ahead of a pinned first result", () => {
  const sessions = [summary("/sessions/pinned.jsonl", true), summary("/sessions/running.jsonl")];
  assert.equal(
    selectWorkspaceSessionPath(sessions, snapshot("/sessions/running.jsonl"), "/project", (path) => path),
    "/sessions/running.jsonl",
  );
});

test("workspace selection returns empty when the live session belongs elsewhere or no longer exists", () => {
  const sessions = [summary("/sessions/pinned.jsonl", true), summary("/sessions/other.jsonl")];
  assert.equal(
    selectWorkspaceSessionPath(sessions, snapshot("/sessions/other.jsonl", "/another-project"), "/project", (path) => path),
    undefined,
  );
  assert.equal(
    selectWorkspaceSessionPath(sessions, snapshot("/sessions/deleted.jsonl"), "/project", (path) => path),
    undefined,
  );
});

test("workspace selection stays empty when there is no current session", () => {
  assert.equal(
    selectWorkspaceSessionPath([summary("/sessions/pinned.jsonl", true)], undefined, "/project", (path) => path),
    undefined,
  );
});

test("workspace selection compares canonicalized paths", () => {
  const sessions = [summary("/real/session.jsonl")];
  const normalize = (path: string): string => path.replace("/alias", "/real");
  assert.equal(
    selectWorkspaceSessionPath(sessions, snapshot("/alias/session.jsonl", "/alias"), "/real", normalize),
    "/real/session.jsonl",
  );
});
