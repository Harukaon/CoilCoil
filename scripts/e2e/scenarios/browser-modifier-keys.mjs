export const description = "焦点在网页里时按修饰键：单独按 ⌘/⌥/⇧/⌃ 不会被菜单错配（弹「关于」、抢焦点），网页照样收到；网页不认的 ⌘K 什么都不触发，菜单里有的快捷键照常；先按 ⌘ 再 ⌘C 能复制";

const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("form.html"));
  return contents ? contents.executeJavaScript(code) : null;
}, code);

export async function run({ app, page, ui, site, check }) {
  if (process.platform !== "darwin") {
    check("只在 macOS 上有这个问题（菜单按字符匹配快捷键）", true, "SKIP");
    return;
  }
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("form.html") } }, { echo: true }], "按键");
  await ui.waitFor(async () => (await inPage(app, "document.readyState")) === "complete", 15_000);
  await page.waitForTimeout(800);

  // 换成同样结构、但会记账的菜单：「关于」「缩放」没设快捷键（旧问题就是错配到它们），另有一个 ⌘J 的项。
  await app.evaluate(({ Menu }) => {
    globalThis.__menuHits = [];
    const item = (label, accelerator) => ({ label, ...(accelerator ? { accelerator } : {}), click: () => globalThis.__menuHits.push(label) });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "App", submenu: [item("关于"), { role: "quit" }] },
      { role: "editMenu" },
      { label: "Window", submenu: [item("缩放"), item("测试⌘J", "Command+J")] },
    ]));
  });
  const hits = () => app.evaluate(() => globalThis.__menuHits.splice(0));

  await inPage(app, "window.keys=[];addEventListener('keydown',e=>keys.push(e.key));document.querySelector('#q').value='hello world'");
  const box = await page.locator(".browser-live-page").boundingBox();
  const layout = JSON.parse(await inPage(app, "JSON.stringify({ r: document.querySelector('#q').getBoundingClientRect(), w: innerWidth, h: innerHeight })"));
  const scale = Math.min(box.width / layout.w, box.height / layout.h);
  await page.mouse.click(box.x + (layout.r.x + 10) * scale, box.y + (layout.r.y + layout.r.height / 2) * scale);
  await page.waitForTimeout(300);
  check("点进网页后键盘在网页上", await page.evaluate(() => document.activeElement?.classList.contains("browser-live-proxy")));
  await hits();

  const pageKeys = async () => (await inPage(app, "keys.splice(0).join(',')")) ?? "";
  for (const [name, key] of [["⌘", "Meta"], ["⇧", "Shift"], ["⌥", "Alt"], ["⌃", "Control"]]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(500);
    const fired = await hits();
    check(`单独按 ${name}：菜单什么都没触发（以前 ⌘、⌥ 会弹「关于」）`, fired.length === 0, fired.join(","));
    check(`单独按 ${name}：网页照样收到`, (await pageKeys()).includes(key));
  }

  await page.keyboard.press("Meta+K");
  await page.waitForTimeout(500);
  check("网页不认的 ⌘K：菜单什么都没触发", (await hits()).length === 0);
  const gotK = await pageKeys();
  check("⌘K 送到了网页", gotK.toLowerCase().includes("k"), gotK);
  check("⌘K 没往输入框里打字", (await inPage(app, "document.querySelector('#q').value")) === "hello world");

  await page.keyboard.press("Meta+J");
  await page.waitForTimeout(500);
  const menu = await hits();
  check("菜单里有的 ⌘J：照常触发对应的菜单项", menu.length === 1 && menu[0] === "测试⌘J", menu.join(","));
  await pageKeys();

  // 用户原话：想按 ⌘C 复制，先按下 ⌘ 就弹窗，复制不了。
  await app.evaluate(({ clipboard }) => clipboard.writeText("旧内容"));
  await inPage(app, "document.querySelector('#q').select()");
  await page.keyboard.down("Meta");
  await page.waitForTimeout(300);
  await page.keyboard.press("c");
  await page.keyboard.up("Meta");
  await page.waitForTimeout(500);
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  check("先按住 ⌘ 再按 C：复制到了网页里选中的字", copied === "hello world", copied);
  check("整个过程菜单没弹「关于」", !(await hits()).includes("关于"));
}
