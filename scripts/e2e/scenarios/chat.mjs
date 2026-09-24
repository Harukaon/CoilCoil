export const description = "一轮真实对话：界面 → 运行时 → 模型 → 工具 → 界面";

export async function run({ ui, check, shot }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "read", args: { path: "README.md" } }, { echo: true }], "读文件");
  const echo = await ui.lastEcho();
  check("Agent 调 read 读到了挂载文件夹里的 README", echo.includes("projA"), echo.slice(0, 120));
  await shot("chat");
}
