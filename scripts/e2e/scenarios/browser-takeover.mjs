export const description = "Agent 的标签页离屏：点击打字不抢用户焦点；用户和 Agent 可以互相接管，页面状态带过去";

/** 主进程里找到装着 form.html 的那个页面（Agent 的离屏页面或用户的 webview），在里面跑一段脚本。 */
const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("form.html"));
  return contents ? contents.executeJavaScript(code).then((value) => ({ type: contents.getType(), value })) : { type: "none" };
}, code);

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("form.html") } }, { echo: true }], "接管");
  const opened = await inPage(app, "1");
  check("Agent 开的页面是离屏页面", opened.type === "offscreen", JSON.stringify(opened));
  await ui.send([{ tool: "browser_click", args: { handle: "btab-1", uid: "999_999" } }, { echo: true }], "接管");
  const snapshot = await ui.lastEcho();
  const input = /uid=(\S+) textbox/.exec(snapshot)?.[1];
  const button = /uid=(\S+) button/.exec(snapshot)?.[1];
  check("快照里找得到输入框和按钮", input && button, snapshot.slice(0, 300));

  // 用户在输入框里打字、回车发送；Agent 这一轮在网页里点按钮、往输入框里打字。
  const composer = page.locator(".prompt-editor");
  const focused = () => page.evaluate(() => Boolean(document.activeElement?.closest(".prompt-editor")));
  const echoes = await page.getByText("工具返回", { exact: false }).count();
  await composer.click();
  await page.keyboard.insertText(`接管 MOCK:${JSON.stringify([
    { tool: "browser_click", args: { handle: "btab-1", uid: button } },
    { tool: "browser_type", args: { handle: "btab-1", uid: input, value: "agent typed" } },
    { echo: true },
  ])}`);
  await page.keyboard.press("Enter");
  await ui.waitFor(async () => (await page.getByText("工具返回", { exact: false }).count()) > echoes, 60_000);
  check("Agent 点的按钮生效了", (await inPage(app, "document.title")).value === "clicked");
  check("Agent 打的字进了网页", (await inPage(app, "document.querySelector('#q').value")).value === "agent typed");
  check("整个过程焦点一直在输入框里", await focused());
  await page.keyboard.type("我接着打");
  check("用户接着打的字进了输入框", (await composer.innerText()).includes("我接着打"));

  // 面板里是 Agent 页面的画面，只能看，有「接管」按钮。
  const frame = page.locator("img.browser-agent-frame");
  check("面板里显示 Agent 页面的画面", await ui.waitFor(async () => ((await frame.getAttribute("src").catch(() => null)) ?? "").startsWith("blob:")));
  check("Agent 的标签页地址栏是只读的", await page.getByRole("textbox", { name: "网页地址" }).evaluate((element) => element.readOnly));
  const tabs = await ui.browserTabs();
  check("标签条上带 Agent 标识", tabs.length === 1 && tabs[0].agent, JSON.stringify(tabs));
  await shot("agent-view");

  // 用户接管：换成正常网页，Agent 打的字还在。
  await page.getByRole("button", { name: "接管这个页面" }).click();
  check("接管后是正常的网页（webview）", await ui.waitFor(async () => (await inPage(app, "1")).type === "webview", 15_000), JSON.stringify(await inPage(app, "1")));
  check("接管后页面状态带过来了：输入框里还是 Agent 打的字", (await inPage(app, "document.querySelector('#q').value")).value === "agent typed", JSON.stringify(await inPage(app, "document.querySelector('#q').value")));
  check("标签条上不再有 Agent 标识", await ui.waitFor(async () => (await ui.browserTabs()).every((tab) => !tab.agent)));
  check("面板里不再是画面", await ui.waitFor(async () => (await frame.count()) === 0));
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "list_pages" } }, { echo: true }], "接管");
  check("接管后 Agent 看不到这张了", !(await ui.lastEcho()).includes("form.html"), (await ui.lastEcho()).slice(0, 200));

  // 用户在网页里接着填一点，再让 Agent 接管回去。
  await inPage(app, "document.querySelector('#q').value += ' + user'; 1");
  await ui.send([{ tool: "browser_user_tabs", args: {} }, { echo: true }], "接管");
  const tabId = /tab=([0-9a-f-]{36})/.exec(await ui.lastEcho())?.[1];
  await ui.send([{ tool: "browser_take_over", args: { tab: tabId } }, { echo: true }], "接管");
  check("Agent 接管回去：又是离屏页面", await ui.waitFor(async () => (await inPage(app, "1")).type === "offscreen"));
  check("Agent 接管后页面状态也带过去了", (await inPage(app, "document.querySelector('#q').value")).value === "agent typed + user", JSON.stringify(await inPage(app, "document.querySelector('#q').value")));
  check("标签条上又带 Agent 标识", await ui.waitFor(async () => (await ui.browserTabs()).every((tab) => tab.agent)));
  const handle = /句柄 (btab-\d+)/.exec(await ui.lastEcho())?.[1];
  await ui.send([{ tool: "browser_navigate", args: { handle, url: site.url("a.html") } }, { echo: true }], "接管");
  check("Agent 用接管拿到的句柄能继续操作", await ui.waitFor(async () => (await ui.browserTabs()).some((tab) => tab.label === "page-a")), JSON.stringify(await ui.browserTabs()));
  check("还是只有一张标签页", (await ui.browserTabs()).length === 1, JSON.stringify(await ui.browserTabs()));
  await shot("taken-back");
}
