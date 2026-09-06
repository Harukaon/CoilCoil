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

test("a large window keeps a quarter of itself verbatim instead of a fixed 20k", () => {
  const settings = compactionSettingsForWindow(PI_DEFAULTS, 200_000);
  assert.equal(settings.keepRecentTokens, 50_000);
  assert.equal(settings.reserveTokens, PI_DEFAULTS.reserveTokens);
});

test("a small window still leaves a history worth summarizing", () => {
  // Pi's default would keep 20000 of a 15616-token budget, so its cut point
  // walks past the whole conversation and compaction silently does nothing.
  const settings = compactionSettingsForWindow(PI_DEFAULTS, 32_000);
  assert.ok(settings.keepRecentTokens < 32_000 - PI_DEFAULTS.reserveTokens);
  assert.equal(settings.keepRecentTokens, 7_808);
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

test("every Pi caller sees the window-aware budget", () => {
  const manager = fakeSettingsManager();
  installCompactionSettings(manager, () => 200_000);
  assert.equal(manager.getCompactionSettings().keepRecentTokens, 50_000);
});

test("the window is read at each call, so switching models is followed", () => {
  const manager = fakeSettingsManager();
  let contextWindow = 200_000;
  installCompactionSettings(manager, () => contextWindow);
  assert.equal(manager.getCompactionSettings().keepRecentTokens, 50_000);
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
