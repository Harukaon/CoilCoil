import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeSummaryEvent } from "@suocode/runtime-protocol";
import { buildRuntimeInspection } from "../src/runtime-inspection.js";

test("projects persisted Pi summaries and follows the active session branch", () => {
  const manager = SessionManager.inMemory("/tmp/suocode-runtime-inspection");
  const rootId = manager.appendCustomEntry("test-root", { value: true });
  const compactionId = manager.appendCompaction(
    "kept the important context",
    rootId,
    12_000,
    { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
  );

  const original = buildRuntimeInspection(manager, 1);
  assert.equal(original.activeLeafId, compactionId);
  assert.equal(original.summaryEvents.length, 1);
  assert.deepEqual(original.summaryEvents[0], {
    id: compactionId,
    kind: "compaction",
    status: "succeeded",
    timestamp: original.summaryEvents[0]?.timestamp,
    active: true,
    summary: "kept the important context",
    tokensBefore: 12_000,
    firstKeptEntryId: rootId,
    usage: undefined,
    readFiles: ["src/a.ts"],
    modifiedFiles: ["src/b.ts"],
  });

  const branchSummaryId = manager.branchWithSummary(
    rootId,
    "continued from an earlier prompt",
    { modifiedFiles: ["src/c.ts"] },
  );
  const rewound = buildRuntimeInspection(manager, 2);
  assert.equal(rewound.activeLeafId, branchSummaryId);
  assert.equal(rewound.summaryEvents.find((event) => event.id === compactionId)?.active, false);
  assert.equal(rewound.summaryEvents.find((event) => event.id === branchSummaryId)?.active, true);
});

test("merges a live compaction into the inspection snapshot", () => {
  const manager = SessionManager.inMemory("/tmp/suocode-runtime-inspection-live");
  const live: RuntimeSummaryEvent = {
    id: "live-compaction",
    kind: "compaction",
    status: "running",
    timestamp: Date.now(),
    active: true,
    reason: "threshold",
    retryAttempt: 2,
    retryMaxAttempts: 3,
  };

  const inspection = buildRuntimeInspection(manager, 4, live);
  assert.equal(inspection.sessionRevision, 4);
  assert.deepEqual(inspection.summaryEvents, [live]);
});
