export const description = "网页的日期、时间、颜色框：点小日历图标（或颜色框）打开 App 窗口里 Chromium 自己的选择器，选的值写回页面并照常发 input/change；点在年月日上、图标被藏起来时不弹；Alt+↓ 能打开、Esc 关掉不改值";

const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("pickers.html"));
  return contents ? contents.executeJavaScript(code) : undefined;
}, code);
const takeLog = async (app) => JSON.parse(await inPage(app, "JSON.stringify(log.splice(0))"));

export async function run({ app, page, ui, site, check }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: site.url("pickers.html") } }, { echo: true }], "选择器");
  await ui.waitFor(async () => (await inPage(app, "document.readyState")) === "complete");
  await page.waitForTimeout(500);
  const box = await page.locator(".browser-live-page").boundingBox();
  const layout = JSON.parse(await inPage(app, `JSON.stringify(Object.fromEntries(["d", "t", "c", "h"].map((id) => [id, document.getElementById(id).getBoundingClientRect()]).concat([["size", { width: innerWidth, height: innerHeight }]])))`));
  const scale = Math.min(box.width / layout.size.width, box.height / layout.size.height);
  const at = (rect, dx) => ({ x: box.x + (dx >= 0 ? rect.x + dx : rect.right + dx) * scale, y: box.y + (rect.y + rect.height / 2) * scale });
  const click = async (point) => page.mouse.click(point.x, point.y);
  const picker = page.locator(".browser-value-picker");
  const pickerOpen = () => picker.evaluate((input) => input.matches(":open")).catch(() => false);
  const focusedInPage = () => inPage(app, "document.activeElement && document.activeElement.id");

  // 1. 点在年月日上：和 Chrome 一样只是改那一格，不弹选择器。
  await click(at(layout.d, 20));
  await page.waitForTimeout(400);
  check("点在日期框的年月日上：不弹选择器", (await picker.count()) === 0);
  check("点在日期框的年月日上：焦点进了日期框", (await focusedInPage()) === "d", String(await focusedInPage()));

  // 2. 点小日历图标：打开 Chromium 自己的日历，方向键加回车选下一天，写回页面。
  await click(at(layout.d, -12));
  check("点小日历图标：面板打开了日期选择器", await ui.waitFor(async () => (await picker.count()) === 1 && await pickerOpen(), 3000));
  check("选择器是日期类型、带着页面上的值", await picker.evaluate((input) => input.type === "date" && input.value === "2026-09-26").catch(() => false));
  // 日历是 Chromium 贴着这个隐形输入框下沿弹的小窗口（实测真实屏幕上就在它正下方）；这里查隐形框
  // 正盖在网页的日期框上。Playwright 的截图会把弹出小窗口画在左上角，别拿截图判断位置。
  const expected = { x: box.x + layout.d.x * scale, y: box.y + layout.d.y * scale, width: layout.d.width * scale };
  const actual = await picker.boundingBox();
  check("隐形的选择器输入框正盖在网页的日期框上", Boolean(actual) && Math.abs(actual.x - expected.x) <= 2 && Math.abs(actual.y - expected.y) <= 2
    && Math.abs(actual.width - expected.width) <= 2, JSON.stringify({ actual, expected }));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  let log = [];
  await ui.waitFor(async () => { log = log.concat(await takeLog(app)); return log.includes("d:change:2026-09-27"); }, 3000);
  check("选了下一天：页面的日期变成 2026-09-27", (await inPage(app, "document.getElementById('d').value")) === "2026-09-27", JSON.stringify(log));
  check("页面照常收到 input 和 change", log.includes("d:input:2026-09-27") && log.includes("d:change:2026-09-27"), JSON.stringify(log));
  check("选完选择器收起", await ui.waitFor(async () => (await picker.count()) === 0, 3000));

  // 3. 时间框：小时钟图标打开时间选择器，↑ 加回车改值。
  await click(at(layout.t, -12));
  check("点时间框的小图标：打开了时间选择器", await ui.waitFor(async () => (await picker.count()) === 1 && await pickerOpen(), 3000));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  log = [];
  await ui.waitFor(async () => { log = log.concat(await takeLog(app)); return log.some((line) => line.startsWith("t:change:")); }, 3000);
  const time = await inPage(app, "document.getElementById('t').value");
  check("时间改了并写回页面", time !== "09:30" && log.some((line) => line === `t:change:${time}`), `${time} ${JSON.stringify(log)}`);

  // 4. 颜色框：点哪儿都打开系统颜色面板（测试里没法点面板，替它发一次「选了红色」）。
  await click(at(layout.c, 20));
  check("点颜色框：打开了颜色选择器", await ui.waitFor(async () => (await picker.count()) === 1 && await pickerOpen(), 3000));
  check("颜色选择器带着页面上的颜色", await picker.evaluate((input) => input.type === "color" && input.value === "#336699").catch(() => false));
  await picker.evaluate((input) => {
    input.value = "#ff0000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  log = [];
  await ui.waitFor(async () => { log = log.concat(await takeLog(app)); return log.includes("c:change:#ff0000"); }, 3000);
  check("选的颜色写回页面，照常收到 input 和 change", log.includes("c:input:#ff0000") && log.includes("c:change:#ff0000"), JSON.stringify(log));
  check("颜色选完选择器收起", await ui.waitFor(async () => (await picker.count()) === 0, 3000));

  // 5. 网页把小日历图标藏起来了：点右边也不弹（和 Chrome 一样）。
  await click(at(layout.h, -12));
  await page.waitForTimeout(400);
  check("图标被藏起来的日期框：不弹选择器", (await picker.count()) === 0);

  // 6. 键盘：焦点在日期框里按 Alt+↓ 打开，Esc 关掉，值不变、键盘回到页面。
  await click(at(layout.d, 20));
  await page.waitForTimeout(300);
  await page.keyboard.press("Alt+ArrowDown");
  check("Alt+↓ 打开日期选择器", await ui.waitFor(async () => (await picker.count()) === 1 && await pickerOpen(), 3000));
  await page.keyboard.press("Escape");
  check("Esc 关掉选择器", await ui.waitFor(async () => (await picker.count()) === 0, 3000));
  await takeLog(app);
  check("Esc 关掉后日期没变", (await inPage(app, "document.getElementById('d').value")) === "2026-09-27");
  check("关掉后键盘回到页面", await page.evaluate(() => document.activeElement?.classList.contains("browser-live-proxy")));
}
