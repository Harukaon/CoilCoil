// 设置页里「添加子 Agent」的表单只是在发下面这几条命令。这个场景在真实桌面应用里发同样的命令，
// 再看真实的 Pi 会话到底怎么对待写出来的文件：
//   - 已经打开的对话里，刚加的子 Agent 马上能派（不用重开对话）；
//   - 它收到的提示词就是用户写的那份，工具就是勾选的那些，能改文件的才带 Git 安全；
//   - 新开的对话里，主 Agent 的 subagent 工具说明里点了它的名字（不然主 Agent 根本不知道有它）；
//   - 内置的名字不能占用；删掉以后派不出去，模型设置也一起清掉。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const description = "用户添加的子 Agent：已打开的对话里立刻能派；提示词和工具照写的来；新对话的工具说明里点名；删掉后派不出去";

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

const DB_EXPERT = {
  name: "db-expert",
  scope: "user",
  description: "Knows the database schema and checks queries against it",
  systemPrompt: "You check SQL against the schema. Report only what is wrong.",
  tools: ["read", "grep", "ls"],
  worktree: false,
};

const PATCHER = {
  name: "patcher",
  scope: "project",
  description: "Applies small fixes the main agent asks for",
  systemPrompt: "You apply small fixes. Change only what you are asked to change.",
  tools: ["read", "edit", "write"],
  worktree: false,
};

export async function run({ ui, check, gatewayLog, page, root, paths }) {
  const ask = (command) => page.evaluate(async (cmd) => {
    try {
      return { ok: true, value: await window.coilcoil.request(cmd) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, command);
  const agentDir = join(root, "data", "agent");
  const settings = () => {
    try { return JSON.parse(readFileSync(join(agentDir, "subagent-settings.json"), "utf8")); } catch { return {}; }
  };
  const child = [{ tool: "ls", args: { path: "." } }, { echo: true }];
  const dispatch = (agent) => ({ tool: "subagent", args: { agent, task: `${agent} MOCK:${JSON.stringify(child)}` } });

  // 对话 A 在任何自定义子 Agent 存在之前就开了。会话要等发出第一条消息才真正开始，所以先发一条，
  // 否则等到它开始时文件已经在磁盘上，测不出「对话开着的时候新加」。
  await ui.newConversation("projA");
  await ui.send([{ tool: "ls", args: { path: "." } }, { echo: true }], "先让对话开起来");

  // —— 保存，和表单一样 ——
  const savedUser = await ask({ type: "save_subagent_profile", cwd: paths.projA, input: DB_EXPERT });
  const savedProject = await ask({ type: "save_subagent_profile", cwd: paths.projA, input: PATCHER });
  check("两个子 Agent 都保存成功", savedUser.ok && savedProject.ok, JSON.stringify([savedUser.message, savedProject.message]));
  const listed = savedProject.value?.profiles ?? [];
  const byName = (name) => listed.find((profile) => profile.name === name);
  check("保存后的列表里有它们，来源分别是用户和项目", byName("db-expert")?.source === "user" && byName("patcher")?.source === "project");
  check("项目里的那个写在这个项目自己的 .coilcoil/agents 下", existsSync(join(paths.projA, ".coilcoil", "agents", "patcher.md")));
  check("用户的那个写在用户自己的 agents 目录下", existsSync(join(agentDir, "agents", "db-expert.md")));
  check("内置的四个还在、没被动过", ["explore", "worker", "reviewer", "hacker"].every((name) => byName(name)?.source === "builtin"));

  const builtinName = await ask({ type: "save_subagent_profile", cwd: paths.projA, input: { ...DB_EXPERT, name: "explore" } });
  check("内置的名字不能占用", !builtinName.ok && /内置/.test(builtinName.message ?? ""), builtinName.message);
  const noTools = await ask({ type: "save_subagent_profile", cwd: paths.projA, input: { ...DB_EXPERT, name: "no-tools", tools: [] } });
  check("一个工具都没选，保存被拒绝", !noTools.ok, noTools.message);

  // —— 配模型，和设置页一样 ——
  const models = await ask({ type: "save_subagent_configuration", input: { models: { "db-expert": "mock/mock-1", patcher: "mock/mock-1" } } });
  check("给它们配模型成功", models.ok && models.value?.models?.["db-expert"] === "mock/mock-1", JSON.stringify(models.value ?? models.message));

  // —— 已经打开的对话 A：不重开，直接派 ——
  await ui.send([dispatch("db-expert"), dispatch("patcher"), { echo: true }], "已打开的对话里派自己加的");
  const entryOf = (marker) => gatewayLog().find((entry) => (entry.systemFull ?? "").includes(marker));
  await ui.waitFor(() => entryOf(DB_EXPERT.systemPrompt) && entryOf(PATCHER.systemPrompt), 60_000);
  const dbEntry = entryOf(DB_EXPERT.systemPrompt);
  const patcherEntry = entryOf(PATCHER.systemPrompt);
  check("已打开的对话里，刚加的子 Agent 派出去了，拿到的是用户写的提示词", Boolean(dbEntry) && Boolean(patcherEntry));
  const sorted = (list) => [...(list ?? [])].sort().join(",");
  check("db-expert 的工具正好是勾选的三个", sorted(dbEntry?.tools) === "grep,ls,read", sorted(dbEntry?.tools));
  check("patcher 的工具有勾选的，没有没勾的", ["read", "edit", "write"].every((tool) => (patcherEntry?.tools ?? []).includes(tool)) && !(patcherEntry?.tools ?? []).some((tool) => ["bash", "mcp", "terminal"].includes(tool)), sorted(patcherEntry?.tools));
  check("只读的 db-expert 不带 Git 安全", Boolean(dbEntry) && !dbEntry.systemFull.includes("<git_safety>"));
  check("能改文件的 patcher 带着 Git 安全", Boolean(patcherEntry) && patcherEntry.systemFull.includes("<git_safety>") && patcherEntry.systemFull.includes("git reset --hard"));
  check("它们没有被塞进主 Agent 的整份工程规范", Boolean(dbEntry) && !dbEntry.systemFull.includes("<engineering_standards>") && !patcherEntry?.systemFull.includes("<engineering_standards>"));
  check("我们追加的部分没有中文", Boolean(dbEntry) && !CJK.test(dbEntry.systemFull) && !CJK.test(patcherEntry?.systemFull ?? ""), dbEntry?.systemFull.match(CJK)?.[0]);

  // —— 新开的对话 B：主 Agent 的工具说明里点了名 ——
  await ui.newConversation("projA");
  await ui.send([{ tool: "ls", args: { path: "." } }, { echo: true }], "新开的对话");
  const firstOfB = () => gatewayLog().find((entry) => entry.last?.text?.includes("新开的对话") && (entry.tools ?? []).includes("subagent"));
  await ui.waitFor(firstOfB, 30_000);
  const subagentTool = firstOfB()?.toolDescriptions?.subagent ?? "";
  check("新对话里，subagent 工具的说明点了 db-expert 和它的说明", subagentTool.includes("db-expert: Knows the database schema and checks queries against it"), subagentTool.slice(-400));
  check("项目里的那个标明来自本项目", subagentTool.includes("patcher (from this project): Applies small fixes the main agent asks for"));
  check("工具说明里原来的内容都还在（没有被换掉）", subagentTool.includes("Dispatch and manage subagents") && subagentTool.includes("hacker"));
  // 会话标题那类请求本来就不带工具，不算在内。
  const toolCounts = gatewayLog()
    .filter((entry) => entry.last?.text?.includes("新开的对话") && (entry.tools ?? []).length > 0)
    .map((entry) => (entry.tools ?? []).filter((name) => name === "subagent").length);
  check("subagent 工具只出现一次，没有因为重新注册变成两个", toolCounts.length > 0 && toolCounts.every((count) => count === 1), JSON.stringify(toolCounts));

  // —— 删除 ——
  const deletedUser = await ask({ type: "delete_subagent_profile", name: "db-expert", scope: "user", cwd: paths.projA });
  const deletedProject = await ask({ type: "delete_subagent_profile", name: "patcher", scope: "project", cwd: paths.projA });
  check("两个都删掉了", deletedUser.ok && deletedProject.ok, JSON.stringify([deletedUser.message, deletedProject.message]));
  const left = deletedProject.value?.profiles ?? [];
  check("列表里不再有它们，内置的还在", !left.some((profile) => ["db-expert", "patcher"].includes(profile.name)) && left.some((profile) => profile.name === "explore"));
  check("文件也没了", !existsSync(join(agentDir, "agents", "db-expert.md")) && !existsSync(join(paths.projA, ".coilcoil", "agents", "patcher.md")));
  check("它们的模型设置一起清掉了", settings().models?.["db-expert"] === undefined && settings().models?.patcher === undefined && settings().models?.explore === "mock/mock-1", JSON.stringify(settings()));
  const deletedAgain = await ask({ type: "delete_subagent_profile", name: "db-expert", scope: "user", cwd: paths.projA });
  check("再删一次会说没有找到，而不是悄悄成功", !deletedAgain.ok && /没有找到/.test(deletedAgain.message ?? ""), deletedAgain.message);

  await ui.send([dispatch("db-expert"), { echo: true }], "删掉之后再派");
  const echo = await ui.lastEcho();
  check("删掉之后派不出去，说明里写的是找不到", /未找到子 Agent profile：db-expert/.test(echo), echo.slice(0, 300));
}
