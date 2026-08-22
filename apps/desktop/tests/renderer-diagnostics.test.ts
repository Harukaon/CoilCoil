import assert from "node:assert/strict";
import test from "node:test";
import type { DiagnosticLogBatch, DiagnosticLogEntry } from "@coilcoil/runtime-protocol";

const sent: DiagnosticLogEntry[][] = [];

// The module talks to the preload bridge on import-time `window`, so the stub
// has to be in place before it loads.
(globalThis as unknown as { window: unknown }).window = {
  coilcoil: {
    writeDiagnostics: (batch: DiagnosticLogBatch) => { sent.push(batch.entries); },
  },
  addEventListener: () => undefined,
};

const { diagnostics } = await import("../src/renderer/src/diagnostics.ts");

test("普通日志先攒着，不是每条一次 IPC", () => {
  sent.length = 0;
  diagnostics.info("run-state", "a");
  diagnostics.info("run-state", "b");
  assert.equal(sent.length, 0, "攒批期间不应该发出去");
  diagnostics.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map((entry) => entry.event), ["a", "b"]);
});

test("错误立刻送出，因为紧接着的崩溃会让定时器永远不再触发", () => {
  sent.length = 0;
  diagnostics.info("run-state", "before");
  diagnostics.error("window", "uncaught_error", new Error("炸了"));
  assert.equal(sent.length, 1, "错误应该带着之前攒的一起立刻发出");
  assert.deepEqual(sent[0].map((entry) => entry.event), ["before", "uncaught_error"]);
  assert.equal(sent[0][1].error?.message, "炸了");
  assert.match(sent[0][1].error?.stack ?? "", /Error: 炸了/);
});

test("条目标明来自渲染进程并带时间戳", () => {
  sent.length = 0;
  diagnostics.warn("react", "slow_render", { ms: 120 });
  diagnostics.flush();
  const [entry] = sent[0];
  assert.equal(entry.process, "renderer");
  assert.equal(entry.level, "warn");
  assert.deepEqual(entry.data, { ms: 120 });
  assert.equal(typeof entry.ts, "number");
});

test("flush 在没有内容时不会发空批次", () => {
  sent.length = 0;
  diagnostics.flush();
  diagnostics.flush();
  assert.equal(sent.length, 0);
});

test("桥不可用时静默丢弃，不把渲染进程也拖垮", () => {
  sent.length = 0;
  const bridge = (globalThis as unknown as { window: { coilcoil: unknown } }).window.coilcoil;
  (globalThis as unknown as { window: { coilcoil: unknown } }).window.coilcoil = undefined;
  diagnostics.info("teardown", "after_bridge_gone");
  assert.doesNotThrow(() => diagnostics.flush());
  (globalThis as unknown as { window: { coilcoil: unknown } }).window.coilcoil = bridge;
});
