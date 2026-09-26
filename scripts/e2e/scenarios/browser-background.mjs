export const description = "AI 在后台照常干活：窗口最小化、应用隐藏、右侧栏收起时，AI 跳到另一个网站后照样能截图、能点";

/** 同一个测试站点换一个主机名：localhost 和 127.0.0.1 是两个网站，跳过去要换渲染进程。 */
const colorUrl = (site, host, color) => `${site.url("color.html").replace("localhost", host)}?c=${color}`;

/** 主进程里找到那张纯色测试页（离屏页面）。 */
const findPage = `(webContents) => webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("color.html"))`;

/**
 * 在主进程里直接给那张页面截一张图，取正中间一个点的颜色。
 *
 * 截图前后都不碰窗口：窗口最小化、应用隐藏着也照这样截，截不出来（超时）或者颜色
 * 还是上一个页面的，就说明后台跳转之后页面没在画。
 */
const sampleColor = (app) => app.evaluate(async ({ webContents, nativeImage }, findPage) => {
  const contents = eval(findPage)(webContents);
  if (!contents) return { ok: false, why: "找不到页面" };
  const data = await Promise.race([
    contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" }).then((result) => result.data, (error) => ({ error: String(error) })),
    new Promise((resolve) => setTimeout(() => resolve({ error: "截图超时" }), 8000)),
  ]);
  if (typeof data !== "string") return { ok: false, why: data.error, url: contents.getURL() };
  const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  return { ok: true, rgb: [bitmap[at + 2], bitmap[at + 1], bitmap[at]], url: contents.getURL(), size: [width, height] };
}, findPage);

const sameColor = (rgb, hex) => Array.isArray(rgb) && [0, 2, 4].every((offset, index) => Math.abs(rgb[index] - parseInt(hex.slice(offset, offset + 2), 16)) < 24);

/** 和 Agent 一样用 CDP 点一下页面正中间，再读标题：点到了标题会变。 */
const clickPage = (app) => app.evaluate(async ({ webContents }, findPage) => {
  const contents = eval(findPage)(webContents);
  if (!contents) return "找不到页面";
  const at = { x: 120, y: 120, button: "left", clickCount: 1 };
  const send = (params) => Promise.race([
    contents.debugger.sendCommand("Input.dispatchMouseEvent", params),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("点击超时")), 8000)),
  ]);
  try {
    await send({ type: "mousePressed", ...at });
    await send({ type: "mouseReleased", ...at });
  } catch (error) {
    return String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  return contents.getTitle();
}, findPage);

/** App 窗口（不是那些隐藏的离屏页面窗口）。 */
const onMainWindow = (app, action) => app.evaluate(({ BrowserWindow, app: electronApp }, action) => {
  const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && !item.webContents.isOffscreen());
  if (action === "minimize") window.minimize();
  if (action === "restore") { window.restore(); window.focus(); }
  if (action === "hide") electronApp.hide();
  if (action === "show") { electronApp.show(); window.show(); window.focus(); }
  return window.isMinimized();
}, action);

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: colorUrl(site, "localhost", "2266aa") } }, { echo: true }], "后台");
  const first = await sampleColor(app);
  check("AI 打开了纯色测试页，截图是这个页面", first.ok && sameColor(first.rgb, "2266aa"), JSON.stringify(first));

  const states = [
    {
      name: "窗口最小化",
      host: "127.0.0.1",
      color: "aa3322",
      enter: () => onMainWindow(app, "minimize"),
      leave: () => onMainWindow(app, "restore"),
    },
    ...process.platform === "darwin" ? [{
      name: "应用隐藏",
      host: "localhost",
      color: "33aa55",
      enter: () => onMainWindow(app, "hide"),
      leave: () => onMainWindow(app, "show"),
    }] : [],
    {
      name: "右侧栏收起",
      host: process.platform === "darwin" ? "127.0.0.1" : "localhost",
      color: "8844cc",
      enter: () => page.getByRole("button", { name: "收起右侧栏" }).click(),
      leave: () => page.getByRole("button", { name: "展开作业栏" }).click(),
    },
  ];

  for (const state of states) {
    const echoes = await page.getByText("工具返回", { exact: false }).count();
    // 先把消息发出去，剧本第一步让 Agent 等几秒，这几秒里把窗口收起来：接下来的跳转、
    // 截图全都发生在后台。窗口收起来以后没法再在界面上点发送。
    await page.locator(".prompt-editor").click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(`后台 MOCK:${JSON.stringify([
      { tool: "bash", args: { command: "sleep 3" } },
      { tool: "browser_navigate", args: { handle: "btab-1", url: colorUrl(site, state.host, state.color) } },
      { tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "take_screenshot" } },
      { echo: true },
    ])}`);
    await page.getByRole("button", { name: "发送消息" }).click();
    await state.enter();
    const replied = await ui.waitFor(async () => (await page.getByText("工具返回", { exact: false }).count()) > echoes, 90_000);
    const echo = replied ? await ui.lastEcho() : "";
    check(`${state.name}：AI 跳到另一个网站后，截图工具照常返回`, replied && /screenshot/i.test(echo) && !/timed? ?out|超时|error/i.test(echo), echo.slice(0, 240));
    const sampled = await sampleColor(app);
    check(`${state.name}：截到的是跳转后的新页面`, sampled.ok && sameColor(sampled.rgb, state.color), JSON.stringify(sampled));
    const title = await clickPage(app);
    check(`${state.name}：AI 点击照常生效`, title === `clicked-${state.host}`, title);
    await state.leave();
    await page.waitForTimeout(800);
  }
  await shot("after");
}
