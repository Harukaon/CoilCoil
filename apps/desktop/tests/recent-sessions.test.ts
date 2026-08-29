import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";
import { collectRecentSessions, DEFAULT_RECENT_ROWS, visibleRecentSessions } from "../src/renderer/src/features/workspaces/recentSessions";
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

test("a pinned conversation is listed in recent too, archived ones are not", () => {
  // Pinning used to remove the conversation from recent, which reads as losing
  // it: the list you look at to find what you were just doing no longer has it.
  const one = project("one");
  const recent = collectRecentSessions([one], {
    [one.path]: [
      session({ id: "pinned", pinned: true, updatedAt: "2026-08-25T00:00:00.000Z" }),
      session({ id: "archived", archivedAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }),
      session({ id: "plain", updatedAt: "2026-08-20T00:00:00.000Z" }),
    ],
  });

  assert.deepEqual(recent.map((entry) => entry.session.id), ["pinned", "plain"]);
});

test("pinned rows ride along without taking a slot in recent", () => {
  // Otherwise a few pinned conversations - which are usually the ones being
  // worked in, so the newest - fill the whole section with a second copy of the
  // pinned block above it.
  const one = project("one");
  const entries = collectRecentSessions([one], {
    [one.path]: [
      session({ id: "pin-a", pinned: true, updatedAt: "2026-08-28T00:00:00.000Z" }),
      session({ id: "pin-b", pinned: true, updatedAt: "2026-08-27T00:00:00.000Z" }),
      ...Array.from({ length: 6 }, (_, index) => session({
        id: `plain-${index}`,
        updatedAt: new Date(Date.UTC(2026, 7, 20 - index)).toISOString(),
      })),
    ],
  });
  const view = visibleRecentSessions(entries, DEFAULT_RECENT_ROWS);

  assert.deepEqual(view.rows.map((entry) => entry.session.id), [
    "pin-a", "pin-b", "plain-0", "plain-1", "plain-2", "plain-3",
  ]);
  // Only the unpinned leftovers are worth a "more" press.
  assert.equal(view.hiddenCount, 2);
});

test("recent stops at the last unpinned row that fits", () => {
  // A pinned conversation further down the ordering must not trail in behind the
  // cut - it is one glance away in the pinned section above.
  const one = project("one");
  const entries = collectRecentSessions([one], {
    [one.path]: [
      session({ id: "plain-new", updatedAt: "2026-08-28T00:00:00.000Z" }),
      session({ id: "plain-old", updatedAt: "2026-08-27T00:00:00.000Z" }),
      session({ id: "pin-old", pinned: true, updatedAt: "2026-08-26T00:00:00.000Z" }),
    ],
  });
  const view = visibleRecentSessions(entries, 1);

  assert.deepEqual(view.rows.map((entry) => entry.session.id), ["plain-new"]);
  assert.equal(view.hiddenCount, 1);
});

test("expanding recent eventually shows every unpinned conversation", () => {
  const one = project("one");
  const entries = collectRecentSessions([one], {
    [one.path]: [
      session({ id: "pin", pinned: true, updatedAt: "2026-08-28T00:00:00.000Z" }),
      ...Array.from({ length: 5 }, (_, index) => session({
        id: `plain-${index}`,
        updatedAt: new Date(Date.UTC(2026, 7, 20 - index)).toISOString(),
      })),
    ],
  });
  const view = visibleRecentSessions(entries, 99);

  assert.equal(view.hiddenCount, 0);
  assert.equal(view.rows.length, 6);
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
