export const description = "内置浏览器的安全底线：App 界面里塞 <webview> 也造不出网页；每张网页都是沙箱、隔离、没有 Node、没有预加载的离屏页面，网页里摸不到系统能力；登录数据落在这个工作区自己那份里；Agent 看到的页面里没有 App 自己的界面；面板来的查找、光标、悬停提示只对正显示的那张生效";

/** 在内置浏览器的那张网页里跑一段脚本。 */
const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.isOffscreen() && item.getURL().includes("form.html"));
  return contents ? contents.executeJavaScript(code) : undefined;
}, code);

export async function run({ app, page, ui, site, check }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: site.url("form.html") } }, { echo: true }], "安全");
  await ui.waitFor(async () => (await inPage(app, "document.readyState")) === "complete", 15_000);

  // 1. 以前网页是界面里的 <webview>，界面脚本能自己造一个；现在主窗口关了这个口子。
  const countPages = () => app.evaluate(({ webContents }) => webContents.getAllWebContents()
    .filter((item) => !item.isDestroyed() && (item.getType() === "webview" || item.getTitle() === "sneaky" || item.getURL().includes("sneaky"))).length);
  const before = await countPages();
  await page.evaluate(() => {
    const view = document.createElement("webview");
    view.id = "sneaky-webview";
    view.setAttribute("src", "data:text/html,<title>sneaky</title>sneaky");
    view.setAttribute("partition", "persist:coilcoil-browser");
    view.setAttribute("nodeintegration", "");
    document.body.append(view);
  });
  await page.waitForTimeout(1500);
  check("App 界面里塞进 <webview> 也造不出网页", before === 0 && (await countPages()) === 0, `${before} -> ${await countPages()}`);
  await page.evaluate(() => document.getElementById("sneaky-webview")?.remove());

  // 2. 每张网页的设置都是写死的：沙箱、隔离、没有 Node、没有预加载、不许再嵌网页、离屏。
  const pages = await app.evaluate(({ webContents }) => webContents.getAllWebContents()
    .filter((item) => !item.isDestroyed() && item.isOffscreen())
    .map((item) => {
      const preferences = item.getLastWebPreferences() ?? {};
      return {
        url: item.getURL(),
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        nodeIntegrationInSubFrames: preferences.nodeIntegrationInSubFrames,
        webviewTag: preferences.webviewTag,
        preload: preferences.preload ?? null,
        storage: item.session.storagePath ?? "",
      };
    }));
  const locked = pages.length >= 1 && pages.every((item) => item.sandbox === true && item.contextIsolation === true
    && item.nodeIntegration === false && item.nodeIntegrationInSubFrames === false && item.webviewTag === false && item.preload === null);
  check(`每张网页都是沙箱、隔离、没有 Node、没有预加载（${pages.length} 张）`, locked, JSON.stringify(pages));

  // 3. 网页脚本里摸不到系统能力，也摸不到 App 给界面用的接口。
  const reach = JSON.parse(await inPage(app, "JSON.stringify({ require: typeof require, process: typeof process, module: typeof module, coilcoil: typeof window.coilcoil, electron: typeof window.electron })"));
  check("网页里没有 require、process，也没有 App 的接口", Object.values(reach).every((type) => type === "undefined"), JSON.stringify(reach));

  // 4. 登录数据：这个工作区自己一份（Partitions/coilcoil-browser-<12 位>），不是谁都读得到的那份公共的。
  check("网页的登录数据落在这个工作区自己那份里", pages.every((item) => /Partitions[\\/]coilcoil-browser-[0-9a-f]{12}$/.test(item.storage)),
    JSON.stringify(pages.map((item) => item.storage)));

  // 5. Agent 连的调试通道：看得到这个会话的网页，看不到 App 自己的界面。
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "list_pages" } }, { echo: true }], "安全");
  const listed = await ui.lastEcho();
  const appUrl = page.url().split("#")[0];
  check("Agent 列出的页面里有这张网页", listed.includes("form.html"), listed.slice(0, 300));
  check("Agent 列出的页面里没有 App 自己的界面", !listed.includes(appUrl) && !/renderer\/index\.html/.test(listed), `${appUrl} / ${listed.slice(0, 300)}`);

  // 6. 面板来的查找、光标、悬停提示只对「桌面窗口正显示的那张」生效：后台那张不理。两张都开
  //    同一个带提示文字的页面，后台那张要是被问到，也答得出来——这样才看得出区别。
  await ui.send([{ tool: "browser_open", args: { url: `${site.url("tooltip.html")}?behind` } }, { echo: true }], "安全");
  await ui.send([{ tool: "browser_open", args: { url: site.url("tooltip.html") } }, { echo: true }], "安全");
  await page.waitForTimeout(800);
  await app.evaluate(({ ipcMain }) => {
    globalThis.__browserIds = undefined;
    ipcMain.once("browser:input", (_event, scopeId, tabId) => { globalThis.__browserIds = { scopeId, tabId }; });
  });
  const box = await page.locator(".browser-live-page").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20);
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height - 25);
  await ui.waitFor(async () => Boolean(await app.evaluate(() => globalThis.__browserIds)), 3000);
  const { scopeId, tabId: shownId } = await app.evaluate(() => globalThis.__browserIds);
  const hiddenId = await page.evaluate(async ({ scopeId, shownId }) => (await window.coilcoil.getBrowserState(scopeId)).tabs
    .find((tab) => tab.id !== shownId && tab.url.includes("tooltip.html?behind"))?.id, { scopeId, shownId });
  check("两张网页：一张正显示、一张在后台", Boolean(shownId && hiddenId));
  const tooltips = await page.evaluate(async ({ scopeId, shownId, hiddenId }) => ({
    shown: await window.coilcoil.readBrowserTooltip(scopeId, shownId, { x: 90, y: 40 }),
    hidden: await window.coilcoil.readBrowserTooltip(scopeId, hiddenId, { x: 90, y: 40 }),
    caret: await window.coilcoil.readBrowserCaret(scopeId, hiddenId),
  }), { scopeId, shownId, hiddenId });
  check("悬停提示：正显示的那张照常问得到", tooltips.shown === "保存文件", JSON.stringify(tooltips));
  check("悬停提示、光标：后台那张不理", tooltips.hidden === null && tooltips.caret === null, JSON.stringify(tooltips));
  const finds = await page.evaluate(async ({ scopeId, shownId, hiddenId }) => {
    const events = [];
    const stop = window.coilcoil.onBrowserPageEvent((event) => { if (event.kind === "find") events.push(event); });
    window.coilcoil.findInBrowserPage(scopeId, hiddenId, { text: "保存", forward: true, newSearch: true });
    window.coilcoil.findInBrowserPage(scopeId, shownId, { text: "保存", forward: true, newSearch: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    window.coilcoil.findInBrowserPage(scopeId, shownId, { stop: true });
    stop();
    return events.map((event) => ({ tab: event.tabId === shownId ? "shown" : event.tabId === hiddenId ? "hidden" : "other", matches: event.matches }));
  }, { scopeId, shownId, hiddenId });
  check("页内查找：正显示的那张照常找", finds.some((item) => item.tab === "shown" && item.matches >= 1), JSON.stringify(finds));
  check("页内查找：后台那张不理", !finds.some((item) => item.tab === "hidden"), JSON.stringify(finds));
}
