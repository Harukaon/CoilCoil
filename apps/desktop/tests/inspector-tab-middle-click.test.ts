import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  isMiddleClickClose,
  MIDDLE_MOUSE_BUTTON,
} from "../src/renderer/src/features/inspector/inspectorTabs.ts";

const pane = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/features/inspector/InspectorPane.tsx"),
  "utf8",
);

test("只有中键、且这个标签能关，才算一次关闭", () => {
  assert.equal(isMiddleClickClose(MIDDLE_MOUSE_BUTTON, true), true);
  // 左键（0）和右键（2）不能顺手把标签关掉——右键还要留给上下文菜单。
  assert.equal(isMiddleClickClose(0, true), false);
  assert.equal(isMiddleClickClose(2, true), false);
  // 不能关的标签中键也不关。
  assert.equal(isMiddleClickClose(MIDDLE_MOUSE_BUTTON, false), false);
  assert.equal(isMiddleClickClose(MIDDLE_MOUSE_BUTTON, undefined), false);
});

test("标签整块都接中键，并且把浏览器默认的中键行为拦掉", () => {
  // 中键落在标签上的任何位置都要关，所以监听挂在整条标签而不是里面的按钮上。
  assert.match(pane, /className=\{`inspector-tab /);
  assert.match(pane, /onAuxClick=\{\(event\) => \{/);
  // 不拦 mousedown 的话 Chromium 会先起自动滚动（Linux 上还有中键粘贴），
  // 光标变成滚动指针，后面的 auxclick 就不一定还落在这个标签上。
  assert.match(pane, /onMouseDown=\{\(event\) => \{ if \(event\.button === MIDDLE_MOUSE_BUTTON\) event\.preventDefault\(\); \}\}/);
  assert.match(pane, /event\.preventDefault\(\);\s*\n\s*onCloseTab\(item\.id\);/);
});
