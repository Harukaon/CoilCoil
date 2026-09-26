export const description = "用户和 Agent 共用同一个页面：Agent 点击打字不抢用户焦点；用户直接在画面上点、打字、全选、用输入法，页面不刷新，Agent 接着用同一个页面";

/** 主进程里找到装着 form.html 的那个页面，在里面跑一段脚本。 */
const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("form.html"));
  return contents ? contents.executeJavaScript(code).then((value) => ({ type: contents.getType(), value })) : { type: "none" };
}, code);

const inputValue = async (app) => (await inPage(app, "document.querySelector('#q').value")).value;

/**
 * 页面上的输入框在面板画面里的哪个位置。
 *
 * 画面按页面比例贴在面板左上角，页面和面板一样大时一比一；这里照同样的规则换算，
 * 用户点画面上的输入框，就是点页面上的输入框。
 */
async function inputOnScreen(app, page) {
  const box = await page.locator(".browser-live-page").boundingBox();
  const layout = (await inPage(app, "JSON.stringify({ rect: document.querySelector('#q').getBoundingClientRect(), width: innerWidth, height: innerHeight })")).value;
  const { rect, width, height } = JSON.parse(layout);
  const scale = Math.min(box.width / width, box.height / height);
  return { x: box.x + (rect.x + rect.width - 6) * scale, y: box.y + (rect.y + rect.height / 2) * scale };
}

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("form.html") } }, { echo: true }], "共用");
  const opened = await inPage(app, "1");
  check("Agent 开的页面是离屏页面", opened.type === "offscreen", JSON.stringify(opened));
  await ui.send([{ tool: "browser_click", args: { handle: "btab-1", uid: "999_999" } }, { echo: true }], "共用");
  const snapshot = await ui.lastEcho();
  const input = /uid=(\S+) textbox/.exec(snapshot)?.[1];
  const button = /uid=(\S+) button/.exec(snapshot)?.[1];
  check("快照里找得到输入框和按钮", input && button, snapshot.slice(0, 300));

  // 1. 用户在对话框里打字、回车发送；Agent 这一轮在网页里点按钮、往输入框里打字。焦点一直在对话框。
  const composer = page.locator(".prompt-editor");
  const focused = () => page.evaluate(() => Boolean(document.activeElement?.closest(".prompt-editor")));
  const echoes = await page.getByText("工具返回", { exact: false }).count();
  await composer.click();
  await page.keyboard.insertText(`共用 MOCK:${JSON.stringify([
    { tool: "browser_click", args: { handle: "btab-1", uid: button } },
    { tool: "browser_type", args: { handle: "btab-1", uid: input, value: "agent typed" } },
    { echo: true },
  ])}`);
  await page.keyboard.press("Enter");
  await ui.waitFor(async () => (await page.getByText("工具返回", { exact: false }).count()) > echoes, 60_000);
  check("Agent 点的按钮生效了", (await inPage(app, "document.title")).value === "clicked");
  check("Agent 打的字进了网页", await inputValue(app) === "agent typed");
  check("整个过程焦点一直在对话框里", await focused());
  await page.keyboard.type("我接着打");
  check("用户接着打的字进了对话框", (await composer.innerText()).includes("我接着打"));

  // 2. 面板里是这张页面的画面，没有「接管」，地址栏、前进后退照常能用。
  const frame = page.locator("img.browser-live-frame");
  check("面板里显示页面的画面", await ui.waitFor(async () => ((await frame.getAttribute("src").catch(() => null)) ?? "").startsWith("blob:")));
  check("没有「接管」按钮了", (await page.getByRole("button", { name: "接管这个页面" }).count()) === 0);
  check("地址栏不再是只读的", !(await page.getByRole("textbox", { name: "网页地址" }).evaluate((element) => element.readOnly)));
  const tabs = await ui.browserTabs();
  check("标签条上带 Agent 标识", tabs.length === 1 && tabs[0].agent, JSON.stringify(tabs));
  const loadedAt = (await inPage(app, "performance.timeOrigin")).value;
  await shot("shared");

  // 3. 用户直接点画面上的输入框，接着往里打字：字进了网页，页面没刷新。
  const target = await inputOnScreen(app, page);
  await page.mouse.click(target.x, target.y);
  check("点了页面以后，键盘归页面：对话框失焦", !(await focused()));
  await page.keyboard.press("End");
  await page.keyboard.type(" user");
  check("用户在画面上打的字进了网页，接在 Agent 打的字后面", await ui.waitFor(async () => await inputValue(app) === "agent typed user"), await inputValue(app));
  check("用户打字的时候对话框里没有多出字", !(await composer.innerText()).includes(" user"));

  // 4. 全选再打字：Mac 上 ⌘A 要带上编辑命令才全选得了。
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("x");
  check("全选后打字，整段被替换", await ui.waitFor(async () => await inputValue(app) === "x"), await inputValue(app));

  // 5. 输入法：组字过程送进页面，上屏的是汉字。
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.imeSetComposition", { text: "ni hao", selectionStart: 6, selectionEnd: 6 });
  await cdp.send("Input.insertText", { text: "你好" });
  check("输入法上屏的字进了网页", await ui.waitFor(async () => await inputValue(app) === "x你好"), await inputValue(app));
  check("用户操作了半天，页面一次都没刷新", (await inPage(app, "performance.timeOrigin")).value === loadedAt);

  // 6. 用户点回对话框：键盘回到对话框，页面不再收字。
  await composer.click();
  await page.keyboard.type("回来了");
  check("点回对话框后，字进对话框", (await composer.innerText()).includes("回来了"));
  check("点回对话框后，网页不再收字", await inputValue(app) === "x你好", await inputValue(app));

  // 7. Agent 接着用同一个页面：读得到用户打的字，也还能接着打。
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "evaluate_script", args: { function: "() => document.querySelector('#q').value" } } }, { echo: true }], "共用");
  check("Agent 读到了用户打的字", (await ui.lastEcho()).includes("x你好"), (await ui.lastEcho()).slice(0, 240));
  await ui.send([{ tool: "browser_type", args: { handle: "btab-1", uid: input, value: "agent again" } }, { echo: true }], "共用");
  check("Agent 接着在同一个页面上打字", await ui.waitFor(async () => await inputValue(app) === "agent again"), await inputValue(app));
  check("自始至终是同一次加载的页面", (await inPage(app, "performance.timeOrigin")).value === loadedAt);
  check("还是只有一张标签页", (await ui.browserTabs()).length === 1, JSON.stringify(await ui.browserTabs()));
  await shot("after");

  // 8. 鼠标：拖着选中文字、双击选一个词、滚轮翻页，都和直接在浏览器里一样。
  await ui.send([{ tool: "browser_navigate", args: { handle: "btab-1", url: site.url("long.html") } }, { echo: true }], "共用");
  const inLong = (code) => app.evaluate(({ webContents }, code) => {
    const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("long.html"));
    return contents ? contents.executeJavaScript(code) : undefined;
  }, code);
  await ui.waitFor(async () => (await inLong("document.readyState")) === "complete");
  await page.waitForTimeout(600);
  const box = await page.locator(".browser-live-page").boundingBox();
  const size = JSON.parse(await inLong("JSON.stringify({ width: innerWidth, height: innerHeight, rect: document.querySelector('#p').getBoundingClientRect() })"));
  const scale = Math.min(box.width / size.width, box.height / size.height);
  const at = (x, y) => ({ x: box.x + x * scale, y: box.y + y * scale });
  const line = size.rect.y + size.rect.height / 2;
  const from = at(size.rect.x + 1, line);
  const to = at(size.rect.x + size.rect.width * 0.35, line);
  await page.mouse.move(from.x, from.y);
  const cursor = () => page.locator(".browser-live-input").evaluate((element) => element.style.cursor);
  check("鼠标移到文字上，光标变成文字光标", await ui.waitFor(async () => (await cursor()) === "text"), await cursor());
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  const dragged = await inLong("getSelection().toString()");
  check("拖着选中了一段文字", typeof dragged === "string" && dragged.startsWith("alpha") && dragged.length > 5, JSON.stringify(dragged));
  const word = at(size.rect.x + size.rect.width * 0.5, line);
  await page.mouse.dblclick(word.x, word.y);
  check("双击选中一个词", await ui.waitFor(async () => /^(gamma|delta|beta)$/.test((await inLong("getSelection().toString().trim()")) ?? "")), JSON.stringify(await inLong("getSelection().toString()")));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  check("滚轮往下翻，页面往下走", await ui.waitFor(async () => (await inLong("scrollY")) > 100), String(await inLong("scrollY")));
}
