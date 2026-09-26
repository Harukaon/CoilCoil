export const description = "新对话里先开的页面，发出第一条消息后交给这个会话；Agent 直接看得到、拿句柄就能用，页面不刷新，用户写了一半的东西还在";

/** 主进程里找到装着 draft.html 的那个页面，在里面跑一段脚本。 */
const inDraft = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("draft.html"));
  return contents ? contents.executeJavaScript(code) : undefined;
}, code);

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.typeAddress(site.url("draft.html"));
  await ui.waitFor(async () => (await ui.browserTabs()).some((tab) => tab.label === "page-draft"));
  check("草稿：用户在面板里打开了 draft 页", (await ui.browserTabs()).some((tab) => tab.label === "page-draft"));
  await ui.waitFor(async () => (await inDraft(app, "document.readyState")) === "complete");
  // 用户在页面里写了一半。
  await inDraft(app, "document.querySelector('#note').value = '用户写了一半'");
  const loadedAt = await inDraft(app, "performance.timeOrigin");

  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "list_pages" } }, { echo: true }], "草稿会话");
  const tabs = (await ui.browserTabs()).map((tab) => tab.label);
  check("发出第一条消息后：面板里还是 draft 页，没有多出空白页", JSON.stringify(tabs) === '["page-draft"]', JSON.stringify(tabs));
  check("用户开的页面 Agent 也看得到", (await ui.lastEcho()).includes("draft.html"), (await ui.lastEcho()).slice(0, 200));

  await ui.send([{ tool: "browser_tabs", args: {} }, { echo: true }], "草稿会话");
  const listing = await ui.lastEcho();
  const handle = /(btab-\d+)（用户正看着）（用户开的）：page-draft/.exec(listing)?.[1];
  check("browser_tabs 列出 draft 页：用户正看着、用户开的，给了句柄", Boolean(handle), listing.slice(0, 240));

  // 拿一份页面快照找输入框：点一个不存在的元素，工具会把新快照带回来。
  await ui.send([{ tool: "browser_click", args: { handle, uid: "999_999" } }, { echo: true }], "草稿会话");
  const input = /uid=(\S+) textbox "AI 写的"/.exec(await ui.lastEcho())?.[1];
  check("快照里找得到 AI 该填的输入框", Boolean(input), (await ui.lastEcho()).slice(0, 300));
  await ui.send([{ tool: "browser_type", args: { handle, uid: input, value: "AI 接着写" } }, { echo: true }], "草稿会话");
  check("Agent 拿句柄直接在用户的页面里打字", await ui.waitFor(async () => (await inDraft(app, "document.querySelector('#ai').value")) === "AI 接着写"),
    String(await inDraft(app, "document.querySelector('#ai').value")));
  check("用户写了一半的东西还在", (await inDraft(app, "document.querySelector('#note').value")) === "用户写了一半");
  check("页面一次都没刷新", (await inDraft(app, "performance.timeOrigin")) === loadedAt);
  const after = await ui.browserTabs();
  check("还是那一张标签页，还是用户的（标签上不换成 Agent 的标识）", after.length === 1 && after[0].label === "page-draft" && !after[0].agent, JSON.stringify(after));
  await shot("after");

  // App 界面重载（开发时热更新、界面崩了重开）：页面都是离屏的，不跟着界面走，一张都不丢、也不刷新。
  await page.reload();
  await page.waitForFunction(() => Boolean(window.coilcoil), undefined, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  check("App 界面重载后，页面还在、没刷新，写的东西都在",
    (await inDraft(app, "performance.timeOrigin")) === loadedAt && (await inDraft(app, "document.querySelector('#ai').value")) === "AI 接着写");
}
