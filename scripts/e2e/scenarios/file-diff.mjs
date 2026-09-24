export const description = "edit / write 返回真实的 diff，界面按行上色";

export async function run({ page, ui, check, shot, gatewayLog }) {
  await ui.newConversation("projA");
  await ui.send([
    { tool: "edit", args: { path: "README.md", edits: [{ oldText: "# projA\n", newText: "# projA\n\n改过的一行\n" }] } },
    { tool: "write", args: { path: "notes.txt", content: "第一行\n第二行\n" } },
    { echo: true },
  ], "改文件");

  const results = gatewayLog().filter((entry) => entry.last.role === "tool").map((entry) => entry.last.text);
  check("模型收到的 edit 返回是 diff", results.some((text) => /^已修改 README\.md（\+2 -0）[\s\S]*\+改过的一行/.test(text)), results[0]?.slice(0, 120));
  check("模型收到的 write 返回是新建文件的 diff", results.some((text) => /^已新建 notes\.txt（2 行）[\s\S]*\+第二行/.test(text)), results[1]?.slice(0, 120));

  await page.locator(".tool-activity > summary").first().click();
  const summary = await page.locator(".tool-activity > summary").first().innerText();
  check("工具汇总里的 +/- 按 diff 算：+4", /\+4/.test(summary) && !/-\d/.test(summary), summary.replace(/\n/g, " "));
  const rows = page.locator(".tool-activity-row");
  for (let index = 0; index < await rows.count(); index += 1) await rows.nth(index).locator("summary").first().click().catch(() => undefined);
  await page.waitForTimeout(300);
  const added = await page.locator(".tool-diff-line.add").allInnerTexts();
  check("界面上显示上色的新增行", added.includes("+改过的一行") && added.includes("+第二行"), JSON.stringify(added));
  check("调用参数只显示路径，不再铺整份内容", !(await page.locator(".tool-execution-details").first().innerText()).includes("第一行\n第二行\n\n"));
  await shot("diff");
}
