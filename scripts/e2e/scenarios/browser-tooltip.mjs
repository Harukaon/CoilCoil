export const description = "网页的悬停提示（title）：鼠标停住一会儿，面板在鼠标下面画出提示；子元素用外层的提示、title 为空的不出、SVG 用里面的 <title>、换行照留；鼠标一动、一按就收起";

const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.isOffscreen() && item.getURL().includes("tooltip.html"));
  return contents ? contents.executeJavaScript(code) : undefined;
}, code);

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: site.url("tooltip.html") } }, { echo: true }], "提示");
  await ui.waitFor(async () => (await inPage(app, "document.readyState")) === "complete");
  await page.waitForTimeout(500);
  const box = await page.locator(".browser-live-page").boundingBox();
  const layout = JSON.parse(await inPage(app, `JSON.stringify(Object.fromEntries(["save", "inner", "blank", "icon", "lines", "none"].map((id) => [id, document.getElementById(id).getBoundingClientRect()]).concat([["size", { width: innerWidth, height: innerHeight }]])))`));
  const scale = Math.min(box.width / layout.size.width, box.height / layout.size.height);
  const center = (rect) => ({ x: box.x + (rect.x + rect.width / 2) * scale, y: box.y + (rect.y + rect.height / 2) * scale });
  const tooltip = page.locator(".browser-page-tooltip");
  const text = () => tooltip.innerText().catch(() => null);
  const hover = async (rect) => {
    const at = center(rect);
    await page.mouse.move(at.x - 20, at.y - 3);
    await page.mouse.move(at.x, at.y, { steps: 3 });
    return at;
  };
  const shows = async (expected) => ui.waitFor(async () => (await text()) === expected, 3000);
  const staysHidden = async () => {
    await page.waitForTimeout(1200);
    return (await tooltip.count()) === 0;
  };

  const at = await hover(layout.save);
  check("停在带 title 的元素上：出提示", await shows("保存文件"), String(await text()));
  const tip = await tooltip.boundingBox();
  check("提示在鼠标下面、画面里面", Boolean(tip) && tip.y > at.y && tip.x >= box.x && tip.x + tip.width <= box.x + box.width + 1, JSON.stringify({ tip, at }));
  await shot("tooltip");
  await page.mouse.move(at.x + 1, at.y + 1);
  await page.waitForTimeout(300);
  check("手抖一两个像素：提示不收", (await text()) === "保存文件");

  await hover(layout.none);
  check("挪到没有提示的地方：提示收起、不再出", await staysHidden());
  await hover(layout.inner);
  check("子元素没写 title：用外层的提示", await shows("外层提示"), String(await text()));
  await hover(layout.blank);
  check("title 是空的：挡住外层，不出提示", await staysHidden());
  await hover(layout.icon);
  check("SVG 图标：用里面的 <title>", await shows("红色方块"), String(await text()));
  await hover(layout.lines);
  check("提示里的换行照留", await shows("第一行\n第二行"), JSON.stringify(await text()));

  const again = await hover(layout.save);
  await shows("保存文件");
  await page.mouse.down();
  check("按下鼠标：提示收起", await ui.waitFor(async () => (await tooltip.count()) === 0, 2000));
  await page.mouse.up();
  await page.mouse.move(again.x + 30, again.y + 30);
}
