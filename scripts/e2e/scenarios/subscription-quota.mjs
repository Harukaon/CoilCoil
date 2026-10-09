import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRemoteClient } from "../harness.mjs";

export const description = "订阅额度：真实桌面和网页版读取两家账号的五小时/周用量，刷新、失败恢复和退出登录";
const fixturesRoot = mkdtempSync(join(tmpdir(), "coil-quota-fixture-"));
const fixture = join(fixturesRoot, "usage.json");
process.once("exit", () => rmSync(fixturesRoot, { recursive: true, force: true }));
const reset = Date.now() + 4 * 3600_000;
const body = {
  anthropic: { status: 200, payload: {
    five_hour: { utilization: 0, resets_at: new Date(reset).toISOString() },
    seven_day: { utilization: 74, resets_at: new Date(reset + 3 * 86400_000).toISOString() },
  } },
  "openai-codex": { status: 200, payload: { plan_type: "team", rate_limit: {
    primary_window: { used_percent: 51, limit_window_seconds: 604800, reset_at: Math.floor((reset + 3 * 86400_000) / 1000) },
    secondary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: Math.floor(reset / 1000) },
  } } },
};
const update = () => writeFileSync(fixture, JSON.stringify(body));
update();
const codexToken = `quota-e2e.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-e2e" } })).toString("base64url")}.signature`;
export const launchOptions = {
  remote: true,
  credentials: {
    anthropic: { type: "oauth", access: "quota-e2e-anthropic", refresh: "fake-anthropic-refresh", expires: Date.now() + 86400_000 },
    "openai-codex": { type: "oauth", access: codexToken, refresh: "fake-codex-refresh", expires: Date.now() + 86400_000, accountId: "account-e2e" },
  },
  env: { COILCOIL_E2E_QUOTA_FIXTURE: fixture },
  runtimeNodeOptions: `--require ${JSON.stringify(join(import.meta.dirname, "../subscription-quota-fetch.cjs"))}`,
};

async function selectProvider(page, name) {
  await page.locator(".provider-catalog").getByRole("button", { name: new RegExp(`^${name}\\b`) }).first().click();
}
async function openSettings(page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置栏目" }).getByRole("button", { name: "模型与服务商", exact: true }).click();
}

export async function run({ app, page, root, remotePort, check, shot }) {
  const authPath = join(root, "data/agent/auth.json");
  const originalAuth = readFileSync(authPath, "utf8");
  await openSettings(page);
  await selectProvider(page, "Anthropic");
  const quota = page.getByRole("region", { name: "订阅额度", exact: true });
  const fiveHour = quota.locator('[data-window-id="five_hour"]');
  const weekly = quota.locator('[data-window-id="weekly"]');
  await weekly.getByText("已用 74%", { exact: true }).waitFor({ timeout: 15000 });
  check("Claude 五小时与周额度是真实查询结果，0%不是未知", await fiveHour.getByRole("progressbar").getAttribute("aria-valuenow") === "0" && await weekly.getByRole("progressbar").getAttribute("aria-valuenow") === "74");
  check("重置时间同时显示本地日期和还需等待多久", /后重置 ·/.test(await fiveHour.locator("small").innerText()));
  check("额度就在原订阅登录卡下方，原有表单还在", await page.locator(".provider-credential-editor .provider-quota").count() === 1 && await page.getByRole("button", { name: "退出登录", exact: true }).count() === 1);
  await shot("claude-light");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await shot("claude-dark");
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  body.anthropic.payload.five_hour.utilization = 100;
  body.anthropic.payload.seven_day.utilization = 91;
  update();
  await quota.getByRole("button", { name: "刷新订阅额度" }).click();
  await fiveHour.getByText("已用 100%", { exact: true }).waitFor();
  check("手动刷新不读旧缓存，额度用尽有明显标记", await fiveHour.getAttribute("class").then((value) => value.includes("exhausted")) && await weekly.getByRole("progressbar").getAttribute("aria-valuenow") === "91");

  body.anthropic.status = 503;
  const goodPayload = body.anthropic.payload;
  body.anthropic.payload = { error: "quota-e2e-anthropic should never reach the renderer" };
  update();
  await quota.getByRole("button", { name: "刷新订阅额度" }).click();
  await quota.getByText(/HTTP 503/).waitFor();
  check("查询故障保留上次结果并明确标成旧数据", await quota.locator('[data-stale="true"]').count() === 1 && (await quota.innerText()).includes("上次成功查询"));
  check("失败不泄露官方错误里的凭据，也不清掉订阅登录", !(await quota.innerText()).includes("quota-e2e-anthropic") && readFileSync(authPath, "utf8") === originalAuth);
  await shot("quota-failure");

  body.anthropic.status = 200;
  body.anthropic.payload = { ...goodPayload, five_hour: { utilization: 35, resets_at: new Date(reset).toISOString() }, seven_day: null };
  update();
  await quota.getByRole("button", { name: "刷新订阅额度" }).click();
  await fiveHour.getByText("已用 35%", { exact: true }).waitFor();
  check("恢复后能直接再查，未提供的周额度不伪装成0%", await weekly.getByRole("progressbar").getAttribute("aria-valuenow") === null && (await weekly.innerText()).includes("服务商未提供用量") && await quota.locator(".provider-quota-error").count() === 0);

  // The old Claude request is deliberately still running when switching to Codex.
  body.anthropic.delayMs = 500;
  body.anthropic.payload = { ...goodPayload, five_hour: { utilization: 69, resets_at: new Date(reset).toISOString() } };
  update();
  await quota.getByRole("button", { name: "刷新订阅额度" }).click();
  const oldResult = page.evaluate(() => window.coilcoil.request({ type: "get_model_provider_quota", provider: "anthropic", refresh: true }));
  await selectProvider(page, "OpenAI Codex");
  await fiveHour.getByText("已用 10%", { exact: true }).waitFor();
  await oldResult;
  check("切换服务商不被上一家的迟到响应覆盖", await fiveHour.getByRole("progressbar").getAttribute("aria-valuenow") === "10" && await weekly.getByRole("progressbar").getAttribute("aria-valuenow") === "51");
  check("Codex 根据窗口长度区分五小时/周，不受原字段顺序影响", (await quota.innerText()).includes("Team") && !(await quota.innerText()).includes("69%"));
  await shot("codex-light");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await shot("codex-dark");
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  const remote = await openRemoteClient({ app, page, remotePort });
  try {
    await openSettings(remote);
    await selectProvider(remote, "OpenAI Codex");
    const remoteQuota = remote.getByRole("region", { name: "订阅额度", exact: true });
    await remoteQuota.getByText("已用 51%", { exact: true }).waitFor();
    check("真实网页版也能通过运行时查询订阅额度", await remoteQuota.getByText("已用 10%", { exact: true }).count() === 1);
  } finally { await remote.close(); }

  await page.locator(".provider-oauth-action").getByRole("button", { name: "退出登录", exact: true }).click();
  await quota.getByText(/订阅登录后可查看/).waitFor();
  const afterLogout = JSON.parse(readFileSync(authPath, "utf8"));
  check("退出登录马上移除旧额度，只退出所选账号", !afterLogout["openai-codex"] && Boolean(afterLogout.anthropic) && await quota.locator(".provider-quota-windows").count() === 0 && await quota.getByRole("button", { name: "刷新订阅额度" }).count() === 0);
  const loggedOutResult = await page.evaluate(() => window.coilcoil.request({ type: "get_model_provider_quota", provider: "openai-codex" }));
  assert.equal(loggedOutResult.status, "not_logged_in");
  check("退出后后端也拒绝使用旧缓存", loggedOutResult.windows.length === 0);
  const requests = readFileSync(`${fixture}.requests`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  check("真实 runtime 确实访问了两家的额度接口替身", ["anthropic", "openai-codex"].every((provider) => requests.some((item) => item.provider === provider && item.phase === "finished")));
}
