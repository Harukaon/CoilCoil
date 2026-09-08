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

test("一个正常大小的窗口，Pi 自己的 20k 原样保留", () => {
  // 20k 本身没问题，这里只负责不让它把压缩变成空转，不负责替用户调大。
  for (const window of [200_000, 128_000, 64_000]) {
    const settings = compactionSettingsForWindow(PI_DEFAULTS, window);
    assert.equal(settings.keepRecentTokens, 20_000, `${window} 的窗口被改动了`);
    assert.equal(settings, PI_DEFAULTS, "没有变化时应当原样返回");
  }
});

test("窗口小到会让压缩空转时，保留量被压下来", () => {
  // Pi 的默认值要在 15616 的预算里保留 20000，切点会走过整段对话，
  // 压缩每一轮都静悄悄什么也不做，直到请求溢出。
  const settings = compactionSettingsForWindow(PI_DEFAULTS, 32_000);
  assert.ok(settings.keepRecentTokens < 32_000 - PI_DEFAULTS.reserveTokens);
  assert.equal(settings.keepRecentTokens, 7_808);
});

test("只会往下压，永远不会替用户调大", () => {
  const small = compactionSettingsForWindow({ ...PI_DEFAULTS, keepRecentTokens: 4_000 }, 200_000);
  assert.equal(small.keepRecentTokens, 4_000);
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
    getCompactionSettings: () => ({ ...PI_DEFAULTS }),
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
  const manager = fakeSettingsManager({ compaction: { keepRecentTokens: 20_000 } });
  installCompactionSettings(manager, () => 200_000);
  assert.equal(manager.getCompactionSettings().keepRecentTokens, 20_000);
});

test("installing twice does not stack wrappers", () => {
  const manager = fakeSettingsManager();
  installCompactionSettings(manager, () => 200_000);
  const wrapped = manager.getCompactionSettings;
  installCompactionSettings(manager, () => 400_000);
  assert.equal(manager.getCompactionSettings, wrapped);
});
