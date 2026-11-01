export const description = "Agent 结束后清空白页，create→navigate 与用户空白页均保留";
const call = (tool, args) => ({ tool: "browser", args: { action: "call", tool, args } });

export async function run({ page, ui, site, check, shot, paths }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser", args: { action: "tools" } }, { echo: true }], "空白清理");
  const scope = await page.evaluate(async (cwd) => (await window.coilcoil.request({ type: "list_sessions", cwd }))[0].id, paths.projA);
  const state = () => page.evaluate((id) => window.coilcoil.getBrowserState(id), scope);
  check("披露工具和查询版本不会新建 Agent 空白页", !(await state()).tabs.some((tab) => tab.agent), JSON.stringify((await state()).tabs));
  await page.evaluate((id) => window.coilcoil.createBrowserTab(id), scope);
  await ui.send([call("devtools.new_page", { url: "about:blank" }), { echo: true }], "空白清理");
  check("本轮结束清掉显式 Agent 空白，保留用户自己的空白页", await ui.waitFor(async () => {
    const tabs = (await state()).tabs;
    return !tabs.some((tab) => tab.agent && tab.url === "about:blank") && tabs.some((tab) => !tab.agent && tab.url === "about:blank");
  }), JSON.stringify((await state()).tabs));
  await ui.send([call("open", { url: "about:blank" }), call("navigate", { handle: "btab-1", url: site.url("a.html") }), { echo: true }], "合法导航");
  check("同一轮先创建空白再导航，目标页保留到结束", (await state()).tabs.some((tab) => tab.agent && tab.url === site.url("a.html")), JSON.stringify((await state()).tabs));
  await ui.send([call("devtools.new_page", { url: "about:blank" }), call("devtools.evaluate_script", { function: "() => { document.title = 'generated-report'; document.body.innerHTML = '<h1>Report</h1>'; return true; }" }), { echo: true }], "有效文档");
  check("about:blank 已写入实际文档时保留，不当作废弃空白页", await ui.waitFor(async () => (await state()).tabs.some((tab) => tab.title === "generated-report")), JSON.stringify((await state()).tabs));
  await shot("settled");
}
