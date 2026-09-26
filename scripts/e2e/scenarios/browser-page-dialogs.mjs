export const description = "网页弹的 alert/confirm 不弹系统框、不抢焦点：面板里一张卡片，用户能答，Agent 也能答";

const title = (app) => app.evaluate(({ webContents }) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("dialog.html"));
  return contents?.getTitle();
});

/** App 窗口还是系统里的当前窗口：弹了系统对话框的话，它会变成当前窗口。 */
const appWindowFocused = (app) => app.evaluate(({ BrowserWindow }) => {
  const focused = BrowserWindow.getFocusedWindow();
  return Boolean(focused && !focused.webContents.isOffscreen());
});

export async function run({ app, page, ui, site, check, shot }) {
  // Playwright 连着 App 里每一个页面，谁都没在听的网页对话框它会立刻替你点掉（alert、
  // confirm 一弹就关）。真实用户那里没有 Playwright；这里给每个页面挂一个什么都不做的
  // 监听，对话框才会像真的一样停在那里，等面板里的卡片或 Agent 来答。
  const keepDialogs = (win) => win.on("dialog", () => {});
  app.windows().forEach(keepDialogs);
  app.on("window", keepDialogs);
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: site.url("dialog.html") } }, { echo: true }], "弹窗");
  await ui.send([{ tool: "browser_click", args: { handle: "btab-1", uid: "999_999" } }, { echo: true }], "弹窗");
  const snapshot = await ui.lastEcho();
  const uid = (label) => new RegExp(`uid=(\\S+) button "${label}"`).exec(snapshot)?.[1];
  check("快照里找得到两个按钮", uid("弹提示") && uid("弹确认"), snapshot.slice(0, 300));
  const card = page.locator(".browser-page-dialog");
  const composer = page.locator(".prompt-editor");
  const composerFocused = () => page.evaluate(() => Boolean(document.activeElement?.closest(".prompt-editor")));

  // 1. Agent 点出一个 alert，用户这时正在对话框里打字：焦点不动，系统也不弹框。
  const echoes = await page.getByText("工具返回", { exact: false }).count();
  await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => !item.webContents.isOffscreen());
    app.focus({ steal: true });
    window?.show();
    window?.focus();
  });
  check("弹窗前 App 已获得系统焦点", await ui.waitFor(() => appWindowFocused(app)));
  await composer.click();
  await page.keyboard.insertText(`弹窗 MOCK:${JSON.stringify([{ tool: "browser_click", args: { handle: "btab-1", uid: uid("弹提示") } }, { echo: true }])}`);
  await page.keyboard.press("Enter");
  await ui.waitFor(async () => (await page.getByText("工具返回", { exact: false }).count()) > echoes, 60_000);
  check("Agent 收到的是「操作已生效、先处理对话框」，不是点击失败", (await ui.lastEcho()).includes("操作已生效"), (await ui.lastEcho()).slice(0, 200));
  check("面板里出现网页的提示卡片", await ui.waitFor(async () => (await card.count()) === 1 && (await card.innerText()).includes("hello from page")), await card.innerText().catch(() => ""));
  check("App 窗口还是当前窗口：没弹系统对话框", await appWindowFocused(app));
  check("焦点还在对话框里", await composerFocused());
  await page.keyboard.type("照常打字");
  check("接着打的字进了对话框", (await composer.innerText()).includes("照常打字"));
  await shot("alert");

  // 2. 用户点「确定」：页面接着往下跑。
  await card.getByRole("button", { name: "确定" }).click();
  check("用户答了提示，页面接着跑", await ui.waitFor(async () => (await title(app)) === "after-alert"), await title(app));
  check("卡片收起来了", await ui.waitFor(async () => (await card.count()) === 0));

  // 3. Agent 点出一个 confirm，自己用 CDP 答「确定」：卡片随之消失。
  await ui.send([{ tool: "browser_click", args: { handle: "btab-1", uid: uid("弹确认") } }, { echo: true }], "弹窗");
  check("确认卡片出来了", await ui.waitFor(async () => (await card.count()) === 1 && (await card.innerText()).includes("sure?")));
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "handle_dialog", args: { action: "accept" } } }, { echo: true }], "弹窗");
  check("Agent 答了确认，页面拿到的是「确定」", await ui.waitFor(async () => (await title(app)) === "confirm-true"), await title(app));
  check("Agent 答完，面板里的卡片也消失了", await ui.waitFor(async () => (await card.count()) === 0));
  // prompt 不测：Electron 里的网页调用 window.prompt 会直接抛错（Electron 不支持），根本走不到对话框这一步。
}
