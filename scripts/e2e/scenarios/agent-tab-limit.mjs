export const description = "Agent 标签页只留最近用过的 5 张，用户的不动，标签条上分得开";

export async function run({ page, ui, site, check, shot }) {
  // 用户的鼠标就停在面板上：Agent 每开一张，画面上都有鼠标经过。经过不算「用户用过」，
  // 不能因此让这张页面免收（以前算，鼠标一晃上限就失效了）。
  const hoverPanel = async () => {
    const box = await page.locator(".browser-live-page").boundingBox();
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 8);
  };
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.typeAddress(site.url("u.html"));
  await ui.waitFor(async () => (await ui.browserTabs()).some((tab) => tab.label === "u"));
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "list_pages" } }, { echo: true }], "回收");
  for (const name of ["p1", "p2", "p3", "p4", "p5"]) {
    await ui.send([{ tool: "browser_open", args: { url: site.url(`${name}.html`) } }, { echo: true }], "回收");
    await hoverPanel();
  }
  const five = await ui.browserTabs();
  check("开满 5 张：用户页 + 5 张 Agent 页都在", five.length === 6, JSON.stringify(five));
  check("用户自己开的 u 没有 Agent 标识", five.find((tab) => tab.label === "u")?.agent === false);
  check("Agent 开的都带 Agent 标识", five.filter((tab) => tab.label.startsWith("p")).every((tab) => tab.agent));
  await shot("five");

  // 先用一下最老的 p1，它就不再是最久没用的。
  await ui.send([{ tool: "browser_navigate", args: { handle: "btab-1", url: site.url("p1.html") } }, { echo: true }], "回收");
  await ui.send([{ tool: "browser_open", args: { url: site.url("p6.html") } }, { echo: true }], "回收");
  const six = (await ui.browserTabs()).map((tab) => tab.label);
  check("第 6 张：p1 刚用过，收掉的是最久没用的 p2", six.includes("p1") && !six.includes("p2") && six.includes("u"), JSON.stringify(six));
  const echo6 = await ui.lastEcho();
  check("工具返回里写明回收了哪张（id + url）", /id=\d+ 的标签页，url 是：\S*p2\.html/.test(echo6), echo6.slice(0, 200));

  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "new_page", args: { url: site.url("p7.html") } } }, { echo: true }], "回收");
  const seven = await ui.browserTabs();
  check("走 mcp new_page 开第 7 张：p3 被收掉，Agent 页仍是 5 张", !seven.some((tab) => tab.label === "p3") && seven.filter((tab) => tab.agent).length === 5, JSON.stringify(seven.map((tab) => tab.label)));
  const echo7 = await ui.lastEcho();
  check("mcp 这条路的返回里也有回收提示", /id=\d+ 的标签页，url 是：\S*p3\.html/.test(echo7), echo7.slice(0, 200));
  await shot("seven");
}
