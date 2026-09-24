export const description = "新对话里先开的页面，发出第一条消息后交给这个会话";

export async function run({ page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.typeAddress(site.url("draft.html"));
  await ui.waitFor(async () => (await ui.browserTabs()).some((tab) => tab.label === "page-draft"));
  check("草稿：用户在面板里打开了 draft 页", (await ui.browserTabs()).some((tab) => tab.label === "page-draft"));
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "list_pages" } }, { echo: true }], "草稿会话");
  const tabs = (await ui.browserTabs()).map((tab) => tab.label);
  check("发出第一条消息后：面板里还是 draft 页", JSON.stringify(tabs) === '["page-draft"]', JSON.stringify(tabs));
  const echo = await ui.lastEcho();
  check("Agent 看得到用户刚才打开的页", echo.includes("draft.html"), echo.slice(0, 160));
  await shot("after-send");
  void page;
}
