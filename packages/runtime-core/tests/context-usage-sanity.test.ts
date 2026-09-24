import assert from "node:assert/strict";
import test from "node:test";
import type { ContextUsage } from "@coilcoil/runtime-protocol";
import { believableContextUsage, contextUsageAfterClearing } from "../src/session-values.js";

const usage = (tokens: number | null, contextWindow = 200_000): ContextUsage => ({
  tokens,
  contextWindow,
  percent: tokens === null ? null : (tokens / contextWindow) * 100,
});

test("服务商算错的读数当作「不知道」，不往界面上放", () => {
  // 真实一次：网关在重试里把缓存读取重复计了，200,000 的窗口报回来
  // cacheRead: 433,326。pi 把 input + cacheRead + cacheWrite 当成上下文大小，
  // 界面上就成了「434k / 200k」——一个不可能存在的数。
  const nonsense = believableContextUsage(usage(434_215));
  assert.equal(nonsense?.tokens, null, "宁可显示不知道，也不显示一个假的数");
  assert.equal(nonsense?.percent, null);
  assert.equal(nonsense?.contextWindow, 200_000, "窗口本身还是知道的");
});

test("正常超窗要照常看得见，那正是需要被看见的时候", () => {
  // 超出窗口一点是真事——溢出就是这么发生的：一个被接受的请求，加上它之后补上的
  // 东西。这种数不能抹掉，抹掉就等于把警报关了。
  for (const tokens of [180_000, 200_000, 210_000, 260_000, 300_000]) {
    assert.equal(believableContextUsage(usage(tokens))?.tokens, tokens, `${tokens} 该原样留着`);
  }
});

test("读数不知道、窗口不知道的时候，原样传过去", () => {
  assert.equal(believableContextUsage(undefined), undefined);
  assert.equal(believableContextUsage(usage(null))?.tokens, null);
  assert.equal(believableContextUsage(usage(999_999, 0))?.tokens, 999_999, "窗口都不知道，就没有判断的依据");
});

test("清理后的请求显示新估算值，新回复抵达后恢复提供商用量", () => {
  const stale = usage(562_000, 500_000);
  const clearing = { at: 100, clearedResults: 772, freedTokens: 364_860, projectedTokens: 172_000, contextWindow: 500_000 };
  assert.deepEqual(contextUsageAfterClearing(stale, clearing, 99), { ...usage(172_000, 500_000), estimated: true });
  assert.deepEqual(contextUsageAfterClearing(stale, clearing, 100), stale);
  assert.deepEqual(contextUsageAfterClearing(stale, clearing, 101), stale);
  assert.deepEqual(contextUsageAfterClearing(stale, { ...clearing, contextWindow: 200_000 }, 99), stale);
});
