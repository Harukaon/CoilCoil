export const description = "子 Agent 拿得到 mcp 和 terminal，但用不了内置浏览器";

export async function run({ ui, check, gatewayLog }) {
  await ui.newConversation("projA");
  const child = [
    { tool: "mcp", args: { action: "list" } },
    { tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "list_pages" } },
    { echo: true },
  ];
  await ui.send([{ tool: "subagent", args: { agent: "explore", task: `子代理任务 MOCK:${JSON.stringify(child)}` } }, { echo: true }], "派子代理");
  const echo = await ui.lastEcho();
  check("子 Agent 点名调用浏览器被拒绝", echo.includes("不能使用内置浏览器"), echo.slice(0, 200));
  const childRequests = gatewayLog().filter((entry) => /子 Agent/.test(entry.systemTail ?? ""));
  const tools = [...new Set(childRequests.flatMap((entry) => entry.tools))];
  check("子 Agent 拿到 mcp 和 terminal", tools.includes("mcp") && tools.includes("terminal"), tools.join(","));
  check("子 Agent 没有 browser_* 工具", tools.length > 0 && !tools.some((tool) => tool.startsWith("browser_")), tools.join(","));
  const listed = childRequests.find((entry) => entry.last.role === "tool");
  check("子 Agent 的 mcp list 里没有 coilcoil-browser", Boolean(listed) && !listed.last.text.includes("coilcoil-browser"), listed?.last.text.slice(0, 120));
}
