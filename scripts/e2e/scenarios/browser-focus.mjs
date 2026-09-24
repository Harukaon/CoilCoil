export const description = "Agent 操作内置浏览器时，不抢用户在输入框里的焦点";

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("form.html") } }, { echo: true }], "焦点");
  // 点一个不存在的元素，返回里会带上页面快照，从里面拿输入框和按钮的 uid。
  await ui.send([{ tool: "browser_click", args: { handle: "btab-1", uid: "999_999" } }, { echo: true }], "焦点");
  const snapshot = await ui.lastEcho();
  const uid = (pattern) => new RegExp(`uid=(\\S+) ${pattern}`).exec(snapshot)?.[1];
  const input = uid("textbox");
  const button = uid("button");
  check("快照里找得到输入框和按钮", input && button, snapshot.slice(0, 400));

  // 像人一样：在输入框里打字、回车发送，焦点一直留在输入框里。Agent 这一轮在浏览器里
  // 点按钮、往网页输入框里打字。
  const composer = page.locator(".prompt-editor");
  const echoes = await page.getByText("工具返回", { exact: false }).count();
  await composer.click();
  await page.keyboard.insertText(`焦点 MOCK:${JSON.stringify([
    { tool: "browser_click", args: { handle: "btab-1", uid: button } },
    { tool: "browser_type", args: { handle: "btab-1", uid: input, value: "agent typed" } },
    { echo: true },
  ])}`);
  await page.keyboard.press("Enter");
  const focused = () => page.evaluate(() => {
    const element = document.activeElement;
    return { tag: element?.tagName, className: String(element?.className ?? "").slice(0, 60), inComposer: Boolean(element?.closest(".prompt-editor")) };
  });
  check("发送后焦点在输入框里", (await focused()).inComposer, JSON.stringify(await focused()));
  await ui.waitFor(async () => (await page.getByText("工具返回", { exact: false }).count()) > echoes, 60_000);
  const pageValue = () => app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview" && contents.getURL().includes("form.html"));
    return guest?.executeJavaScript("document.querySelector('#q').value");
  });
  check("Agent 在网页输入框里打的字进去了", await ui.waitFor(async () => (await pageValue()) === "agent typed"), String(await pageValue()));
  // Agent 输入那一下焦点得在网页上（不然字进不去），停下来一秒内还回来。
  check("Agent 输入完，焦点回到输入框里", await ui.waitFor(async () => (await focused()).inComposer, 3000), JSON.stringify(await focused()));
  const blurs = await app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview" && contents.getURL().includes("form.html"));
    return guest?.executeJavaScript("window.blurs");
  });
  check("焦点还回来后网页没收到 blur（下拉建议之类不会被收起）", blurs === 0, String(blurs));
  await page.keyboard.type("继续");
  const text = await composer.innerText();
  check("用户接着打的字进了输入框，没跑到网页里", text.includes("继续") && (await pageValue()) === "agent typed", text);

  // 用户自己点进网页里打字，照常能用：守卫只拦「没人要」的焦点切换。
  const box = await page.locator("webview.visible").boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.move(box.x + 60, box.y + 60);
  await app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview" && contents.getURL().includes("form.html"));
    return guest?.executeJavaScript("document.querySelector('#q').select()");
  });
  const rect = await app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview" && contents.getURL().includes("form.html"));
    return guest?.executeJavaScript("JSON.stringify(document.querySelector('#q').getBoundingClientRect())");
  });
  const inputBox = JSON.parse(rect);
  await page.mouse.click(box.x + inputBox.x + inputBox.width / 2, box.y + inputBox.y + inputBox.height / 2);
  await page.keyboard.type("用户");
  check("用户自己点进网页输入框，打的字进网页", await ui.waitFor(async () => String(await pageValue()).includes("用户")), String(await pageValue()));

  // 网页自己加载完自动聚焦输入框：用户在输入框里时不许抢。
  await composer.click();
  const echoes2 = await page.getByText("工具返回", { exact: false }).count();
  await page.keyboard.insertText(`焦点 MOCK:${JSON.stringify([{ tool: "browser_open", args: { url: site.url("autofocus.html") } }, { echo: true }])}`);
  await page.keyboard.press("Enter");
  await ui.waitFor(async () => (await page.getByText("工具返回", { exact: false }).count()) > echoes2, 60_000);
  await page.waitForTimeout(1500);
  check("自动聚焦的网页打开后，焦点还在输入框里", (await focused()).inComposer, JSON.stringify(await focused()));
  await shot("focus");
}
