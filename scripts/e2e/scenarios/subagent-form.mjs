// 设置页里「添加子 Agent」的表单，在真实桌面应用里一项一项真点：
//   - 空表单点保存，错误提示要在按钮上方看得见（它曾经落在滚动区最底下，点了保存像是没反应）；
//   - 填完保存：弹窗关掉、列表里出现、文件写进项目里、模型存下来、焦点回到「添加子 Agent」按钮；
//   - 已经打开的对话里，主 Agent 马上能派它，它收到的就是表单里写的提示词和勾选的工具；
//   - 编辑：名字改不了，改说明保存后文件跟着变；
//   - 删除：先问；取消什么也不动；确认后文件和模型设置一起没了。
// 命令层（保存、删除、会话里生效）由 subagent-custom 场景管，这里只管表单本身。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const description = "设置页的添加/编辑/删除子 Agent 表单：真点按钮；保存后立刻能派；删除先问";

const PROMPT = "You check the interface against the design. Report only what differs.";

export async function run({ ui, check, gatewayLog, page, root, paths, shot }) {
  const agentDir = join(root, "data", "agent");
  const settings = () => {
    try { return JSON.parse(readFileSync(join(agentDir, "subagent-settings.json"), "utf8")); } catch { return {}; }
  };
  const file = join(paths.projA, ".coilcoil", "agents", "ui-checker.md");
  const read = () => (existsSync(file) ? readFileSync(file, "utf8") : "");
  const child = [{ tool: "ls", args: { path: "." } }, { echo: true }];
  const dispatch = (agent) => ({ tool: "subagent", args: { agent, task: `${agent} MOCK:${JSON.stringify(child)}` } });

  // 对话要先真正开始，右栏的运行时面板才有东西可读，项目级的子 Agent 也才知道写进哪个项目。
  await ui.newConversation("projA");
  await ui.send([{ tool: "ls", args: { path: "." } }, { echo: true }], "先让对话开起来");

  // —— 打开右栏「运行时」里的「子 Agent」 ——
  const expand = page.getByRole("button", { name: "展开作业栏" });
  if (await expand.count()) await expand.click();
  await page.waitForTimeout(300);
  if (!(await page.getByRole("button", { name: "运行时", exact: true }).count())) {
    await page.getByRole("button", { name: "打开面板" }).first().click();
    await page.waitForTimeout(300);
  }
  const menu = page.getByRole("menuitem", { name: "运行时", exact: true });
  if (await menu.count()) await menu.first().click();
  else await page.getByRole("button", { name: "运行时", exact: true }).first().click();
  await page.waitForTimeout(700);
  await page.locator(".runtime-section summary", { hasText: "子 Agent" }).first().click();
  const rowOf = (name) => page.locator(".runtime-subagent-model-row", { hasText: name });
  await rowOf("Hacker").first().waitFor({ timeout: 15_000 });
  check("设置页里列出了内置的几个子 Agent，没有「编辑/删除」按钮", (await rowOf("Explore").count()) === 1 && (await page.getByRole("button", { name: /^(编辑|删除) (explore|hacker|worker|reviewer)$/ }).count()) === 0);

  const add = page.getByRole("button", { name: "添加子 Agent", exact: true });
  await add.click();
  const dialog = page.getByRole("dialog", { name: "添加子 Agent" });
  await dialog.waitFor({ timeout: 5_000 });
  const nameBox = dialog.getByRole("textbox", { name: /^名字/ });
  const descriptionBox = dialog.getByRole("textbox", { name: /^说明/ });
  const promptBox = dialog.getByRole("textbox", { name: /^提示词/ });
  const saveButton = dialog.getByRole("button", { name: "保存", exact: true });

  // —— 空表单保存：错误要在按钮上方看得见 ——
  await saveButton.click();
  const alert = dialog.getByRole("alert");
  await alert.waitFor({ timeout: 5_000 });
  const box = { alert: await alert.boundingBox(), dialog: await dialog.boundingBox(), save: await saveButton.boundingBox() };
  check("空表单点保存，提示「请填名字」", /请填名字/.test(await alert.innerText()));
  check(
    "这条提示在弹窗里、在保存按钮上方，用户看得见",
    Boolean(box.alert && box.dialog && box.save)
      && box.alert.y >= box.dialog.y && box.alert.y + box.alert.height <= box.save.y
      && box.alert.y + box.alert.height <= box.dialog.y + box.dialog.height,
    JSON.stringify(box),
  );
  check("校验没过的时候弹窗没有关，什么都没写进磁盘", (await dialog.count()) === 1 && !existsSync(file));

  // —— 填表：项目级、能改文件、选模型 ——
  await nameBox.fill("ui-checker");
  await descriptionBox.fill("Checks a finished screen against its design");
  await promptBox.fill(PROMPT);
  check("动手改表单后，上一条错误就消失了", (await dialog.getByRole("alert").count()) === 0);
  // 光标正在提示词框里，弹窗背后列表所在的组件重新渲染几次：现实里就是别处保存了模型、列表刷新了一下。
  // 共用弹窗曾经因此把光标抢到「名字」框里。这里直接让那个组件的状态更新，不碰焦点，才测得准；
  // 找不到那个组件（比如 React 内部结构变了）就明说，不悄悄跳过。
  const rerender = await page.evaluate(async () => {
    const host = document.querySelector(".runtime-subagent-models");
    const key = host && Object.keys(host).find((name) => name.startsWith("__reactFiber$"));
    let fiber = key ? host[key] : null;
    while (fiber && !(typeof fiber.type === "function" && fiber.memoizedState?.queue?.dispatch)) fiber = fiber.return;
    if (!fiber) return { found: false };
    for (let round = 0; round < 3; round += 1) {
      fiber.memoizedState.queue.dispatch((current) => ({ ...current }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const active = document.activeElement;
    return { found: true, tag: active?.tagName, label: active?.getAttribute("aria-label") ?? active?.getAttribute("placeholder") ?? "" };
  });
  check("弹窗开着，背后的组件重新渲染几次，光标仍留在提示词框里", rerender.found && rerender.tag === "TEXTAREA", JSON.stringify(rerender));
  await dialog.getByRole("checkbox", { name: /修改文件/ }).check();
  check("勾上「修改文件」，下面说明它会带上 Git 安全规则", /Git 安全/.test(await dialog.innerText()));
  await dialog.getByRole("button", { name: "保存位置" }).click();
  await page.getByRole("option", { name: /仅当前项目/ }).click();
  await dialog.getByRole("button", { name: "默认模型" }).click();
  await page.getByRole("option", { name: /Mock 1/ }).first().click();
  await shot("form-filled");
  await saveButton.click();
  await dialog.waitFor({ state: "detached", timeout: 10_000 });
  check("保存后弹窗关了", (await page.getByRole("dialog", { name: "添加子 Agent" }).count()) === 0);

  const row = rowOf("ui-checker").first();
  await row.waitFor({ timeout: 10_000 });
  check("列表里出现了它，并标明是本项目的", (await row.innerText()).includes("本项目"));
  check("它已经配了模型，不是「未配置」", !(await row.innerText()).includes("未配置"), (await row.innerText()).replace(/\s+/g, " "));
  const written = read();
  check(
    "文件写进了这个项目自己的 .coilcoil/agents，内容就是表单里填的",
    written.includes("name: ui-checker") && written.includes("Checks a finished screen against its design") && written.includes(PROMPT) && /tools:.*edit/.test(written),
    written.slice(0, 300),
  );
  check("模型选择也存下来了", settings().models?.["ui-checker"] === "mock/mock-1", JSON.stringify(settings()));
  check("保存之后焦点回到「添加子 Agent」按钮（不是丢到页面顶上）", (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "添加子 Agent");

  // —— 已打开的对话里，主 Agent 马上能派它 ——
  await ui.send([dispatch("ui-checker"), { echo: true }], "派表单里加的");
  const entryOf = () => gatewayLog().find((entry) => (entry.systemFull ?? "").includes(PROMPT));
  await ui.waitFor(entryOf, 60_000);
  const entry = entryOf();
  check("主 Agent 派出去了，它拿到的是表单里写的提示词", Boolean(entry));
  const tools = [...(entry?.tools ?? [])].sort().join(",");
  check("它的工具正好是表单里勾的（默认的读、搜、列，加上修改文件）", tools === "edit,grep,ls,read", tools);
  check("因为勾了修改文件，它带着 Git 安全规则", Boolean(entry?.systemFull.includes("<git_safety>")));

  // —— 编辑：名字改不了，改说明 ——
  await page.getByRole("button", { name: "编辑 ui-checker" }).click();
  const editDialog = page.getByRole("dialog", { name: /编辑子 Agent「ui-checker」/ });
  await editDialog.waitFor({ timeout: 5_000 });
  check("编辑时名字是灰的、改不了", await editDialog.getByRole("textbox", { name: /^名字/ }).isDisabled());
  check("编辑时表单里是它现在的内容", (await editDialog.getByRole("textbox", { name: /^提示词/ }).inputValue()) === PROMPT && (await editDialog.getByRole("checkbox", { name: /修改文件/ }).isChecked()));
  await editDialog.getByRole("textbox", { name: /^说明/ }).fill("Checks a screen against its design, nothing else");
  await editDialog.getByRole("button", { name: "保存", exact: true }).click();
  await editDialog.waitFor({ state: "detached", timeout: 10_000 });
  check("改完保存，文件里的说明跟着变，提示词没丢", read().includes("Checks a screen against its design, nothing else") && read().includes(PROMPT), read().slice(0, 300));
  check("列表里的说明也变了", (await rowOf("ui-checker").first().innerText()).includes("nothing else"));
  check("编辑没有动它的模型", settings().models?.["ui-checker"] === "mock/mock-1");

  // —— 删除：先问，取消不动，确认才删 ——
  await page.getByRole("button", { name: "删除 ui-checker" }).click();
  const confirm = page.getByRole("dialog", { name: /删除子 Agent「ui-checker」/ });
  await confirm.waitFor({ timeout: 5_000 });
  check("删除前先问，并说明要删的是哪个文件", (await confirm.innerText()).includes("ui-checker.md"));
  check("还没确认，文件没动", existsSync(file));
  await confirm.getByRole("button", { name: "取消" }).click();
  await confirm.waitFor({ state: "detached", timeout: 5_000 });
  check("点了取消，文件、列表、模型设置都没动", existsSync(file) && (await rowOf("ui-checker").count()) === 1 && settings().models?.["ui-checker"] === "mock/mock-1");
  await page.getByRole("button", { name: "删除 ui-checker" }).click();
  await page.getByRole("dialog", { name: /删除子 Agent「ui-checker」/ }).getByRole("button", { name: "删除", exact: true }).click();
  await ui.waitFor(async () => (await rowOf("ui-checker").count()) === 0, 10_000);
  check("确认删除后，列表里没有它了", (await rowOf("ui-checker").count()) === 0);
  check("文件没了", !existsSync(file));
  check("它的模型设置一起清掉了，别的没动", settings().models?.["ui-checker"] === undefined, JSON.stringify(settings()));
  check("内置的子 Agent 还在", (await rowOf("Hacker").count()) === 1 && (await rowOf("Worker").count()) === 1);
}
