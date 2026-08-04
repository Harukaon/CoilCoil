import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isGptModelId(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const leafId = modelId.split("/").at(-1) ?? modelId;
  return /^gpt-/i.test(leafId);
}

const COMMAND_DESCRIPTIONS_ZH_CN: Record<string, string> = {
  settings: "打开设置菜单",
  model: "选择模型（可输入 provider/model）",
  fast: "切换 OpenAI priority 快速服务层级",
  "scoped-models": "设置 Ctrl+P 循环切换的模型范围",
  export: "导出当前会话（默认 HTML，也支持 JSONL）",
  import: "导入并恢复 JSONL 会话",
  share: "通过私密 GitHub Gist 分享会话",
  copy: "复制 Agent 的最后一条消息",
  name: "设置当前会话名称",
  session: "查看会话信息和统计数据",
  changelog: "查看版本更新记录",
  hotkeys: "查看全部快捷键",
  fork: "从以前的用户消息创建会话分支",
  clone: "复制当前会话分支",
  tree: "浏览会话树并切换分支",
  trust: "保存当前项目的信任设置",
  login: "登录并配置模型服务商",
  logout: "退出模型服务商账号",
  new: "开始一个新会话",
  compact: "手动压缩当前会话上下文",
  resume: "恢复其他历史会话",
  reload: "重新加载扩展、Skills、Prompts、主题和规则",
  quit: "退出 Pi",
  llama: "管理 llama.cpp 路由模型",
  mcp: "管理并调用 MCP 服务器和工具",
  "mcp-auth": "为 MCP 服务器进行 OAuth 认证",
  subagents: "管理 Subagent 的角色、模型、思考级别和提示词",
  run: "直接运行一个 Subagent（支持后台和继承上下文）",
  chain: "按顺序运行多个 Subagent",
  "run-chain": "运行已保存的 Subagent 流程链",
  parallel: "并行运行多个 Subagent",
  "subagent-cost": "查看当前会话中主 Agent 与 Subagent 的用量和费用",
  "subagents-doctor": "检查 Subagent 配置和运行环境",
  "subagents-fleet": "查看正在运行和最近完成的 Subagent",
  "subagents-stop": "停止当前会话中的后台 Subagent",
  "subagents-models": "查看内置 Subagent 当前使用的模型",
  "subagents-profiles": "列出已保存的 Subagent 配置方案",
  "subagents-load-profile": "加载一个 Subagent 配置方案",
  "subagents-refresh-provider-models": "刷新指定服务商的模型目录",
  "subagents-generate-profiles": "为指定服务商生成 Subagent 配置方案",
  "subagents-check-profile": "检查配置方案中的模型是否可用",
  "subagents-watchdog": "查看或开关 Subagent 自动审查（默认关闭）",
  "prompt-workflow": "通过 Subagent 运行一个提示词工作流",
  "chain-prompts": "把多个提示词模板组成 Subagent 流程链",
  "gather-context-and-clarify": "先用 Subagent 收集上下文，再提出澄清问题",
  "parallel-cleanup": "并行检查并清理当前改动",
  "parallel-context-build": "并行构建规划和交接所需的上下文",
  "parallel-handoff-plan": "并行研究并生成可实施的交接计划",
  "parallel-research": "并行进行外部资料与本地代码研究",
  "parallel-review": "并行审查当前工作",
  "review-loop": "循环执行审查与修复，直到通过或达到上限",
  "skill:pi-subagents": "使用 Subagent 进行委派、并行、流程链和后台任务",
};

export default function zhCnExtension(pi: ExtensionAPI): void {
  let activeModelId: string | undefined;

  pi.on("model_select", (event) => {
    activeModelId = event.model.id;
  });

  pi.on("session_start", (_event, ctx) => {
    activeModelId = ctx.model?.id;
    if (!ctx.hasUI) return;

    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: current.triggerCharacters,
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const suggestions = await current.getSuggestions(
          lines,
          cursorLine,
          cursorCol,
          options,
        );
        if (!suggestions?.prefix.startsWith("/")) return suggestions;

        return {
          ...suggestions,
          items: suggestions.items
            .filter(
              (item) =>
                item.value !== "fast" || isGptModelId(activeModelId),
            )
            .map((item) => ({
              ...item,
              description:
                COMMAND_DESCRIPTIONS_ZH_CN[item.value] ?? item.description,
            })),
        };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix,
        );
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return (
          current.shouldTriggerFileCompletion?.(
            lines,
            cursorLine,
            cursorCol,
          ) ?? true
        );
      },
    }));
  });
}
