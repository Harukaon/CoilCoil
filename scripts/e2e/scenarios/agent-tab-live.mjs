import { driver, openRemoteClient } from "../harness.mjs";

export const description = "Agent 新开标签页实时跟上：桌面面板开着时不用动手就出现、画面立刻出来；电脑上同时开着网页版、看着别的会话也不受影响；网页版自己也看得到 Agent 的页面";
export const launchOptions = { remote: true };

/** 面板里显示的是这张 Agent 页的画面（不是「正在读取」，也不是上一张的旧画面）。 */
const showsAgentPage = (page, title) => page.locator("img.browser-agent-frame").evaluate(
  (img, title) => img.alt === title && Boolean(img.getAttribute("src")) && img.naturalWidth > 0, title,
).catch(() => false);

const hasTab = async (ui, label) => (await ui.browserTabs()).some((tab) => tab.label === label && tab.agent);

export async function run({ app, page, ui, site, check, shot, remotePort }) {
  // 电脑上另开着网页版，停在它自己的新对话上（和桌面不是同一个会话）。
  const remote = await openRemoteClient({ app, page, remotePort });
  const web = driver(remote);
  check("网页版连上了，是远程客户端", await remote.evaluate(() => document.documentElement.dataset.client === "remote"));

  // 桌面：用户打开浏览器面板、自己看着一个网页，面板一直开着。
  await page.bringToFront();
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.typeAddress(site.url("u.html"));
  check("桌面：用户先打开了浏览器面板、在看自己的网页", await ui.waitFor(async () => (await ui.browserTabs()).some((tab) => tab.label === "u")), JSON.stringify(await ui.browserTabs()));
  // 网页版这时再动一下（换到自己的新对话），和它断线重连、切会话时一样会报一次「我在看哪个会话」。
  await web.newConversation("projB");

  // 1. Agent 新开一张：桌面用户什么都不做，标签条和画面都要自己跟上。
  await ui.send([{ tool: "browser_open", args: { url: site.url("a.html") } }, { echo: true }], "实时");
  check("桌面：Agent 开的页面不用动手就出现在标签条上", await ui.waitFor(() => hasTab(ui, "page-a")), JSON.stringify(await ui.browserTabs()));
  check("桌面：Agent 页面的画面自己出来了，不是一直「正在读取」", await ui.waitFor(() => showsAgentPage(page, "page-a")));
  await shot("desktop-first");

  // 2. 再开一张，同样要立刻跟上，画面换成新的这张。
  await ui.send([{ tool: "browser_open", args: { url: site.url("form.html") } }, { echo: true }], "实时");
  check("桌面：第二张也立刻出现在标签条上", await ui.waitFor(() => hasTab(ui, "page-form")), JSON.stringify(await ui.browserTabs()));
  check("桌面：画面换成了第二张", await ui.waitFor(() => showsAgentPage(page, "page-form")));

  // 3. 网页版（电脑宽度）打开同一个会话的浏览器面板：Agent 的页面要看得到，不能一直「正在读取」。
  await remote.bringToFront();
  // 网页版的会话列表不会自己刷出桌面刚建的会话，刷新一下页面再去点。
  await remote.reload();
  await remote.locator(".agent-mode", { hasText: "Mock 1" }).first().waitFor({ timeout: 60_000 });
  // 后台窗口里 Playwright 的鼠标点击等不到「可点」状态，直接触发这一行的点击。
  await remote.locator(".sidebar .conversation-row", { hasText: "实时" }).first().evaluate((row) => row.click());
  await remote.waitForTimeout(1500);
  await web.openBrowserPanel();
  check("网页版：标签条上有 Agent 开的页面", await web.waitFor(() => hasTab(web, "page-form")), JSON.stringify(await web.browserTabs()));
  check("网页版：Agent 页面的画面出来了，不是一直「正在读取」", await web.waitFor(() => showsAgentPage(remote, "page-form"), 15_000));

  // 4. 两边都开着时 Agent 再开一张：两边都要自己跟上。
  await page.bringToFront();
  await ui.send([{ tool: "browser_open", args: { url: site.url("b.html") } }, { echo: true }], "实时");
  check("桌面：两边都开着时，新页面照样立刻出现", await ui.waitFor(() => hasTab(ui, "page-b")), JSON.stringify(await ui.browserTabs()));
  check("桌面：两边都开着时，画面照样换成新页面", await ui.waitFor(() => showsAgentPage(page, "page-b")));
  check("网页版：不用动手也出现了新页面", await web.waitFor(() => hasTab(web, "page-b")), JSON.stringify(await web.browserTabs()));
  check("网页版：画面也换成了新页面", await web.waitFor(() => showsAgentPage(remote, "page-b"), 15_000));
  await shot("both");

  // 5. 网页版换去看别的会话（这一刻它报的是另一个会话），桌面这边 Agent 接着开页面：
  //    桌面不能因此收不到自己会话的更新、画面也不能停在「正在读取」。
  await remote.bringToFront();
  // 网页版切会话时发出去的就是这一句（走远程桥，不是桌面的 preload）。
  await remote.evaluate(() => window.coilcoil.setBrowserScope("web-client-other-conversation"));
  await page.bringToFront();
  await ui.send([{ tool: "browser_open", args: { url: site.url("c.html") } }, { echo: true }], "实时");
  check("桌面：网页版换去看别的会话后，Agent 新开的页面照样立刻出现", await ui.waitFor(() => hasTab(ui, "page-c")), JSON.stringify(await ui.browserTabs()));
  check("桌面：网页版换去看别的会话后，画面照样换成新页面", await ui.waitFor(() => showsAgentPage(page, "page-c")));
  await shot("web-elsewhere");
}
