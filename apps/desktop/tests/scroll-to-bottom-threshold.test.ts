import assert from "node:assert/strict";
import test from "node:test";
import {
  SCROLL_DOWN_HIDE_DISTANCE,
  SCROLL_DOWN_SHOW_DISTANCE,
  nextScrollDownVisible,
} from "../src/renderer/src/features/conversation/scrollDownVisibility.ts";

test("往上滚一点点不显示箭头", () => {
  assert.equal(nextScrollDownVisible(false, 0), false);
  assert.equal(nextScrollDownVisible(false, 48), false);
  assert.equal(nextScrollDownVisible(false, SCROLL_DOWN_SHOW_DISTANCE), false);
});

test("往上滚过一屏才显示", () => {
  assert.equal(nextScrollDownVisible(false, SCROLL_DOWN_SHOW_DISTANCE + 1), true);
  assert.equal(nextScrollDownVisible(false, 2_000), true);
});

test("显示之后要滚回得更近才收起", () => {
  // 迟滞：显示线和隐藏线之间那一段，已经显示的箭头会继续留着。
  assert.ok(SCROLL_DOWN_HIDE_DISTANCE < SCROLL_DOWN_SHOW_DISTANCE);
  assert.equal(nextScrollDownVisible(true, SCROLL_DOWN_SHOW_DISTANCE), true);
  assert.equal(nextScrollDownVisible(true, SCROLL_DOWN_HIDE_DISTANCE + 1), true);
  assert.equal(nextScrollDownVisible(true, SCROLL_DOWN_HIDE_DISTANCE), false);
  assert.equal(nextScrollDownVisible(true, 0), false);
});

test("停在显示线上反复抖动，箭头不会闪", () => {
  // 一条线的时候，距离在临界点两侧来回穿就会开关开关；两条线之后，越过显示线
  // 一次就稳定亮着，除非真的滚回到隐藏线以内。
  let visible = false;
  for (const distance of [SCROLL_DOWN_SHOW_DISTANCE + 2, SCROLL_DOWN_SHOW_DISTANCE - 2, SCROLL_DOWN_SHOW_DISTANCE + 1, SCROLL_DOWN_SHOW_DISTANCE - 1]) {
    visible = nextScrollDownVisible(visible, distance);
    assert.equal(visible, true);
  }
  visible = nextScrollDownVisible(visible, SCROLL_DOWN_HIDE_DISTANCE - 1);
  assert.equal(visible, false);
  // 收起之后，再往上飘一点也不会立刻又跳出来。
  assert.equal(nextScrollDownVisible(visible, SCROLL_DOWN_HIDE_DISTANCE + 10), false);
});
