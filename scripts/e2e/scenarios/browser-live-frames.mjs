export const description = "开着 GPU：面板里的页面画面走共享纹理，一秒约 60 帧、画的就是当前页面；新开、切换标签，收起再展开、拖宽面板、最小化再恢复后，画面照常跟上";
export const launchOptions = { gpu: true };

const frame = (page) => page.locator("canvas.browser-live-frame");

/** 面板画面正中间的颜色（在 App 窗口里直接读画布）。 */
const centerColor = (page) => frame(page).evaluate((canvas) => {
  if (!canvas.width || !canvas.height) return undefined;
  const [r, g, b] = canvas.getContext("2d").getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
  return [r, g, b];
}).catch(() => undefined);

const sameColor = (rgb, hex) => Array.isArray(rgb) && [0, 2, 4].every((offset, index) => Math.abs(rgb[index] - parseInt(hex.slice(offset, offset + 2), 16)) < 24);

/** 连续取画面正中间的颜色，数一秒里变了几次：测试页每一帧换一种颜色，变几次就是面板画了几帧。 */
const measureFps = (page, ms = 2000) => page.evaluate(async (ms) => {
  const canvas = document.querySelector("canvas.browser-live-frame");
  const context = canvas.getContext("2d");
  let last = "";
  let changes = 0;
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      const [r, g, b] = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      const key = `${r},${g},${b}`;
      if (key !== last) { changes += 1; last = key; }
      if (performance.now() - start < ms) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  return Math.round(changes / (ms / 1000));
}, ms);

/** 帧率不够时看是哪一段慢：页面自己一秒画几帧、App 窗口一秒刷新几次。 */
const diagnose = async (app, page) => {
  const pageFps = await app.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("anim.html"));
    return contents?.executeJavaScript("new Promise((done) => { let n = 0; const start = performance.now(); const tick = () => { n += 1; if (performance.now() - start < 1000) requestAnimationFrame(tick); else done(n); }; requestAnimationFrame(tick); })");
  });
  const windowFps = await page.evaluate(() => new Promise((done) => {
    let n = 0;
    const start = performance.now();
    const tick = () => { n += 1; if (performance.now() - start < 1000) requestAnimationFrame(tick); else done(n); };
    requestAnimationFrame(tick);
  }));
  const focused = await app.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getFocusedWindow()));
  return `页面自己 ${pageFps} 帧/秒，App 窗口刷新 ${windowFps} 次/秒，App 窗口在前台：${focused}；${await offscreenState(app)}；日志：${logs.join(" | ") || "无"}`;
};

/** 离屏页面现在多大、设的帧率是多少。 */
const offscreenState = (app) => app.evaluate(({ webContents, BrowserWindow }) => webContents.getAllWebContents()
  .filter((item) => !item.isDestroyed() && item.isOffscreen())
  .map((item) => `${new URL(item.getURL()).pathname} ${BrowserWindow.fromWebContents(item)?.getContentSize().join("x")} ${item.getFrameRate()}帧`)
  .join("，"));

/** 主进程打出来的浏览器日志（画面降级、纹理没还之类），失败时一起给出来。 */
const logs = [];

const onMainWindow = (app, action) => app.evaluate(({ BrowserWindow }, action) => {
  const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && !item.webContents.isOffscreen());
  if (action === "minimize") window.minimize();
  if (action === "restore") { window.restore(); window.show(); window.focus(); }
}, action);

export async function run({ app, page, ui, site, check, shot }) {
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) if (line.includes("[browser]")) logs.push(line.trim().slice(0, 160));
    });
  }
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await onMainWindow(app, "restore");
  await ui.send([{ tool: "browser_open", args: { url: site.url("anim.html") } }, { echo: true }], "画面");
  const mode = () => frame(page).getAttribute("data-mode").catch(() => null);
  check("开着 GPU 时，面板画面走共享纹理", await ui.waitFor(async () => (await mode()) === "texture", 20_000), String(await mode()));
  const fps = await measureFps(page);
  check(`一直在动的页面，面板里一秒画 45 帧以上（实测 ${fps} 帧）`, fps >= 45, fps >= 45 ? "" : await diagnose(app, page));
  await shot("anim");

  const color = (hex) => `${site.url("color.html")}?c=${hex}`;
  await ui.send([{ tool: "browser_navigate", args: { handle: "btab-1", url: color("2266aa") } }, { echo: true }], "画面");
  check("跳到纯色页，面板画的就是这个颜色", await ui.waitFor(async () => sameColor(await centerColor(page), "2266aa")), JSON.stringify(await centerColor(page)));
  const canvasSize = () => frame(page).evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
  const panelSize = await page.locator(".browser-live-page").boundingBox();
  const size = await canvasSize();
  check("画面按屏幕像素画，放大不糊", size.width >= Math.round(panelSize.width) - 2, `${JSON.stringify(size)} vs 面板 ${Math.round(panelSize.width)}`);

  // 新开第二张（另一种颜色）：面板切过去画它；点回第一张，画回第一张。
  await ui.send([{ tool: "browser_open", args: { url: color("aa3322") } }, { echo: true }], "画面");
  check("新开的标签页，面板画的是它", await ui.waitFor(async () => sameColor(await centerColor(page), "aa3322")), JSON.stringify(await centerColor(page)));
  await page.locator(".inspector-tab-select").first().click();
  check("点回第一张标签页，画面换回它", await ui.waitFor(async () => sameColor(await centerColor(page), "2266aa")), JSON.stringify(await centerColor(page)));

  // 收起右侧栏；收起期间 AI 把页面换成绿色（那些帧没人看、都还掉了）；再展开：页面静止不动，
  // 面板也要主动要来一帧，画的是绿色，不是收起前的旧画面。
  await page.getByRole("button", { name: "收起右侧栏" }).click();
  await page.waitForTimeout(600);
  await app.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.isOffscreen() && item.getURL().includes("c=2266aa"));
    return contents?.executeJavaScript("document.body.style.background = document.getElementById('b').style.background = '#33aa55'");
  });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "展开作业栏" }).click();
  check("收起期间页面变了，展开后画的是新样子（不是旧画面）", await ui.waitFor(async () => sameColor(await centerColor(page), "33aa55") && (await mode()) === "texture"), JSON.stringify(await centerColor(page)));

  // 拖宽面板：页面跟着变大，画面也跟着变大，还是这一页。右侧栏刚展开时还在做展开动画，
  // 分隔条在动，等它停稳再按，不然按空。
  const resizer = page.locator(".right-resizer");
  let handle = await resizer.boundingBox();
  await ui.waitFor(async () => {
    await page.waitForTimeout(120);
    const next = await resizer.boundingBox();
    const settled = Boolean(handle && next && Math.abs(next.x - handle.x) < 0.5);
    handle = next;
    return settled;
  });
  const before = await canvasSize();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 160, handle.y + handle.height / 2, { steps: 12 });
  await page.mouse.up();
  const grown = await ui.waitFor(async () => (await canvasSize()).width > before.width + 100);
  const dragInfo = grown ? "" : await page.evaluate((at) => {
    const hit = document.elementFromPoint(at.x, at.y);
    const panel = document.querySelector(".browser-live-page")?.getBoundingClientRect();
    return JSON.stringify({ hit: hit ? `${hit.tagName}.${hit.className}` : null, at, window: innerWidth, panel: panel?.width });
  }, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }) + `；${await offscreenState(app)}；日志：${logs.join(" | ") || "无"}`;
  check("拖宽面板后，画面跟着变大", grown, `${JSON.stringify(before)} -> ${JSON.stringify(await canvasSize())} ${dragInfo}`);
  check("拖宽后画的还是这一页", sameColor(await centerColor(page), "33aa55"), JSON.stringify(await centerColor(page)));

  // 最小化再恢复：画面照常。
  await onMainWindow(app, "minimize");
  await page.waitForTimeout(1500);
  await onMainWindow(app, "restore");
  check("最小化再恢复，画面照常", await ui.waitFor(async () => sameColor(await centerColor(page), "33aa55") && (await mode()) === "texture"), JSON.stringify(await centerColor(page)));

  // 回到动画页：来回折腾之后帧率照旧，没有纹理卡住没还。
  await ui.send([{ tool: "browser_navigate", args: { handle: "btab-1", url: site.url("anim.html") } }, { echo: true }], "画面");
  await ui.waitFor(async () => !sameColor(await centerColor(page), "33aa55"));
  const after = await measureFps(page);
  check(`来回折腾之后，一秒照样画 45 帧以上（实测 ${after} 帧）`, after >= 45, after >= 45 ? "" : await diagnose(app, page));
  await shot("after");
}
