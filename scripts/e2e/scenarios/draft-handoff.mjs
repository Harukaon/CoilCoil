export const description = "新对话里先开的页面，发出第一条消息后交给这个会话；Agent 要接管才能用";

export async function run({ page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.typeAddress(site.url("draft.html"));
  await ui.waitFor(async () => (await ui.browserTabs()).some((tab) => tab.label === "page-draft"));
  check("草稿：用户在面板里打开了 draft 页", (await ui.browserTabs()).some((tab) => tab.label === "page-draft"));
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "list_pages" } }, { echo: true }], "草稿会话");
  const tabs = (await ui.browserTabs()).map((tab) => tab.label);
  check("发出第一条消息后：面板里还是 draft 页，没有多出空白页", JSON.stringify(tabs) === '["page-draft"]', JSON.stringify(tabs));
  check("用户的页不归 Agent，它的页面列表里没有", !(await ui.lastEcho()).includes("draft.html"), (await ui.lastEcho()).slice(0, 160));

  await ui.send([{ tool: "browser_user_tabs", args: {} }, { echo: true }], "草稿会话");
  const listing = await ui.lastEcho();
  const tabId = /tab=([0-9a-f-]{36})/.exec(listing)?.[1];
  check("browser_user_tabs 列得出用户开着的 draft 页", Boolean(tabId) && listing.includes("draft.html"), listing.slice(0, 200));

  await ui.send([{ tool: "browser_take_over", args: { tab: tabId } }, { echo: true }], "草稿会话");
  const taken = await ui.lastEcho();
  check("接管后拿到句柄", /已接管[\s\S]*句柄 btab-1/.test(taken), taken.slice(0, 200));
  const after = await ui.browserTabs();
  check("还是那一张标签页，换成 Agent 的标识", after.length === 1 && after[0].label === "page-draft" && after[0].agent, JSON.stringify(after));
  await shot("after-take-over");
  void page;
}
