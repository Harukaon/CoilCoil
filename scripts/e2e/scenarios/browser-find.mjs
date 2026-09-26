export const description = "页面内查找：⌘F 打开查找栏，打字就找、显示第几处共几处，回车下一处、Shift+回车上一处，Esc 收起后键盘回到页面";

const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("find.html"));
  return contents ? contents.executeJavaScript(code) : undefined;
}, code);

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: site.url("find.html") } }, { echo: true }], "查找");
  await ui.waitFor(async () => (await inPage(app, "document.readyState")) === "complete");
  await page.waitForTimeout(500);
  // 先点进页面（点到输入框上），键盘归页面。
  const box = await page.locator(".browser-live-page").boundingBox();
  const layout = JSON.parse(await inPage(app, "JSON.stringify({ q: document.getElementById('q').getBoundingClientRect(), width: innerWidth, height: innerHeight })"));
  const scale = Math.min(box.width / layout.width, box.height / layout.height);
  await page.mouse.click(box.x + (layout.q.x + 10) * scale, box.y + (layout.q.y + layout.q.height / 2) * scale);

  await page.keyboard.press("ControlOrMeta+F");
  const bar = page.locator(".browser-find-bar");
  check("⌘F 打开了查找栏", await ui.waitFor(async () => (await bar.count()) === 1));
  const input = page.getByRole("textbox", { name: "在网页中查找" });
  check("查找栏的输入框拿到了键盘", await input.evaluate((element) => element === document.activeElement));
  await page.keyboard.type("apple");
  const count = page.locator(".browser-find-count");
  check("打字就找：一共 3 处，现在是第 1 处", await ui.waitFor(async () => (await count.innerText()) === "1/3"), await count.innerText());
  await page.keyboard.press("Enter");
  check("回车：到第 2 处", await ui.waitFor(async () => (await count.innerText()) === "2/3"), await count.innerText());
  await page.keyboard.press("Shift+Enter");
  check("Shift+回车：回到第 1 处", await ui.waitFor(async () => (await count.innerText()) === "1/3"), await count.innerText());
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("durian");
  check("找不到的：显示无结果", await ui.waitFor(async () => (await count.innerText()) === "无结果"), await count.innerText());
  await shot("find");
  await page.keyboard.press("Escape");
  check("Esc 收起查找栏", await ui.waitFor(async () => (await bar.count()) === 0));
  // 找到的字成了页面上的选区（和 Chrome 一样，原来的输入框不再有焦点）；要看的是按键回到了页面。
  await inPage(app, "window.keys = ''");
  await page.keyboard.type("typed");
  check("收起后键盘回到页面：按键进了网页", await ui.waitFor(async () => (await inPage(app, "window.keys")) === "typed"), String(await inPage(app, "window.keys")));
}
