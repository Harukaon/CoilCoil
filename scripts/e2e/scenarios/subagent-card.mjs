export const description = "后台子 Agent 的完成通知是卡片，不把报告和内部信息铺在聊天里";

export async function run({ page, check, shot }) {
  await page.getByRole("button", { name: "在 projA 中新建对话" }).click();
  const child = [{ tool: "read", args: { path: "README.md" } }, { text: "## 侦察报告\n\n结论：README 只有一行标题。" }];
  await page.locator(".prompt-editor").click();
  await page.keyboard.insertText(`后台子代理 MOCK:${JSON.stringify([
    { tool: "subagent", args: { agent: "explore", task: `看一下 README MOCK:${JSON.stringify(child)}`, background: true } },
    { text: "已经派发子代理在后台侦察。" },
    { text: "收到子代理的报告。" },
  ])}`);
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.getByText("收到子代理的报告", { exact: false }).first().waitFor({ timeout: 90_000 });
  const transcript = await page.locator("main").innerText();
  check("聊天里不再出现 runId 和会话文件路径", !/runId|会话文件/.test(transcript));
  const card = page.locator(".subagent-notice");
  await card.first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  const cards = await card.allInnerTexts();
  check("完成通知是一张卡片", cards.length === 1 && cards[0].includes("子 Agent explore 已完成"), JSON.stringify(cards));
  check("报告默认收起", (await card.locator(".subagent-notice-report").count()) === 0);
  await page.getByRole("button", { name: "查看子 Agent 报告" }).click();
  check("点开后是渲染好的报告", (await card.locator(".subagent-notice-report h2").innerText().catch(() => "")).includes("侦察报告"));
  await shot("card");
}
