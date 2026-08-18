import assert from "node:assert/strict";
import test from "node:test";
import { splitInlineThinking } from "../src/inline-thinking.js";

test("ordinary replies are returned untouched", () => {
  const text = "已经删掉了工单入口和占位页。";
  assert.deepEqual(splitInlineThinking(text), { text, thinking: "" });
});

test("text containing unrelated angle brackets is untouched", () => {
  const text = "用 `a < b` 判断，并把 <div> 渲染出来。";
  assert.deepEqual(splitInlineThinking(text), { text, thinking: "" });
});

test("an inlined reasoning block moves into the thinking channel", () => {
  const result = splitInlineThinking("<thinking>Preparing delete action with updated snapshot</thinking>已删除。");
  assert.equal(result.text, "已删除。");
  assert.equal(result.thinking, "Preparing delete action with updated snapshot");
});

test("several blocks are collected in order and joined", () => {
  const result = splitInlineThinking(
    "<thinking>first</thinking>正文一\n\n<thinking>second</thinking>正文二",
  );
  assert.equal(result.text, "正文一\n\n正文二");
  assert.equal(result.thinking, "first\n\nsecond");
});

test("extracted reasoning is appended after real thinking blocks", () => {
  const result = splitInlineThinking("<think>leaked</think>回复", "真正的思考");
  assert.equal(result.text, "回复");
  assert.equal(result.thinking, "真正的思考\n\nleaked");
});

test("an unterminated tag does not leave half a tag in the reply", () => {
  // The turn was cut off, or the closing tag has not streamed in yet.
  const result = splitInlineThinking("正文\n<thinking>still going");
  assert.equal(result.text, "正文");
  assert.equal(result.thinking, "still going");
});

test("the alternate spellings providers use are handled", () => {
  for (const tag of ["thinking", "thought", "think"]) {
    const result = splitInlineThinking(`<${tag}>reasoning</${tag}>回复`);
    assert.equal(result.text, "回复", tag);
    assert.equal(result.thinking, "reasoning", tag);
  }
});

test("a reply that is nothing but reasoning leaves empty text", () => {
  const result = splitInlineThinking("<thinking>only reasoning</thinking>");
  assert.equal(result.text, "");
  assert.equal(result.thinking, "only reasoning");
});
