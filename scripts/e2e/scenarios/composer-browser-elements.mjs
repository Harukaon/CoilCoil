export const description = "从浏览器点选网页元素插进输入框：插在光标处、光标跟在后面；编号只往上加不重名；剪切粘贴、删掉后撤销，元素和截图都还在";

const inPage = (app, marker, code) => app.evaluate(({ webContents }, [marker, code]) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes(marker));
  return contents ? contents.executeJavaScript(code) : null;
}, [marker, code]);

function helpers({ app, page, ui }) {
  const composer = page.locator(".prompt-editor");
  /** 输入框里的样子：文字原样，元素写成 [名字]，空元素写成 [空]。 */
  const shape = () => composer.evaluate((root) => {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out.push(child.textContent);
        else if (child.classList?.contains("prompt-editor-element")) out.push(`[${child.textContent || "空"}]`);
        else if (child.nodeName === "BR") { if (!child.classList.contains("ProseMirror-trailingBreak")) out.push("⏎"); }
        else walk(child);
      }
    };
    walk(root);
    return out.join("");
  });
  const screenshots = () => page.locator(".composer-images figure").count();
  const pickButton = () => page.getByRole("button", { name: "选择网页元素", exact: true });
  /** 像用户一样：点工具栏的「选择网页元素」，再点网页上的标题。 */
  const pick = async () => {
    await ui.waitFor(async () => (await pickButton().count()) === 1 && await pickButton().isEnabled(), 10_000);
    const box = await page.locator(".browser-live-page").boundingBox();
    const layout = JSON.parse(await inPage(app, "form.html", "JSON.stringify({ rect: document.querySelector('h1').getBoundingClientRect(), width: innerWidth, height: innerHeight })"));
    const scale = Math.min(box.width / layout.width, box.height / layout.height);
    const target = { x: box.x + (layout.rect.x + 10) * scale, y: box.y + (layout.rect.y + layout.rect.height / 2) * scale };
    const before = await page.locator(".prompt-editor-element").count();
    await pickButton().click();
    await page.waitForTimeout(400);
    await page.mouse.move(target.x, target.y);
    await page.waitForTimeout(200);
    await page.mouse.click(target.x, target.y);
    await ui.waitFor(async () => (await page.locator(".prompt-editor-element").count()) > before, 10_000);
    await page.waitForTimeout(400);
  };
  /** 把光标放到输入框第 n 个文字节点的第 offset 个字后面（用户点在那儿）。 */
  const caretInText = (index, offset) => composer.evaluate((root, [index, offset]) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest(".prompt-editor-element") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let node = walker.nextNode();
    for (let i = 0; i < index && node; i += 1) node = walker.nextNode();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, [index, offset]);
  /** 把光标放到第 n 个元素后面。 */
  const caretAfterElement = (index) => composer.evaluate((root, index) => {
    const chip = root.querySelectorAll(".prompt-editor-element")[index];
    const range = document.createRange();
    range.setStartAfter(chip);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, index);
  const clear = async () => {
    await composer.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
  };
  return { composer, shape, screenshots, pick, caretInText, caretAfterElement, clear };
}

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("form.html") } }, { echo: true }], "元素");
  await ui.waitFor(async () => Boolean(await inPage(app, "form.html", "document.readyState === 'complete'")), 15_000);
  await page.waitForTimeout(800);
  const t = helpers({ app, page, ui });
  await t.clear();
  await page.keyboard.insertText("看");

  // 1. 连续点 5 个，每次点完直接接着打字：元素插在光标处，光标跟在元素后面。
  for (let i = 1; i <= 5; i += 1) {
    await t.pick();
    await page.keyboard.insertText(`字${i}`);
  }
  const five = "看[元素一]字1[元素二]字2[元素三]字3[元素四]字4[元素五]字5";
  check("连续插 5 个元素、每次接着打字：位置和顺序都对，编号一到五", await t.shape() === five, await t.shape());
  check("5 个元素 5 张截图", await t.screenshots() === 5, String(await t.screenshots()));

  // 2. 光标放到中间（「看」后面）再点：插在那里，接着打的字也在那里。
  await t.caretInText(0, 1);
  await page.waitForTimeout(200);
  await t.pick();
  await page.keyboard.insertText("中");
  const six = `看[元素六]中${five.slice(1)}`;
  check("光标在中间时，新元素插在光标处，编号接着往上是元素六", await t.shape() === six, await t.shape());
  await shot("inserted");

  // 3. 全选、剪切、再粘贴回来：元素原样回来（不变成空的），再点一个是元素七。
  await t.composer.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+X");
  await page.waitForTimeout(300);
  check("剪切后输入框空了", await t.shape() === "", await t.shape());
  await page.keyboard.press("ControlOrMeta+V");
  await page.waitForTimeout(400);
  check("粘贴回来：六个元素原样回来，没有空的", await t.shape() === six, await t.shape());
  await page.keyboard.press("End");
  await t.pick();
  check("粘贴后再点一个：编号是元素七，前面的元素都还在", await t.shape() === `${six}[元素七]`, await t.shape());
  check("截图一张没丢（7 张）", await t.screenshots() === 7, String(await t.screenshots()));

  // 4. 删掉一个元素再撤销：它作为元素回来，不是一段普通文字。
  await t.caretAfterElement(2); // 元素二
  await page.waitForTimeout(150);
  await page.keyboard.press("Backspace");
  const withoutTwo = `${six}[元素七]`.replace("[元素二]", "");
  check("Backspace 删掉元素二", await t.shape() === withoutTwo, await t.shape());
  await page.keyboard.press("ControlOrMeta+Z");
  await page.waitForTimeout(300);
  check("撤销：元素二作为元素回来", await t.shape() === `${six}[元素七]`, await t.shape());

  // 5. 删掉中间的元素三，再点一个：编号是元素八，不会出现两个元素七/元素三。
  await t.caretAfterElement(3); // 元素三
  await page.waitForTimeout(150);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await page.keyboard.press("End");
  await t.pick();
  const labels = await page.locator(".prompt-editor-element").allTextContents();
  check("删掉中间一个再插：新元素叫元素八，名字没有重复", labels.at(-1) === "元素八" && new Set(labels).size === labels.length, labels.join(","));

  // 6. 新对话（还没发过消息），用户自己开网页再点选：光标也跟在元素后面，编号从元素一开始。
  await ui.newConversation("projB");
  await page.waitForTimeout(500);
  await ui.openBrowserPanel();
  await ui.typeAddress(site.url("form.html"));
  await ui.waitFor(async () => Boolean(await inPage(app, "form.html", "document.readyState === 'complete'")), 15_000);
  await page.waitForTimeout(800);
  await t.clear();
  await page.keyboard.insertText("看");
  for (let i = 1; i <= 3; i += 1) {
    await t.pick();
    await page.keyboard.insertText(`字${i}`);
  }
  check("新对话里：编号从元素一开始，每次打的字都跟在新元素后面",
    await t.shape() === "看[元素一]字1[元素二]字2[元素三]字3", await t.shape());
}
