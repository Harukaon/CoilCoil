import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const description = "检查点：编辑历史消息时可以把代码退回那条消息发出时的样子";

export async function run({ page, ui, check, shot, paths }) {
  const repo = paths.projA;
  const read = (name) => (existsSync(join(repo, name)) ? readFileSync(join(repo, name), "utf8") : undefined);

  await ui.newConversation("projA");
  await ui.send([{ tool: "write", args: { path: "a.txt", content: "第一版\n" } }, { echo: true }], "检查点");
  await ui.send([
    { tool: "edit", args: { path: "a.txt", edits: [{ oldText: "第一版", newText: "第二版" }] } },
    { tool: "write", args: { path: "b.txt", content: "第二条消息新建的\n" } },
    { echo: true },
  ]);
  check("Agent 的改动都落盘了", read("a.txt") === "第二版\n" && read("b.txt") === "第二条消息新建的\n");
  // Agent 没碰过的文件（用户自己改的、同一个文件夹下别的项目）回退时不动。
  writeFileSync(join(repo, "user.txt"), "用户自己改的\n");

  const bubbles = page.locator(".user-bubble-button");
  check("历史消息可以点开编辑", await ui.waitFor(async () => (await bubbles.count()) === 2 && await bubbles.nth(1).isEnabled()));

  const editAndSend = async (index, script) => {
    await bubbles.nth(index).click();
    const editor = page.locator('[contenteditable="true"][aria-label="编辑历史消息"]');
    await editor.waitFor({ timeout: 10_000 });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(`MOCK:${JSON.stringify(script)}`);
    await page.keyboard.press("Enter");
  };
  // 回退会先把后面的消息截掉，所以按回复内容等，不按条数。
  const waitForReply = (expected) => ui.waitFor(async () => (await ui.lastEcho()).includes(expected), 60_000);

  // 编辑第二条：它发出时 a.txt 还是第一版、b.txt 还不存在。
  await editAndSend(1, [{ tool: "read", args: { path: "a.txt" } }, { echo: true }]);
  const dialog = page.getByRole("dialog");
  check("弹窗问代码要不要回退", await ui.waitFor(async () => (await dialog.getByText("代码也回退吗？").count()) === 1));
  const text = await dialog.innerText();
  check("弹窗只说改动了几个文件", text.includes("改动了 2 个文件") && !text.includes("a.txt"), text.replace(/\n/g, " "));
  await shot("dialog");
  await dialog.getByRole("button", { name: "回退代码并重新发送" }).click();
  check("代码退回了第二条消息发出时的样子", await ui.waitFor(async () => read("a.txt") === "第一版\n" && read("b.txt") === undefined), JSON.stringify([read("a.txt"), read("b.txt")]));
  check("Agent 没改过的文件原样不动", read("user.txt") === "用户自己改的\n");
  check("重新发送后 Agent 读到的是回退后的文件", await waitForReply("第一版"), (await ui.lastEcho()).slice(0, 80));
  check("回退后对话从第二条重新开始", await ui.waitFor(async () => (await bubbles.count()) === 2));

  // 编辑第一条，这次选择保留代码：对话回去，文件不动。
  writeFileSync(join(repo, "mine.txt"), "我自己写的\n");
  await editAndSend(0, [{ tool: "read", args: { path: "mine.txt" } }, { echo: true }]);
  check("第一条之后 a.txt 是新建的，也会问", await ui.waitFor(async () => (await dialog.getByText("代码也回退吗？").count()) === 1));
  await dialog.getByRole("button", { name: "保留现在的代码" }).click();
  check("选了保留，文件都还在", await waitForReply("我自己写的") && read("a.txt") === "第一版\n" && read("mine.txt") === "我自己写的\n");
  check("对话回到了第一条", await ui.waitFor(async () => (await bubbles.count()) === 1));
  await shot("after");
}
