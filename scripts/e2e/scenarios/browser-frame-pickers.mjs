export const description = "跨站内嵌页（另一个进程，像付款表单）里的下拉框和颜色框：用户点了照样在面板里弹列表、选择器，选的值写进内嵌页并照常发 input/change，用完不在网页里留东西";

/** 在外层页面或跨站内嵌页里跑一段脚本。 */
const inFrame = (app, which, code) => app.evaluate(({ webContents }, { which, code }) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("frames.html"));
  if (!contents) return undefined;
  const frame = which === "outer" ? contents.mainFrame : contents.mainFrame.frames[0];
  return frame ? frame.executeJavaScript(code) : undefined;
}, { which, code });

export async function run({ app, page, ui, site, check }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: site.url("frames.html") } }, { echo: true }], "内嵌页");
  await ui.waitFor(async () => (await inFrame(app, "inner", "document.readyState")) === "complete", 10_000);
  await page.waitForTimeout(500);
  const separate = await app.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("frames.html"));
    const inner = contents?.mainFrame.frames[0];
    return Boolean(inner && inner.url.includes("127.0.0.1") && inner.processId !== contents.mainFrame.processId);
  });
  check("内嵌页是跨站的，在另一个进程里", separate);

  const box = await page.locator(".browser-live-page").boundingBox();
  const outer = JSON.parse(await inFrame(app, "outer", `JSON.stringify({ f: document.getElementById("f").getBoundingClientRect(), width: innerWidth, height: innerHeight })`));
  const inner = JSON.parse(await inFrame(app, "inner", `JSON.stringify({ s: document.getElementById("country").getBoundingClientRect(), c: document.getElementById("color").getBoundingClientRect() })`));
  const scale = Math.min(box.width / outer.width, box.height / outer.height);
  const border = 4;
  const at = (rect) => ({ x: box.x + (outer.f.x + border + rect.x + rect.width / 2) * scale, y: box.y + (outer.f.y + border + rect.y + rect.height / 2) * scale });
  const takeLog = async () => JSON.parse(await inFrame(app, "inner", "JSON.stringify(log.splice(0))"));
  const leftovers = () => inFrame(app, "inner", `Object.getOwnPropertyNames(window).filter((name) => name.startsWith("__coilcoil")).length`);

  // 1. 下拉框：面板里弹出选项列表，选「日本」写进内嵌页。
  const select = at(inner.s);
  await page.mouse.click(select.x, select.y);
  const picker = page.locator(".browser-select-picker");
  check("点内嵌页里的下拉框：面板弹出了选项列表", await ui.waitFor(async () => (await picker.count()) === 1, 3000));
  const labels = await picker.getByRole("option").allInnerTexts().catch(() => []);
  check("列表里是内嵌页下拉框的选项", JSON.stringify(labels.map((label) => label.trim())) === JSON.stringify(["中国", "美国", "日本"]), JSON.stringify(labels));
  const pickerBox = await picker.boundingBox();
  const selectTop = box.y + (outer.f.y + border + inner.s.y) * scale;
  check("列表弹在内嵌页下拉框的位置附近", Boolean(pickerBox) && Math.abs(pickerBox.y - (selectTop + inner.s.height * scale)) < 40, JSON.stringify({ pickerBox, selectTop }));
  await picker.getByRole("option", { name: "日本" }).click();
  let log = [];
  await ui.waitFor(async () => { log = log.concat(await takeLog()); return log.includes("country:change:jp"); }, 3000);
  check("选的写进了内嵌页的下拉框", (await inFrame(app, "inner", `document.getElementById("country").value`)) === "jp", JSON.stringify(log));
  check("内嵌页照常收到 input 和 change", log.includes("country:input:jp") && log.includes("country:change:jp"), JSON.stringify(log));
  check("用完不在内嵌页里留东西", await ui.waitFor(async () => (await leftovers()) === 0, 2000));

  // 2. 颜色框：面板打开颜色选择器，选的颜色写进内嵌页（测试里替系统颜色面板发一次「选了红色」）。
  const color = at(inner.c);
  await page.mouse.click(color.x, color.y);
  const valuePicker = page.locator(".browser-value-picker");
  check("点内嵌页里的颜色框：打开了颜色选择器", await ui.waitFor(async () => (await valuePicker.count()) === 1, 3000));
  await valuePicker.evaluate((input) => {
    input.value = "#ff0000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  log = [];
  await ui.waitFor(async () => { log = log.concat(await takeLog()); return log.includes("color:change:#ff0000"); }, 3000);
  check("选的颜色写进了内嵌页，照常收到 input 和 change", log.includes("color:input:#ff0000") && log.includes("color:change:#ff0000"), JSON.stringify(log));
  check("颜色选完也不在内嵌页里留东西", await ui.waitFor(async () => (await leftovers()) === 0, 2000));
}
