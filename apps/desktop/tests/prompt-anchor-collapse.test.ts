import assert from "node:assert/strict";
import test from "node:test";
import { ANCHOR_EXCERPT_LIMIT, excerpt } from "../src/renderer/src/features/conversation/promptAnchors.ts";

test("panel rows show the first line, trimmed", () => {
  assert.equal(excerpt("研究一下 Minimax 生图技巧"), "研究一下 Minimax 生图技巧");
  assert.equal(excerpt("第一行\n第二行\n第三行"), "第一行");
  assert.equal(excerpt("  \n  带前导空白  \n"), "带前导空白");
  assert.equal(excerpt("x".repeat(80)), `${"x".repeat(ANCHOR_EXCERPT_LIMIT)}…`);
  assert.equal(excerpt("x".repeat(80), 10), `${"x".repeat(10)}…`);
});

test("a row exactly at the limit keeps its ellipsis off", () => {
  const exact = "x".repeat(ANCHOR_EXCERPT_LIMIT);
  assert.equal(excerpt(exact), exact);
  assert.equal(excerpt(`${exact}y`), `${exact}…`);
});

test("an image-only prompt still gets a readable row", () => {
  assert.equal(excerpt(""), "（仅图片）");
  assert.equal(excerpt("   \n  "), "（仅图片）");
});
