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
