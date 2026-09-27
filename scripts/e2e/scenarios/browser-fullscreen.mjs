import { checkAppWindowFocused } from "../system-focus.mjs";

export const description = "网页请求全屏（视频的全屏按钮）按约定忽略：Agent 点、用户点都不进全屏；藏着的网页窗口不会冒出来占满屏幕，焦点还在用户那边";

const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.isOffscreen() && item.getURL().includes("fullscreen.html"));
  return contents ? contents.executeJavaScript(code) : undefined;
}, code);

/** 那张网页的窗口：看得见吗、全屏了吗。 */
const pageWindow = (app) => app.evaluate(({ BrowserWindow, webContents }) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.isOffscreen() && item.getURL().includes("fullscreen.html"));
  const window = contents && BrowserWindow.fromWebContents(contents);
  return window ? JSON.stringify({ visible: window.isVisible(), fullScreen: window.isFullScreen() }) : "none";
});
const HIDDEN = JSON.stringify({ visible: false, fullScreen: false });

export async function run({ app, page, ui, site, check }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: site.url("fullscreen.html") } }, { echo: true }], "全屏");
  await ui.waitFor(async () => (await inPage(app, "document.readyState")) === "complete");
  await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => !item.webContents.isOffscreen());
    app.focus({ steal: true });
    window?.show();
    window?.focus();
  });

  // 1. Agent 点网页上的全屏按钮：用户在对话框里，什么都不该变。
  await ui.send([{ tool: "browser_click", args: { handle: "btab-1", uid: "999_999" } }, { echo: true }], "全屏");
  const uid = /uid=(\S+) button "全屏播放"/.exec(await ui.lastEcho())?.[1];
  check("快照里找得到全屏按钮", Boolean(uid));
  // 在对话框里按回车发出去（ui.send 点的是发送按钮，焦点会落在按钮上）：看 Agent 点完以后焦点还在不在对话框。
  const composer = page.locator(".prompt-editor");
  const echoes = await page.getByText("工具返回", { exact: false }).count();
  await composer.click();
  await page.keyboard.insertText(`全屏 MOCK:${JSON.stringify([{ tool: "browser_click", args: { handle: "btab-1", uid } }, { echo: true }])}`);
  await page.keyboard.press("Enter");
  await ui.waitFor(async () => (await page.getByText("工具返回", { exact: false }).count()) > echoes, 60_000);
  await page.waitForTimeout(1500);
  check("Agent 点了全屏：网页没进全屏", (await inPage(app, "Boolean(document.fullscreenElement)")) === false);
  check("Agent 点了全屏：网页窗口没有冒出来，也没有全屏", (await pageWindow(app)) === HIDDEN, await pageWindow(app));
  await checkAppWindowFocused(app, check, "App 窗口还是当前窗口");
  check("焦点还在对话框里", await page.evaluate(() => Boolean(document.activeElement?.closest(".prompt-editor"))));

  // 2. 用户自己在面板里点全屏：一样忽略，窗口照样藏着。
  const box = await page.locator(".browser-live-page").boundingBox();
  const layout = JSON.parse(await inPage(app, "JSON.stringify({ go: document.getElementById('go').getBoundingClientRect(), width: innerWidth, height: innerHeight })"));
  const scale = Math.min(box.width / layout.width, box.height / layout.height);
  await page.mouse.click(box.x + (layout.go.x + layout.go.width / 2) * scale, box.y + (layout.go.y + layout.go.height / 2) * scale);
  await page.waitForTimeout(1500);
  check("用户点了全屏：网页没进全屏", (await inPage(app, "Boolean(document.fullscreenElement)")) === false);
  check("用户点了全屏：网页窗口没有冒出来", (await pageWindow(app)) === HIDDEN, await pageWindow(app));
  check("点完键盘还在面板上", await page.evaluate(() => document.activeElement?.classList.contains("browser-live-proxy")));
}
