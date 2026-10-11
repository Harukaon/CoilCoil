import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRemoteClient, repositoryRoot } from "../harness.mjs";

export const description = "两个 Claude 和两个 Codex 独立登录、各自额度与模型前缀，原账号保留，网页与重启可恢复";
const fixtureRoot = mkdtempSync(join(tmpdir(), "coil-accounts-e2e-"));
const fixture = join(fixtureRoot, "accounts.json");
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));
const ids = ["claude-work", "claude-personal", "codex-work", "codex-personal"];
const accounts = Object.fromEntries([...ids, "anthropic", "openai-codex", "claude-web"].map((id, i) => [id, { kind: id.startsWith("codex") || id === "openai-codex" ? "openai-codex" : "anthropic", used: i * 10 + 5 }]));
writeFileSync(fixture, JSON.stringify(accounts));
const token = (id) => accounts[id].kind === "anthropic" ? `sk-ant-oat01-alias-e2e-${id}` : `alias-e2e.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: `account-${id}` } })).toString("base64url")}.signature`;
const credential = (id) => ({ type: "oauth", access: token(id), refresh: `alias-refresh-${id}`, expires: Date.now() + 86400000 });
export const launchOptions = {
  remote: true,
  credentials: { anthropic: credential("anthropic"), "openai-codex": credential("openai-codex") },
  env: { COILCOIL_E2E_ACCOUNTS_FIXTURE: fixture },
  runtimeNodeOptions: `--require ${JSON.stringify(join(import.meta.dirname, "../subscription-accounts-fetch.cjs"))}`,
};
async function settings(page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置栏目" }).getByRole("button", { name: "模型与服务商", exact: true }).click();
}
async function select(page, id) {
  await page.locator(".provider-catalog-group button").filter({ has: page.locator("small", { hasText: new RegExp(`^${id}$`) }) }).click();
}
async function create(page, id) {
  await page.getByRole("button", { name: "添加订阅账号", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加订阅账号" });
  if (accounts[id].kind === "openai-codex") {
    await dialog.getByRole("button", { name: "订阅类型", exact: true }).click();
    await page.getByRole("option", { name: "OpenAI / Codex 订阅", exact: true }).click();
  }
  await dialog.getByPlaceholder(/例如 claude-work|例如 codex-personal/).fill(id);
  await dialog.getByPlaceholder("例如工作账号；留空则使用前缀").fill(id);
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator(".provider-editor").getByRole("button", { name: "订阅登录", exact: true }).waitFor();
}
async function login(page, id) {
  await page.evaluate(() => {
    window.__e2eAccountAuth = {};
    window.coilcoil.onRuntimeEvent((event) => { if (event.type === "model_provider_auth_updated") window.__e2eAccountAuth[event.state.provider] = event.state; });
  });
  await page.locator(".provider-oauth-action").getByRole("button", { name: "订阅登录", exact: true }).click();
  if (accounts[id].kind === "openai-codex") {
    await page.locator(".provider-oauth-options button").first().click();
  }
  await page.waitForFunction((id) => window.__e2eAccountAuth?.[id]?.authUrl?.url && window.__e2eAccountAuth?.[id]?.prompt?.type === "manual_code", id);
  const state = await page.evaluate((id) => window.__e2eAccountAuth[id], id);
  const auth = new URL(state.authUrl.url);
  const callback = new URL(auth.searchParams.get("redirect_uri"));
  callback.searchParams.set("code", `alias-e2e-${id}`);
  callback.searchParams.set("state", auth.searchParams.get("state"));
  await page.locator(".provider-oauth-input").fill(callback.href);
  await page.locator(".provider-oauth-submit").click();
  const succeeded = page.getByRole("dialog", { name: "订阅登录成功", exact: true });
  await succeeded.waitFor({ timeout: 20000 });
  await succeeded.getByRole("button", { name: "完成", exact: true }).click();
  await page.locator('[data-window-id="five_hour"]').getByText(`已用 ${accounts[id].used}%`, { exact: true }).waitFor();
}

export async function run({ app, page, root, remotePort, ui, check, shot }) {
  await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
  const authPath = join(root, "data/agent/auth.json");
  const original = JSON.parse(readFileSync(authPath, "utf8"));
  await settings(page);
  for (const id of ids) {
    await create(page, id);
    await login(page, id);
    check(`${id} 单独登录且显示自己的额度`, (await page.locator(".provider-quota").innerText()).includes(`已用 ${accounts[id].used}%`));
  }
  const stored = JSON.parse(readFileSync(authPath, "utf8"));
  check("六份独立登录共存，原两账号没有被覆盖", Object.keys(stored).length === 6 && JSON.stringify(stored.anthropic) === JSON.stringify(original.anthropic) && JSON.stringify(stored["openai-codex"]) === JSON.stringify(original["openai-codex"]));
  check("原厂模型编辑器和账号前缀保留", await page.locator(".provider-editor").getByText("模型目录", { exact: true }).count() === 1 && await page.locator(".provider-editor").getByLabel(/账号前缀/).isDisabled());
  await shot("accounts-light");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await shot("accounts-dark");
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  const remote = await openRemoteClient({ app, page, remotePort });
  try {
    await settings(remote);
    await select(remote, "codex-personal");
    await remote.locator('[data-window-id="five_hour"]').getByText("已用 35%", { exact: true }).waitFor();
    await create(remote, "claude-web");
    check("网页版能管理独立账号，不修改已有凭据", await remote.locator(".provider-editor").getByRole("button", { name: "订阅登录", exact: true }).count() === 1 && Object.keys(JSON.parse(readFileSync(authPath, "utf8"))).length === 6);
  } finally { await remote.close(); }

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await ui.newConversation("projA");
  // The empty composer is a draft; send through the mock first so selections target a real session.
  await ui.send([], "多账号切换验证起点");
  await page.evaluate(() => window.coilcoil.onRuntimeEvent((event) => { if (event.type === "session_snapshot") window.__e2eSelectedAccount = event.snapshot.model?.provider; }));
  for (const id of ids) {
    await page.locator(".agent-mode").first().click();
    const submenu = page.locator(".model-submenu-trigger");
    if (await submenu.count()) await submenu.click();
    await page.locator(".model-option-main").filter({ hasText: `${id} · ` }).first().click();
    await page.waitForFunction((id) => window.__e2eSelectedAccount === id, id);
    await page.locator(".agent-mode").filter({ hasText: id }).first().waitFor();
    check(`选择 ${id} 后当前模型继续显示账号前缀`, (await page.locator(".agent-mode").first().innerText()).includes(id));
  }
  await settings(page);
  await select(page, "claude-work");
  await page.locator(".provider-oauth-action").getByRole("button", { name: "退出登录", exact: true }).click();
  await page.locator(".provider-quota").getByText(/订阅登录后可查看/).waitFor();
  let after = JSON.parse(readFileSync(authPath, "utf8"));
  check("退出一个 Claude 不影响其他五个账号", !after["claude-work"] && Object.keys(after).length === 5 && after["claude-personal"].access === stored["claude-personal"].access && after["codex-personal"].access === stored["codex-personal"].access);
  await select(page, "codex-work");
  await page.locator(".provider-editor").getByRole("button", { name: "移除账号", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "移除订阅账号", exact: true });
  await confirm.getByRole("button", { name: "移除账号", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  after = JSON.parse(readFileSync(authPath, "utf8"));
  const definitions = JSON.parse(readFileSync(join(root, "data/agent/subscription-accounts.json"), "utf8"));
  check("删除只清该账号，保留其他项和前缀保护", !after["codex-work"] && after["codex-personal"].access === stored["codex-personal"].access && !definitions.accounts.some((a) => a.id === "codex-work") && definitions.retiredIds.includes("codex-work"));

  await app.evaluate(async (_electron, entry) => {
    const child = process._getActiveHandles().find((handle) => handle.spawnargs?.includes(entry));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill(); await exited;
  }, join(repositoryRoot, "apps/desktop/out/main/runtime.js"));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.coilcoil));
  await settings(page);
  await select(page, "codex-personal");
  await page.locator('[data-window-id="five_hour"]').getByText("已用 35%", { exact: true }).waitFor();
  check("实际重启运行时后，账号、登录和额度仍能恢复", await page.locator(".provider-oauth-action").getByRole("button", { name: "退出登录", exact: true }).count() === 1);
  const requests = readFileSync(`${fixture}.requests`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(ids.every((id) => requests.some((r) => r.id === id && r.action === "authorization_code")));
  check("四次登录均走真正的原厂授权码兑换流程", ids.every((id) => requests.some((r) => r.id === id && r.action === "usage")));
}
