import assert from "node:assert/strict";
import test from "node:test";
import { memoryMaxChars } from "../src/renderer/src/features/memory/memoryState.ts";

test("正在编辑的上限立刻生效，不用等保存", () => {
  // 编辑框旁边那个数字必须跟着上面刚输入的上限走，而不是文件读进来时的那个。
  const settings = {
    globalEnabled: true,
    projectEnabled: true,
    autoSummarize: true,
    globalMaxChars: 3_000,
    projectMaxChars: 2_000,
    generationRules: "",
  };
  const staleDocument = { maxChars: 1_000 } as never;
  assert.equal(memoryMaxChars("project", settings, staleDocument), 2_000);
  assert.equal(memoryMaxChars("global", settings, staleDocument), 3_000);
});

test("设置还没加载出来时，退回文件自己记录的上限", () => {
  assert.equal(memoryMaxChars("project", undefined, { maxChars: 1_000 } as never), 1_000);
  assert.equal(memoryMaxChars("project", undefined, undefined), 0);
});
