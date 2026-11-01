export const description = "每个会话最多 8 页，common/raw/UI 都拒绝第 9 页，并发创建也不突破上限";
const call = (tool, args) => ({ tool: "browser", args: { action: "call", tool, args } });

export async function run({ page, ui, site, check, shot, paths }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.typeAddress(site.url("u.html"));
  await ui.waitFor(async () => (await ui.browserTabs()).some((tab) => tab.label === "u"));
  await ui.send([
    ...[1, 2, 3, 4, 5, 6].map((n) => call("open", { url: site.url(`p${n}.html`) })),
    call("devtools.new_page", { url: site.url("p7.html") }), { echo: true },
  ], "上限");
  const full = await ui.browserTabs();
  check("用户页与 Agent 页合计 8 张，全部保留", full.length === 8 && full.some((tab) => tab.label === "u") && full.filter((tab) => tab.agent).length === 7, JSON.stringify(full));
  for (const tool of ["open", "devtools.new_page"]) {
    await ui.send([call(tool, { url: site.url("a.html") }), { echo: true }], "上限");
    const text = await ui.lastEcho();
    check(`${tool} 拒绝第 9 张并要求复用或关闭`, /8 browser tabs/.test(text) && /Reuse.*close/.test(text) && (await ui.browserTabs()).length === 8, text.slice(0, 400));
  }
  const scope = await page.evaluate(async (cwd) => (await window.coilcoil.request({ type: "list_sessions", cwd }))[0].id, paths.projA);
  const userFailure = await page.evaluate(async (id) => {
    try { await window.coilcoil.createBrowserTab(id); return "unexpected success"; }
    catch (error) { return String(error); }
  }, scope);
  check("用户 UI 开页路径使用相同上限", userFailure.includes("8 browser tabs") && (await ui.browserTabs()).length === 8, userFailure);
  await ui.send([call("navigate", { handle: "btab-1", url: site.url("a.html") }), { echo: true }], "复用");
  check("满额时仍能复用已有页面，其他页面没有被回收", (await ui.browserTabs()).some((tab) => tab.label === "page-a") && (await ui.browserTabs()).length === 8);
  await shot("eight");
  await page.evaluate(async (id) => {
    const current = await window.coilcoil.getBrowserState(id);
    for (const tab of current.tabs) await window.coilcoil.closeBrowserTab(id, tab.id);
  }, scope);
  const parallel = await page.evaluate(async ({ id, url }) => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => window.coilcoil.createBrowserTab(id, url)));
    const current = await window.coilcoil.getBrowserState(id);
    return { accepted: results.filter((entry) => entry.status === "fulfilled").length, rejected: results.filter((entry) => entry.status === "rejected").map((entry) => String(entry.reason)), count: current.tabs.length };
  }, { id: scope, url: site.url("b.html") });
  check("12 个并发创建只有 8 个成功，失败不留下半成品标签", parallel.accepted === 8 && parallel.rejected.length === 4 && parallel.rejected.every((text) => text.includes("8 browser tabs")) && parallel.count === 8, JSON.stringify(parallel));
}
