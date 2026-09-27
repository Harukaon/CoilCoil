import { keepAppWindowUncovered } from "../system-focus.mjs";

export const description = "耗电：页面静止时不出帧；只有用户正看着的那张每秒几十帧，别的标签页、面板收起、窗口最小化、App 隐藏、窗口被别的窗口完全挡住时降到每秒约 1 帧，恢复后立刻回到流畅";
export const launchOptions = { gpu: true };

/** 数一张离屏页面在 ms 毫秒里出了几帧（主进程里挂个只计数的 paint 监听）。 */
const countPaints = (app, match, ms) => app.evaluate(async ({ webContents }, { match, ms }) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.isOffscreen() && item.getURL().includes(match));
  if (!contents) return -1;
  let count = 0;
  const onPaint = () => { count += 1; };
  contents.on("paint", onPaint);
  await new Promise((resolve) => setTimeout(resolve, ms));
  contents.off("paint", onPaint);
  return count;
}, { match, ms });

/** 页面自己的动画一秒跑几次（requestAnimationFrame）：跑得越少越省电。 */
const pageRafPerSecond = (app, match) => app.evaluate(({ webContents }, match) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.isOffscreen() && item.getURL().includes(match));
  return contents?.executeJavaScript("new Promise((done) => { let n = 0; const start = performance.now(); const tick = () => { n += 1; if (performance.now() - start < 2000) requestAnimationFrame(tick); else done(Math.round(n / 2)); }; requestAnimationFrame(tick); })");
}, match);

/**
 * 这段时间里网页进程加起来每秒唤醒几次（macOS 上最能看出耗电的数），仅供参考。两次取数之间的
 * 平均值：先取一次打底，隔一会儿再取。（CPU 百分比在离屏页面上读出来总是 0，不可靠，不看它。）
 */
const pageCost = async (app, ms) => {
  const sample = () => app.evaluate(({ app, webContents }) => {
    const pids = new Set(webContents.getAllWebContents().filter((item) => !item.isDestroyed() && item.isOffscreen()).map((item) => item.getOSProcessId()));
    let wakeups = 0;
    for (const metric of app.getAppMetrics()) {
      if (pids.has(metric.pid) && Number.isFinite(metric.cpu?.idleWakeupsPerSecond)) wakeups += metric.cpu.idleWakeupsPerSecond;
    }
    return `每秒唤醒 ${Math.round(wakeups)} 次`;
  });
  await sample();
  await new Promise((resolve) => setTimeout(resolve, ms));
  return sample();
};

/** 盖一个更高一层的窗口把 App 窗口整个挡住（不抢焦点）；on 为 false 时拿走。 */
const cover = (app, on) => app.evaluate(({ BrowserWindow }, on) => {
  if (!on) {
    globalThis.__cover?.destroy();
    globalThis.__cover = undefined;
    return;
  }
  const main = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && !item.webContents.isOffscreen());
  const bounds = main.getBounds();
  const window = new BrowserWindow({ x: bounds.x - 40, y: bounds.y - 40, width: bounds.width + 80, height: bounds.height + 80, show: false, frame: false, backgroundColor: "#888888" });
  window.setAlwaysOnTop(true, "screen-saver");
  window.showInactive();
  globalThis.__cover = window;
}, on);

const onMainWindow = (app, action) => app.evaluate(({ app, BrowserWindow }, action) => {
  const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && !item.webContents.isOffscreen());
  if (action === "minimize") window.minimize();
  if (action === "hide") window.hide();
  if (action === "restore") { window.restore(); window.show(); window.focus(); }
}, action);

export async function run({ app, page, ui, site, check }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await onMainWindow(app, "restore");
  const release = await keepAppWindowUncovered(app);
  const color = `${site.url("color.html")}?c=2266aa`;

  // 1. 静止的页面：画好以后不再出帧。
  await ui.send([{ tool: "browser_open", args: { url: color } }, { echo: true }], "耗电");
  await page.waitForTimeout(1500);
  const still = await countPaints(app, "color.html", 3000);
  check(`静止的页面 3 秒里几乎不出帧（${still} 帧）`, still >= 0 && still <= 6, String(still));

  // 2. 一直在动、用户正看着：流畅（对照）。
  await ui.send([{ tool: "browser_navigate", args: { handle: "btab-1", url: site.url("anim.html") } }, { echo: true }], "耗电");
  await page.waitForTimeout(1000);
  const watched = await countPaints(app, "anim.html", 2000);
  check(`正看着的动画页 2 秒出 90 帧以上（${watched} 帧）`, watched >= 90, String(watched));
  console.log(`INFO  正看着动画页时，网页进程 ${await pageCost(app, 2000)}`);

  // 3. 新开一张静止页，动画页退到后台标签：每秒约 1 帧，页面自己的动画也跟着慢下来。
  await ui.send([{ tool: "browser_open", args: { url: color } }, { echo: true }], "耗电");
  await page.waitForTimeout(1000);
  const background = await countPaints(app, "anim.html", 3000);
  check(`后台标签里的动画页 3 秒最多出 6 帧（${background} 帧）`, background >= 0 && background <= 6, String(background));
  const backgroundRaf = await pageRafPerSecond(app, "anim.html");
  check(`后台标签里页面自己的动画一秒最多跑 3 次（${backgroundRaf} 次）`, typeof backgroundRaf === "number" && backgroundRaf <= 3, String(backgroundRaf));
  console.log(`INFO  动画页在后台标签时，网页进程 ${await pageCost(app, 2000)}`);

  // 4. 切回动画页，再收起右侧栏：没人看，降下来。
  await page.locator(".inspector-tab-select").first().click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "收起右侧栏" }).click();
  await page.waitForTimeout(1000);
  const collapsed = await countPaints(app, "anim.html", 3000);
  check(`右侧栏收起时动画页 3 秒最多出 6 帧（${collapsed} 帧）`, collapsed >= 0 && collapsed <= 6, String(collapsed));
  await page.getByRole("button", { name: "展开作业栏" }).click();
  await page.waitForTimeout(1000);

  // 5. 窗口最小化、App 隐藏：也没人看。
  await onMainWindow(app, "minimize");
  await page.waitForTimeout(1000);
  const minimized = await countPaints(app, "anim.html", 3000);
  check(`窗口最小化时动画页 3 秒最多出 6 帧（${minimized} 帧）`, minimized >= 0 && minimized <= 6, String(minimized));
  await onMainWindow(app, "restore");
  await page.waitForTimeout(800);
  await onMainWindow(app, "hide");
  await page.waitForTimeout(1000);
  const hidden = await countPaints(app, "anim.html", 3000);
  check(`App 窗口隐藏时动画页 3 秒最多出 6 帧（${hidden} 帧）`, hidden >= 0 && hidden <= 6, String(hidden));

  // 6. 恢复：马上回到流畅。
  await onMainWindow(app, "restore");
  await page.waitForTimeout(1000);
  const back = await countPaints(app, "anim.html", 2000);
  check(`恢复以后又是流畅的（2 秒 ${back} 帧）`, back >= 90, String(back));

  // 7. 被别的窗口整个挡住（用户切去别的软件、全屏盖住了）：也没人看；拿开就回来。
  await cover(app, true);
  await page.waitForTimeout(1500);
  const covered = await countPaints(app, "anim.html", 3000);
  console.log(`INFO  窗口被挡住时，网页进程 ${await pageCost(app, 2000)}`);
  await cover(app, false);
  check(`窗口被别的窗口整个挡住时动画页 3 秒最多出 6 帧（${covered} 帧）`, covered >= 0 && covered <= 6, String(covered));
  await page.waitForTimeout(1500);
  const uncovered = await countPaints(app, "anim.html", 2000);
  check(`挡住的窗口拿开以后又是流畅的（2 秒 ${uncovered} 帧）`, uncovered >= 90, String(uncovered));
  await release();
}
