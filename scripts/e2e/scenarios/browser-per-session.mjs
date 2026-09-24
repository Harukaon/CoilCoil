export const description = "每个会话一个浏览器，cookie 按挂载文件夹隔离";

const readCookie = { tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "evaluate_script", args: { function: "() => document.cookie" } } };
const labels = async (ui) => (await ui.browserTabs()).map((tab) => tab.label);

export async function run({ ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("a.html?set") } }, { echo: true }], "会话一");
  check("会话一：Agent 打开 a，面板自动打开并只显示 a", JSON.stringify(await labels(ui)) === '["page-a"]', JSON.stringify(await labels(ui)));

  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("b.html") } }, readCookie, { echo: true }], "会话二");
  check("会话二（同文件夹）：面板只显示 b，没有多余的空白页", JSON.stringify(await labels(ui)) === '["page-b"]', JSON.stringify(await labels(ui)));
  const shared = await ui.lastEcho();
  check("会话二：读到会话一写的 cookie（同文件夹共享）", shared.includes("who=a"), shared.slice(0, 160));
  await shot("session-2");

  await ui.openSidebarConversation("会话一");
  check("切回会话一：面板只显示 a，b 没有窜过来", JSON.stringify(await labels(ui)) === '["page-a"]', JSON.stringify(await labels(ui)));

  await ui.newConversation("projB");
  await ui.send([{ tool: "browser_open", args: { url: site.url("c.html") } }, readCookie, { echo: true }], "会话三");
  check("会话三（另一个文件夹）：面板只显示 c", JSON.stringify(await labels(ui)) === '["page-c"]', JSON.stringify(await labels(ui)));
  const isolated = await ui.lastEcho();
  check("会话三：读不到 projA 的 cookie（跨文件夹隔离）", /```json\s*""/.test(isolated) || isolated.includes('""'), isolated.slice(0, 160));
}
