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
  const frame = page.locator("canvas.browser-live-frame");
  check("面板里显示页面的画面", await ui.waitFor(async () => Boolean(await frame.getAttribute("data-mode").catch(() => null))), String(await frame.getAttribute("data-mode").catch(() => null)));
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
  // 用词中央测悬停光标；行框左边缘 1px 可能还没覆盖实际字形。
  await page.mouse.move(box.x + box.width - 10, box.y + 10);
  await page.mouse.move(from.x + 15 * scale, from.y);
  const cursor = () => page.locator(".browser-live-input").evaluate((element) => element.style.cursor);
  check("鼠标移到文字上，光标变成文字光标", await ui.waitFor(async () => (await cursor()) === "text"), await cursor());
  await page.mouse.move(from.x, from.y);
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

  // 9. 网页下拉框：离屏页面里原生弹层出不来，面板自己画选项，选好写回页面。
  await ui.send([{ tool: "browser_navigate", args: { handle: "btab-1", url: site.url("select.html") } }, { echo: true }], "共用");
  const inSelect = (code) => app.evaluate(({ webContents }, code) => {
    const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("select.html"));
    return contents ? contents.executeJavaScript(code) : undefined;
  }, code);
  await ui.waitFor(async () => (await inSelect("document.readyState")) === "complete");
  await page.waitForTimeout(600);
  const selectBox = await page.locator(".browser-live-page").boundingBox();
  const selectRect = JSON.parse(await inSelect("JSON.stringify(document.querySelector('#s').getBoundingClientRect())"));
  const selectAt = { x: selectBox.x + selectRect.x + 20, y: selectBox.y + selectRect.y + selectRect.height / 2 };
  const picker = page.locator(".browser-select-picker");
  await page.mouse.click(selectAt.x, selectAt.y);
  check("点下拉框，面板画出选项列表", await ui.waitFor(async () => (await picker.count()) === 1), String(await picker.count()));
  check("列表里有分组、有选项，当前选中的是香蕉", (await picker.innerText()).includes("水果") && (await picker.locator("[aria-selected=true]").innerText()).includes("香蕉"));
  await picker.getByRole("option", { name: "苹果" }).click();
  check("选了苹果：页面收到 change，值写回去了", await ui.waitFor(async () => (await inSelect("document.title")) === "changed-a"), await inSelect("document.title"));
  check("列表收起来了", await ui.waitFor(async () => (await picker.count()) === 0));
  await page.mouse.click(selectAt.x, selectAt.y);
  await ui.waitFor(async () => (await picker.count()) === 1);
  // 键盘：往下两格跳过不能选的榴莲，回车选葡萄。
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  check("键盘上下选、回车确定，跳过不能选的", await ui.waitFor(async () => (await inSelect("document.querySelector('#s').value")) === "d"), await inSelect("document.querySelector('#s').value"));
  await page.mouse.click(selectAt.x, selectAt.y);
  await ui.waitFor(async () => (await picker.count()) === 1);
  await page.mouse.click(selectBox.x + selectBox.width - 20, selectBox.y + selectBox.height - 20);
  check("点别处只是收起列表，值不变", await ui.waitFor(async () => (await picker.count()) === 0) && (await inSelect("document.querySelector('#s').value")) === "d");
  await ui.waitFor(() => page.locator(".browser-live-proxy").evaluate((element) => element === document.activeElement));
  await page.keyboard.press("Space");
  check("键盘也能打开当前下拉框", await ui.waitFor(async () => (await picker.count()) === 1));
  await composer.click();
  await page.keyboard.type("菜单关闭后继续聊");
  check("下拉框打开时点回聊天，不把光标抢回网页", await focused() && (await composer.innerText()).includes("菜单关闭后继续聊"));
  check("焦点离开后菜单收起", await ui.waitFor(async () => (await picker.count()) === 0));

  // 菜单开着时网页自身变化：旧选项不能落到新的选项上。
  await page.mouse.click(selectAt.x, selectAt.y);
  await ui.waitFor(async () => (await picker.count()) === 1);
  await inSelect("document.querySelector('#s').options[0].value = 'not-apple'");
  await picker.getByRole("option", { name: "苹果" }).click();
  check("网页改过选项后，旧菜单不会写错值", await inSelect("document.querySelector('#s').value") === "d");

  // 长列表可以滚动，不会被画面层拦下滚轮。
  await inSelect("document.querySelector('#s').replaceChildren(...Array.from({length:60},(_,i)=>new Option('选项 '+i,String(i))))");
  await page.mouse.click(selectAt.x, selectAt.y);
  await ui.waitFor(async () => (await picker.count()) === 1);
  const menuBox = await picker.boundingBox();
  await page.mouse.move(menuBox.x + 40, menuBox.y + 45);
  await page.mouse.wheel(0, 420);
  check("长下拉列表可以滚动", await ui.waitFor(() => picker.evaluate((element) => element.scrollTop > 100)));
  await page.keyboard.press("Escape");
  await ui.waitFor(async () => (await picker.count()) === 0);

  // 放大后的页面仍能准确命中下拉框。
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((item) => item.getURL().includes("select.html")).setZoomFactor(1.5));
  await page.waitForTimeout(400);
  const zoomLayout = JSON.parse(await inSelect("JSON.stringify({rect:document.querySelector('#s').getBoundingClientRect(),width:innerWidth,height:innerHeight})"));
  const zoomScale = Math.min(selectBox.width / zoomLayout.width, selectBox.height / zoomLayout.height);
  await page.mouse.click(selectBox.x + (zoomLayout.rect.x + 20) * zoomScale, selectBox.y + (zoomLayout.rect.y + 10) * zoomScale);
  check("页面放大后仍可点开下拉框", await ui.waitFor(async () => (await picker.count()) === 1));
  await shot("select");
  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((item) => item.getURL().includes("select.html")).loadURL(url), site.url("form.html"));
  check("网页跳转后旧菜单立即消失", await ui.waitFor(async () => (await picker.count()) === 0));
}
