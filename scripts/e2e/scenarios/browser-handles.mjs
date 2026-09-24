export const description = "browser_* 句柄指向自己开的页，出错如实报失败";

export async function run({ ui, site, check }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("a.html") } }, { echo: true }], "句柄");
  await ui.send([{ tool: "browser_open", args: { url: site.url("b.html") } }, { echo: true }], "句柄");
  await ui.send([{ tool: "browser_navigate", args: { handle: "btab-2", url: site.url("c.html") } }, { echo: true }], "句柄");
  await ui.waitFor(async () => (await ui.browserTabs()).some((tab) => tab.label === "page-c"));
  const tabs = (await ui.browserTabs()).map((tab) => tab.label);
  check("拿 b 的句柄导航，换掉的是 b，a 不动", JSON.stringify(tabs) === '["page-a","page-c"]', JSON.stringify(tabs));
  await ui.send([{ tool: "browser_click", args: { handle: "btab-2", uid: "999_999" } }, { echo: true }], "句柄");
  const echo = await ui.lastEcho();
  check("点不存在的元素：报点击失败并带回新快照", echo.includes("点击失败") && echo.includes("当前页面"), echo.slice(0, 160));
}
