import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";
import { collectRecentSessions, DEFAULT_RECENT_ROWS } from "../src/renderer/src/features/workspaces/recentSessions";
import { nextExpandedSessionLimit } from "../src/renderer/src/features/workspaces/sessionList";

const project = (name: string): ProjectSelection => ({ kind: "workspace", name, path: `/projects/${name}` });

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    path: `/sessions/${overrides.id}.jsonl`,
    cwd: "/projects/one",
    title: overrides.id,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    messageCount: 2,
    ...overrides,
  };
}

test("recent lists conversations from every workspace, newest first", () => {
  const one = project("one");
  const two = project("two");
  const recent = collectRecentSessions([one, two], {
    [one.path]: [session({ id: "old", updatedAt: "2026-08-01T00:00:00.000Z" })],
    [two.path]: [session({ id: "new", updatedAt: "2026-08-20T00:00:00.000Z" })],
  });

  assert.deepEqual(recent.map((entry) => entry.session.id), ["new", "old"]);
  assert.equal(recent[0]?.project.name, "two");
});

test("opening a conversation does not reorder the list", () => {
  // Counting "last opened" as recency sent whatever was just clicked to the top,
  // so the list rearranged itself under the pointer and a conversation was never
  // twice in the same place. Only its own activity moves a row.
  const one = project("one");
  const sessions = {
    [one.path]: [
      session({ id: "written", updatedAt: "2026-08-20T00:00:00.000Z" }),
      session({ id: "read", updatedAt: "2026-08-01T00:00:00.000Z" }),
    ],
  };

  assert.deepEqual(collectRecentSessions([one], sessions).map((entry) => entry.session.id), ["written", "read"]);
});

test("pinned and archived conversations stay out of recent", () => {
  const one = project("one");
  const recent = collectRecentSessions([one], {
    [one.path]: [
      session({ id: "pinned", pinned: true, updatedAt: "2026-08-25T00:00:00.000Z" }),
      session({ id: "archived", archivedAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }),
      session({ id: "plain", updatedAt: "2026-08-20T00:00:00.000Z" }),
    ],
  });

  assert.deepEqual(recent.map((entry) => entry.session.id), ["plain"]);
});

test("the whole ordering is returned so the section can be expanded", () => {
  // The section shows DEFAULT_RECENT_ROWS of these and grows on demand, so
  // truncating here would put a ceiling on "show more".
  const one = project("one");
  const sessions = Array.from({ length: DEFAULT_RECENT_ROWS + 3 }, (_, index) => session({
    id: `s${index}`,
    updatedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
  }));
  const recent = collectRecentSessions([one], { [one.path]: sessions });

  assert.equal(recent.length, DEFAULT_RECENT_ROWS + 3);
  // One press of "more" reaches the rest; a second collapse returns to four.
  const grown = nextExpandedSessionLimit(DEFAULT_RECENT_ROWS, recent.length);
  assert.equal(grown, recent.length);
});
