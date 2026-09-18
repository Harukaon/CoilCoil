import assert from "node:assert/strict";
import test from "node:test";
import {
  type DragRegion,
  isDragPressLeak,
  regionAt,
} from "../src/renderer/src/ui/window-drag-report.ts";

function region(element: string, draggable: boolean, left: number, top: number, width: number, height: number): DragRegion {
  return { element, draggable, left, top, right: left + width, bottom: top + height };
}

test("最后一个盖住这一点的矩形说了算", () => {
  // Electron 按顺序做并集/差集，对单点来说就等于「最后一个盖住它的赢」。排在前面的
  // no-drag 挖不动后面的 drag——这正是拖动层必须是第一个子节点的原因。
  const layer = region("span.window-drag-layer", true, 0, 0, 600, 56);
  const button = region("button.icon-button", false, 500, 12, 30, 30);
  const regions = [layer, button];

  assert.equal(regionAt(regions, 200, 28)?.element, "span.window-drag-layer");
  assert.equal(regionAt(regions, 510, 28)?.element, "button.icon-button");
  assert.equal(regionAt(regions, 200, 80), undefined, "标题栏以外不归任何矩形");

  // 顺序反过来，按钮那块就被拖动层重新盖回去了。
  assert.equal(regionAt([button, layer], 510, 28)?.element, "span.window-drag-layer");
});

test("只有左键、没按 Ctrl、且落在可拖矩形上，才算一次失效", () => {
  const draggable = region("span.window-drag-layer", true, 0, 0, 600, 56);
  const blocked = region("button.icon-button", false, 0, 0, 30, 30);

  assert.equal(isDragPressLeak(0, false, draggable), true);
  // 按在按钮上本来就该由网页收到。
  assert.equal(isDragPressLeak(0, false, blocked), false);
  assert.equal(isDragPressLeak(0, false, undefined), false);
  // 右键和 Ctrl+左键期间 Electron 自己会整个关掉拖动区，好让右键菜单弹得出来，
  // 那一下落到网页上是正常的，不能记成失效。
  assert.equal(isDragPressLeak(2, false, draggable), false);
  assert.equal(isDragPressLeak(0, true, draggable), false);
});
