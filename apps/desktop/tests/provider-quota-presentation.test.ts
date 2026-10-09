import assert from "node:assert/strict";
import test from "node:test";
import { quotaPercent, quotaPlanLabel, quotaResetLabel } from "../src/renderer/src/features/settings/providerQuotaPresentation.js";

test("quota usage distinguishes genuine zero from missing data and rounds to one decimal", () => {
  assert.equal(quotaPercent(0), "0%");
  assert.equal(quotaPercent(74.05), "74%" /* IEEE rounding is intentional */);
  assert.equal(quotaPercent(74.16), "74.2%");
  assert.equal(quotaPercent(null), "服务商未提供");
  assert.equal(quotaPercent(NaN), "服务商未提供");
});

test("reset labels show durations and local dates without claiming old usage is already reset", () => {
  const now = Date.UTC(2026, 9, 9, 20);
  assert.match(quotaResetLabel(now + 10 * 60_000, now), /^10 分钟后重置/);
  assert.match(quotaResetLabel(now + 65 * 60_000, now), /^1 小时 5 分钟后重置/);
  assert.match(quotaResetLabel(now + 49 * 3600_000, now), /^2 天 1 小时后重置/);
  assert.equal(quotaResetLabel(now - 1, now), "已到重置时间，请刷新查看");
  assert.equal(quotaResetLabel(null, now), "服务商未提供重置时间");
  assert.equal(quotaResetLabel(Infinity, now), "服务商未提供重置时间");
});

test("subscription plan names use the account's actual plan", () => {
  assert.equal(quotaPlanLabel("team"), "Team");
  assert.equal(quotaPlanLabel("plus"), "Plus");
  assert.equal(quotaPlanLabel(undefined), undefined);
});
