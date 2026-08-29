import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readStoredWindowOpacity,
  resolveWindowOpacity,
  WINDOW_OPACITY_MAX,
  WINDOW_OPACITY_MIN,
  writeStoredWindowOpacity,
} from "../src/main/window-opacity";

/*
 * 整窗透明度。这里盯的不是「好不好看」，而是三件会把窗口弄丢的事：
 * 值不能透到看不见、坏文件不能让启动失败、写不进磁盘不能把设置界面搞崩。
 */

const scratch = (): string => join(mkdtempSync(join(tmpdir(), "coilcoil-opacity-")), "window.json");

test("透明度收敛在可用范围内，最低也还看得见", () => {
  assert.equal(resolveWindowOpacity(0.9), 0.9);
  // 0 会让窗口彻底消失，而且没有界面能再把它调回来。
  assert.equal(resolveWindowOpacity(0), WINDOW_OPACITY_MIN);
  assert.equal(resolveWindowOpacity(-4), WINDOW_OPACITY_MIN);
  assert.equal(resolveWindowOpacity(2), WINDOW_OPACITY_MAX);
  assert.ok(WINDOW_OPACITY_MIN >= 0.7, "下限再低正文就发虚了");
});

test("读不懂的值一律当作不透明", () => {
  for (const value of [undefined, null, "0.5", Number.NaN, {}, []]) {
    assert.equal(resolveWindowOpacity(value), WINDOW_OPACITY_MAX);
  }
});

test("存档缺失或损坏时按不透明启动，而不是让启动失败", () => {
  assert.equal(readStoredWindowOpacity(join(tmpdir(), "coilcoil-not-here", "window.json")), WINDOW_OPACITY_MAX);
  const broken = scratch();
  writeFileSync(broken, "{ 这不是 JSON", "utf8");
  assert.equal(readStoredWindowOpacity(broken), WINDOW_OPACITY_MAX);
  const wrongShape = scratch();
  writeFileSync(wrongShape, JSON.stringify({ opacity: "很透" }), "utf8");
  assert.equal(readStoredWindowOpacity(wrongShape), WINDOW_OPACITY_MAX);
});

test("写进去的值下次启动读得回来，并且返回真正生效的那个值", () => {
  const file = scratch();
  assert.equal(writeStoredWindowOpacity(file, 0.88), 0.88);
  assert.equal(readStoredWindowOpacity(file), 0.88);
  // 越界的输入落盘前就被收敛，存档里不会留下一个能把窗口弄没的值。
  assert.equal(writeStoredWindowOpacity(file, 0.1), WINDOW_OPACITY_MIN);
  assert.equal(readStoredWindowOpacity(file), WINDOW_OPACITY_MIN);
});

test("磁盘写不进去也不抛，本次仍然按收敛后的值生效", () => {
  // 目录不存在 → writeFileSync 必然失败；调用方只关心返回值。
  const unwritable = join(tmpdir(), "coilcoil-no-such-dir", "window.json");
  assert.equal(writeStoredWindowOpacity(unwritable, 0.92), 0.92);
});
