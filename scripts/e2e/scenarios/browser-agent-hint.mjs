export const description = "「Agent 正在操作」提示：Agent 一动手（导航、开新页、切到某页，不管网页是谁开的）面板上就亮出提示，停手几秒后自动收起；用户和 Agent 同时操作不排队；标签条上「Agent 开的」标记照旧";

export async function run({ page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.typeAddress(site.url("u.html"));
  await ui.waitFor(async () => (await ui.browserTabs()).some((tab) => tab.label === "u"));
  const bar = page.locator(".browser-agent-bar");
  const hint = () => bar.innerText().catch(() => null);
  await page.waitForTimeout(1000);
  check("用户自己开的网页、Agent 没动它：没有提示", (await bar.count()) === 0);

  // Agent 操作用户开的这张（P3 以后 Agent 能直接用当前对话的全部网页）。
  await ui.send([{ tool: "browser_tabs", args: {} }, { echo: true }], "提示");
  const handle = /(btab-\d+)（用户正看着）（用户开的）：u/.exec(await ui.lastEcho())?.[1];
  check("Agent 拿到了用户那张的句柄", Boolean(handle), (await ui.lastEcho()).slice(0, 200));
  await ui.send([{ tool: "browser_navigate", args: { handle, url: site.url("p1.html") } }, { echo: true }], "提示");
  check("Agent 操作用户开的网页：亮出「Agent 正在操作这个页面」", await ui.waitFor(async () => (await hint()) === "Agent 正在操作这个页面", 3000), String(await hint()));
  await shot("hint");
  check("Agent 停手几秒后：提示自动收起", await ui.waitFor(async () => (await bar.count()) === 0, 15_000));

  // Agent 自己开一张：动手时亮，停手后同样收起（以前是 Agent 开的就一直挂着）。
  await ui.send([{ tool: "browser_open", args: { url: site.url("p2.html") } }, { echo: true }], "提示");
  check("Agent 开新页：亮出提示", await ui.waitFor(async () => (await hint()) === "Agent 正在操作这个页面", 3000), String(await hint()));
  check("Agent 开的这张停手以后也收起", await ui.waitFor(async () => (await bar.count()) === 0, 15_000));
  const tabs = await ui.browserTabs();
  check("标签条上 Agent 开的那张照样带「Agent 开的」标记", tabs.some((tab) => tab.label.startsWith("p2") && tab.agent), JSON.stringify(tabs));

  // Agent 用官方工具把用户那张（现在显示 p1）切到前台（select_page + bringToFront）：面板切过去，
  // 也算它在操作，亮提示（评审抓到过：切页这条路以前不亮）。
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "list_pages" } }, { echo: true }], "提示");
  const pageId = Number(/(\d+): p1 \(/.exec(await ui.lastEcho())?.[1]);
  check("Agent 在页面列表里找到用户那张", Number.isInteger(pageId), (await ui.lastEcho()).slice(0, 240));
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "select_page", args: { pageId, bringToFront: true } } }, { echo: true }], "提示");
  const activeLabel = async () => (await page.locator(".inspector-tab.active .inspector-tab-select").innerText().catch(() => "")).trim();
  check("Agent 切到用户那张：面板切过去了", await ui.waitFor(async () => (await activeLabel()).startsWith("p1"), 5000), await activeLabel());
  check("Agent 切到用户那张：亮出「Agent 正在操作这个页面」", await ui.waitFor(async () => (await hint()) === "Agent 正在操作这个页面", 3000), String(await hint()));
}
