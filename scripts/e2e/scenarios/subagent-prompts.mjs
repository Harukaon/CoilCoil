// 单元测试只能看到「拼出来的那一段」，看不到子 Agent 最后真正收到的整份系统提示词。这个场景派出
// 三个内置子 Agent，读网关记下的完整请求：提示词是不是全英文、能改文件的（worker）有没有带 Git
// 安全并被禁止跑测试、只读的（explore、reviewer）有没有被多塞东西。
export const description = "子 Agent 真正收到的提示词：全英文；能改文件的带 Git 安全、不跑测试，只读的不带";

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

const ROLE_LINES = {
  explore: "You are a read-only code reconnaissance subagent.",
  reviewer: "You are an independent code review subagent.",
  worker: "You are a coding subagent responsible for implementing changes.",
};

export async function run({ ui, check, gatewayLog }) {
  await ui.newConversation("projA");
  const child = [{ tool: "ls", args: { path: "." } }, { echo: true }];
  const dispatch = (agent, extra = {}) => ({
    tool: "subagent",
    args: { agent, task: `${agent} MOCK:${JSON.stringify(child)}`, ...extra },
  });
  // The worker defaults to its own git worktree; the test folders are not git repositories.
  await ui.send([dispatch("explore"), dispatch("reviewer"), dispatch("worker", { worktree: false }), { echo: true }], "派三个子代理");

  const promptOf = (agent) => gatewayLog().find((entry) => (entry.systemFull ?? "").includes(ROLE_LINES[agent]))?.systemFull ?? "";
  await ui.waitFor(() => Object.keys(ROLE_LINES).every((agent) => promptOf(agent)), 60_000);

  const prompts = Object.fromEntries(Object.keys(ROLE_LINES).map((agent) => [agent, promptOf(agent)]));
  for (const [agent, prompt] of Object.entries(prompts)) {
    check(`${agent} 的请求被网关记下了`, prompt.length > 0);
    check(`${agent} 收到的整份系统提示词没有中文`, prompt.length > 0 && !CJK.test(prompt), prompt.match(CJK)?.[0]);
    check(`${agent} 被要求用任务的语言汇报`, /in the language of the task/.test(prompt));
    check(`${agent} 没有被塞进主 Agent 的整份工程规范`, prompt.length > 0 && !prompt.includes("<engineering_standards>"));
  }

  check("worker 带着 Git 安全", prompts.worker.includes("<git_safety>") && prompts.worker.includes("git reset --hard"), prompts.worker.slice(-300));
  check("worker 的 Git 安全不叫它去问用户", prompts.worker.includes("describe the conflict in your report") && !prompts.worker.includes("ask the user"));
  check("worker 被明确要求不跑测试、不写测试", /do not run the project's tests/i.test(prompts.worker) && /do not write or edit tests/i.test(prompts.worker));
  check("explore 是只读的，不带 Git 安全", prompts.explore.length > 0 && !prompts.explore.includes("<git_safety>"));
  check("reviewer 是只读的，不带 Git 安全", prompts.reviewer.length > 0 && !prompts.reviewer.includes("<git_safety>"));
}
