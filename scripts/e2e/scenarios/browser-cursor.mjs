export const description = "用户在 Agent 共用页上的箭头、手型和文字光标正确，Agent 虚拟鼠标不会改变用户光标";

export async function run({ app, page, ui, site, check }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("cursor.html") } }, { echo: true }], "光标");
  await ui.send([{ tool: "browser_click", args: { handle: "btab-1", uid: "999_999" } }, { echo: true }], "光标");
  const uid = /uid=(\S+) link/.exec(await ui.lastEcho())?.[1];
  check("Agent 找到了网页链接", Boolean(uid));

  const surface = page.locator(".browser-live-input");
  const cursor = () => surface.evaluate((element) => element.style.cursor);
  const box = await surface.boundingBox();
  check("页面画面能被用户操作", Boolean(box));
  const point = (x, y) => ({ x: box.x + x, y: box.y + y });
  const blank = point(box.width - 25, box.height - 25);
  await page.mouse.move(blank.x, blank.y);
  check("空白处是普通箭头，不是小手", await ui.waitFor(async () => (await cursor()) === "default"), await cursor());

  await ui.send([{ tool: "browser_click", args: { handle: "btab-1", uid } }, { echo: true }], "光标");
  check("Agent 点击链接生效", await ui.waitFor(async () => (await app.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find((item) => item.getURL().includes("cursor.html"));
    return contents?.getTitle();
  })) === "clicked"));
  check("Agent 移到链接、点击时，不把用户停在空白处的箭头改成小手", await cursor() === "default", await cursor());

  await page.mouse.move(box.x + 80, box.y + 45);
  check("用户自己移到链接上才变小手", await ui.waitFor(async () => (await cursor()) === "pointer"), await cursor());
  await page.mouse.move(blank.x, blank.y);
  check("用户离开链接又变回箭头", await ui.waitFor(async () => (await cursor()) === "default"), await cursor());
  const text = JSON.parse(await app.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find((item) => item.getURL().includes("cursor.html"));
    return contents.executeJavaScript("JSON.stringify({ rect: document.querySelector('#text').getBoundingClientRect(), width: innerWidth, height: innerHeight })");
  }));
  const scale = Math.min(box.width / text.width, box.height / text.height);
  await page.mouse.move(box.x + (text.rect.x + 12) * scale, box.y + (text.rect.y + text.rect.height / 2) * scale);
  check("用户移到文字上变成文字光标", await ui.waitFor(async () => (await cursor()) === "text"), await cursor());
}
