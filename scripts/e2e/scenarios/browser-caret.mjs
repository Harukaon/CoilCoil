export const description = "输入法候选框跟着页面里的光标：点进输入框、打字、方向键、Tab 到下一个输入框、多行文本框换行、可编辑区域、输入法输完一段字后，面板里接键盘的隐形输入框都挪到页面光标处；点到不能打字的地方就留在点的位置";

const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("caret.html"));
  return contents ? contents.executeJavaScript(code) : undefined;
}, code);

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: site.url("caret.html") } }, { echo: true }], "光标");
  await ui.waitFor(async () => (await inPage(app, "document.readyState")) === "complete");
  await page.waitForTimeout(500);
  const box = await page.locator(".browser-live-page").boundingBox();
  const size = JSON.parse(await inPage(app, "JSON.stringify({ width: innerWidth, height: innerHeight })"));
  const scale = Math.min(box.width / size.width, box.height / size.height);
  const proxy = page.locator(".browser-live-proxy");
  const proxyAt = () => proxy.evaluate((element) => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top) }));
  // 一个元素内容区的左上角（页面坐标）。
  const contentOf = async (id) => JSON.parse(await inPage(app, `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return JSON.stringify({ left: r.left + el.clientLeft + parseFloat(s.paddingLeft), top: r.top + el.clientTop + parseFloat(s.paddingTop) });
  })()`));
  // 让页面真的排一段同样字体的字来量宽（和实现里用画布量是两种办法）。
  const widthOf = async (id, text) => Number(await inPage(app, `(() => {
    const span = document.createElement("span");
    span.style.font = getComputedStyle(document.getElementById(${JSON.stringify(id)})).font;
    span.style.whiteSpace = "pre";
    span.textContent = ${JSON.stringify(text)};
    document.body.append(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width;
  })()`));
  const near = async (expected, label) => {
    let last;
    const ok = await ui.waitFor(async () => {
      last = await proxyAt();
      return Math.abs(last.x - expected.x * scale) <= 3 && Math.abs(last.y - expected.y * scale) <= 3;
    }, 4000);
    check(label, ok, `隐形输入框在 (${last?.x}, ${last?.y})，页面光标在 (${(expected.x * scale).toFixed(1)}, ${(expected.y * scale).toFixed(1)})`);
  };
  const click = (x, y) => page.mouse.click(box.x + x * scale, box.y + y * scale);

  const single = await contentOf("single");
  await click(single.left + 200, single.top + 12);
  await near({ x: single.left, y: single.top }, "点进空输入框（点在中间）：挪到输入框开头的光标处");
  await page.keyboard.type("hello world");
  await ui.waitFor(async () => (await inPage(app, "document.getElementById('single').value")) === "hello world");
  await near({ x: single.left + await widthOf("single", "hello world"), y: single.top }, "打字：跟到光标的新位置");
  for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowLeft");
  await near({ x: single.left + await widthOf("single", "hello "), y: single.top }, "方向键挪光标：跟着挪");

  await page.keyboard.press("Tab");
  const multi = await contentOf("multi");
  await near({ x: multi.left, y: multi.top }, "Tab 到下一个输入框：跟过去");
  await page.keyboard.type("line one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await near({ x: multi.left + await widthOf("multi", "second"), y: multi.top + 24 }, "多行文本框换行：跟到第二行");

  const editor = await contentOf("editor");
  const editorWidth = await widthOf("editor", "hello editor");
  await click(editor.left + editorWidth + 60, editor.top + 12);
  await near({ x: editor.left + editorWidth, y: editor.top }, "点进可编辑区域：跟到光标");

  // 输入法输完一段字：页面里光标往后挪了这段字的宽度，下一段的候选框从新位置出。
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "你好" });
  const typed = await ui.waitFor(async () => (await inPage(app, "document.getElementById('editor').textContent")) === "hello editor你好");
  check("输入法的字进了页面", typed, String(await inPage(app, "document.getElementById('editor').textContent")));
  await near({ x: editor.left + await widthOf("editor", "hello editor你好"), y: editor.top }, "输入法输完一段字：跟到字后面");
  await shot("caret");

  // 点到不能打字的地方：没有光标，留在点的位置（和以前一样）。
  await click(300, 400);
  const blank = await ui.waitFor(async () => {
    const at = await proxyAt();
    return Math.abs(at.x - 300 * scale) <= 2 && Math.abs(at.y - 400 * scale) <= 2;
  }, 3000);
  await page.waitForTimeout(300);
  const still = await proxyAt();
  check("点到空白处：留在点的位置", blank && Math.abs(still.x - 300 * scale) <= 2 && Math.abs(still.y - 400 * scale) <= 2, JSON.stringify(still));
}
