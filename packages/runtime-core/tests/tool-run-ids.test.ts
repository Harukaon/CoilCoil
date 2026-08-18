import assert from "node:assert/strict";
import test from "node:test";
import { ToolRunIds, toolRunId } from "../src/tool-run-ids.js";

test("a provider with unique tool call ids is left completely alone", () => {
  const ids = new ToolRunIds();
  const first = "call_TY95fVcyWUbIvBfqpqvVi7yT|fc_0902146eed653be8016a835ff52d";
  const second = "call_9kQz2pLmN4RtVwXy|fc_0902146eed653be8016a835ff52e";

  assert.equal(ids.begin(first), first);
  assert.equal(ids.end(first), first);
  assert.equal(ids.begin(second), second);
  assert.equal(ids.end(second), second);
});

test("ids that restart each turn get separate runs instead of overwriting", () => {
  // OpenAI-compatible chat completions endpoints number calls per response, so
  // every turn's first tool call arrives as call_0.
  const ids = new ToolRunIds();
  const runs: string[] = [];
  for (let turn = 0; turn < 3; turn += 1) {
    runs.push(ids.begin("call_0"));
    ids.end("call_0");
  }
  assert.deepEqual(runs, ["call_0", "call_0#2", "call_0#3"]);
  assert.equal(new Set(runs).size, 3);
});

test("parallel calls in one turn keep their own runs", () => {
  const ids = new ToolRunIds();
  assert.equal(ids.begin("call_0"), "call_0");
  assert.equal(ids.begin("call_1"), "call_1");
  assert.equal(ids.end("call_1"), "call_1");
  assert.equal(ids.end("call_0"), "call_0");
  // The next turn restarts the numbering; neither may reuse a finished run.
  assert.equal(ids.begin("call_0"), "call_0#2");
  assert.equal(ids.begin("call_1"), "call_1#2");
});

test("begin is idempotent because a call is projected twice", () => {
  // Once from the assistant message that contains it, once from
  // tool_execution_start. Those must land on one run, not two cards.
  const ids = new ToolRunIds();
  assert.equal(ids.begin("call_0"), "call_0");
  assert.equal(ids.begin("call_0"), "call_0");
  assert.equal(ids.current("call_0"), "call_0");
  assert.equal(ids.end("call_0"), "call_0");
});

test("current opens a run for a result whose start was never seen", () => {
  const ids = new ToolRunIds();
  assert.equal(ids.current("call_7"), "call_7");
  assert.equal(ids.end("call_7"), "call_7");
  assert.equal(ids.begin("call_7"), "call_7#2");
});

test("toolRunId only suffixes repeats", () => {
  assert.equal(toolRunId("call_0", 1), "call_0");
  assert.equal(toolRunId("call_0", 2), "call_0#2");
});
