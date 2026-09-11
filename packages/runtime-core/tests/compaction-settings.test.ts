import assert from "node:assert/strict";
import test from "node:test";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  type CompactionSettings,
  compactionSettingsForWindow,
  installCompactionSettings,
} from "../src/compaction-settings.js";

const PI_DEFAULTS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

test("窗口够大时就用 pi 自己的 2 万，我们不再往上加", () => {
  // 这里曾经改成 5 万，结果是一条真实会话每二十分钟压缩一次。pi 这个预算是按
  // 「字符数 / 4」算的，中文一个字就是一个 token，「留 5 万」实际留下了 12.6 万；
  // 再加上 1.1 万的固定提示词和 2 万的摘要，一次压缩之后 20 万的窗口只剩 2.6 万，
  // 下一次压缩就在几分钟之后。单位本身会骗人，所以别去乘这个谎。
  for (const window of [200_000, 128_000, 64_000]) {
    assert.equal(compactionSettingsForWindow(PI_DEFAULTS, window), PI_DEFAULTS, `${window} 的窗口不该被改`);
  }
});

test("窗口小到会让压缩空转时，保留量被压下来", () => {
  // Pi 的默认值要在 15616 的预算里保留 20000，切点会走过整段对话，
  // 压缩每一轮都静悄悄什么也不做，直到请求溢出。
  const settings = compactionSettingsForWindow(PI_DEFAULTS, 32_000);
  assert.ok(settings.keepRecentTokens < 32_000 - PI_DEFAULTS.reserveTokens);
  assert.equal(settings.keepRecentTokens, 7_808);
});

test("往下压是唯一会动的方向，绝不会往上加", () => {
  // 用户把某个模型的窗口设小的时候才会碰到这条：能压缩的那一半装不下 2 万。
  for (const window of [48_000, 40_000, 32_000]) {
    const settings = compactionSettingsForWindow(PI_DEFAULTS, window);
    const half = Math.floor((window - PI_DEFAULTS.reserveTokens) / 2);
    assert.equal(settings.keepRecentTokens, half, `${window} 没压到能压缩的一半`);
    assert.ok(settings.keepRecentTokens < PI_DEFAULTS.keepRecentTokens);
  }
});

test("an unknown window changes nothing", () => {
  assert.equal(compactionSettingsForWindow(PI_DEFAULTS, undefined), PI_DEFAULTS);
  assert.equal(compactionSettingsForWindow(PI_DEFAULTS, 0), PI_DEFAULTS);
  assert.equal(compactionSettingsForWindow(PI_DEFAULTS, 8_000), PI_DEFAULTS);
});

function fakeSettingsManager(
  scopes: { compaction?: { keepRecentTokens?: number } } = {},
): SettingsManager {
  return {
    getCompactionSettings: () => ({ ...PI_DEFAULTS, ...(scopes.compaction ?? {}) }),
    getGlobalSettings: () => scopes,
    getProjectSettings: () => ({}),
  } as unknown as SettingsManager;
}

test("every Pi caller sees the clamped budget", () => {
  const manager = fakeSettingsManager();
  installCompactionSettings(manager, () => 32_000);
  assert.equal(manager.getCompactionSettings().keepRecentTokens, 7_808);
});

test("the window is read at each call, so switching models is followed", () => {
  const manager = fakeSettingsManager();
  let contextWindow = 200_000;
  installCompactionSettings(manager, () => contextWindow);
  assert.equal(manager.getCompactionSettings().keepRecentTokens, 20_000);
  contextWindow = 32_000;
  assert.equal(manager.getCompactionSettings().keepRecentTokens, 7_808);
});

test("an explicitly configured budget is left alone", () => {
  // 连那条「压到能压缩的一半」的保险都不上：自己填的数字，就照自己填的来。
  const manager = fakeSettingsManager({ compaction: { keepRecentTokens: 30_000 } });
  installCompactionSettings(manager, () => 32_000);
  assert.equal(manager.getCompactionSettings().keepRecentTokens, 30_000);
});

test("installing twice does not stack wrappers", () => {
  const manager = fakeSettingsManager();
  installCompactionSettings(manager, () => 200_000);
  const wrapped = manager.getCompactionSettings;
  installCompactionSettings(manager, () => 400_000);
  assert.equal(manager.getCompactionSettings, wrapped);
});
