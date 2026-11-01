export const description = "网页主体已显示、只是图片等资源超过 10 秒还没下完：打开和导航都不报超时失败";

export async function run({ ui, site, check }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser", args: { action: "call", tool: "open", args: { url: site.url("slow-load.html") } } }, { echo: true }], "慢页面");
  let echo = await ui.lastEcho();
  check("打开慢资源页面：报已打开并给句柄，不报失败", echo.includes("已打开") && echo.includes("btab-1") && !echo.includes("打开失败"), echo.slice(0, 200));
  check("打开后回执里已经有页面内容", echo.includes("Slow but ready"), echo.slice(0, 300));
  await ui.send([{ tool: "browser", args: { action: "call", tool: "click", args: { handle: "btab-1", uid: "1_2" } } }, { echo: true }], "慢页面");
  await ui.send([{ tool: "browser", args: { action: "call", tool: "navigate", args: { handle: "btab-1", url: site.url("slow-load-next.html") } } }, { echo: true }], "慢页面");
  echo = await ui.lastEcho();
  check("导航到慢资源页面：报导航完成，不报失败", echo.includes("导航完成") && !echo.includes("导航失败"), echo.slice(0, 200));
  check("导航回执带着新页面内容", echo.includes("Second slow page"), echo.slice(0, 300));
  await ui.waitFor(async () => (await ui.browserTabs()).some((tab) => tab.label === "slow-load-next"));
  check("没有因为误报再开出多余的页", (await ui.browserTabs()).length === 1, JSON.stringify(await ui.browserTabs()));
}
