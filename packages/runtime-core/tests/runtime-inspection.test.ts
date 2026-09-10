import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeSummaryEvent } from "@coilcoil/runtime-protocol";
import { summarizeCacheUsage } from "@coilcoil/runtime-protocol";
import { buildRuntimeInspection } from "../src/runtime-inspection.js";

test("projects persisted Pi summaries and follows the active session branch", () => {
  const manager = SessionManager.inMemory("/tmp/coilcoil-runtime-inspection");
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
    // 保留点是一条自定义条目，聊天界面里根本不画它——所以这里给出去的是「切分点
    // 之后第一条真正显示的消息」，这条会话里没有，就是 undefined。
    firstKeptEntryId: undefined,
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
  const manager = SessionManager.inMemory("/tmp/coilcoil-runtime-inspection-live");
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

test("latest request cache rate is not diluted by earlier cache-building requests", () => {
  const first = summarizeCacheUsage(12_000, 0, 10_000);
  const latest = summarizeCacheUsage(1_000, 11_000, 0);

  // Lifetime aggregation is useful for billing, but it would report 32.4%
  // here and hide that the current request reused almost all of its prompt.
  const lifetime = summarizeCacheUsage(13_000, 11_000, 10_000);
  assert.equal(first.hitRate, 0);
  assert.equal(latest.hitRate, 11 / 12);
  assert.ok((lifetime.hitRate ?? 0) < 0.4);
});

test("保留点落在不显示的条目上时，交给界面的是切分点之后第一条真正的消息", () => {
  // 压缩留下的 firstKeptEntryId 常常是一条响应指标之类的元数据，聊天界面找不到它，
  // 于是那条横线退回按时间画——画在整段对话的最后，却写着「这条线以上都被折叠
  // 了」。而保留下来的最近几万 token 原文，恰恰就在那条线的上面。
  const manager = SessionManager.inMemory("/tmp/coilcoil-runtime-inspection-cut");
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "老的" }], timestamp: 1 } as never);
  const metadata = manager.appendCustomEntry("coilcoil-response-metrics", { value: 1 });
  const keptMessage = manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "留下的" }], timestamp: 2,
  } as never);
  manager.appendCompaction("摘要", metadata, 12_000, {});

  const inspection = buildRuntimeInspection(manager, 1);
  const compaction = inspection.summaryEvents.find((event) => event.kind === "compaction");
  assert.equal(compaction?.firstKeptEntryId, keptMessage, "指向的必须是界面画得出来的那条消息");
});
