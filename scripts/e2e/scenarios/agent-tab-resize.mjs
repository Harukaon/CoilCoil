export const description = "Agent 的标签页跟着面板变大小：拉宽/缩窄窗口后画面铺满，不留白边";

/** Agent 离屏页面现在的内容尺寸（主进程里按网址找那个离屏窗口）。 */
const offscreenSize = (app) => app.evaluate(({ BrowserWindow }) => {
  const page = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.webContents.getType() === "offscreen" && win.webContents.getURL().includes("form.html"));
  if (!page) return undefined;
  const [width, height] = page.getContentSize();
  return { width, height };
});

/** 面板里放 Agent 画面的那块区域有多大。 */
const viewSize = (page) => page.locator(".browser-live-page").evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { width: Math.round(rect.width), height: Math.round(rect.height) };
});

const resizeWindow = (app, delta) => app.evaluate(({ BrowserWindow }, delta) => {
  const win = BrowserWindow.getAllWindows().find((item) => item.isVisible());
  const [width, height] = win.getSize();
  win.setSize(width + delta, height);
}, delta);

const sameSize = (a, b) => Boolean(a && b) && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("form.html") } }, { echo: true }], "尺寸");
  const frame = page.locator("canvas.browser-live-frame");
  // 画布的像素大小跟着页面大小走：页面换了尺寸，新画面到了，画布大小就变。
  const frameSize = () => frame.evaluate((canvas) => `${canvas.width}x${canvas.height}`).catch(() => "");
  check("面板里显示 Agent 页面的画面", await ui.waitFor(async () => Boolean(await frame.getAttribute("data-mode").catch(() => null))));
  check("一开始离屏页面和面板一样大", await ui.waitFor(async () => sameSize(await offscreenSize(app), await viewSize(page))),
    JSON.stringify({ offscreen: await offscreenSize(app), view: await viewSize(page) }));

  for (const [label, delta] of [["缩窄", -480], ["拉宽", 480]]) {
    const before = await viewSize(page);
    const drawn = await frameSize();
    await resizeWindow(app, delta);
    check(`${label}窗口后面板确实变了`, await ui.waitFor(async () => (await viewSize(page)).width !== before.width), JSON.stringify(await viewSize(page)));
    check(`${label}窗口后离屏页面跟着变成面板大小`, await ui.waitFor(async () => sameSize(await offscreenSize(app), await viewSize(page))),
      JSON.stringify({ offscreen: await offscreenSize(app), view: await viewSize(page) }));
    check(`${label}窗口后界面收到了新尺寸的画面`, await ui.waitFor(async () => (await frameSize()) !== drawn), `${drawn} -> ${await frameSize()}`);
    await shot(label);
  }
}
