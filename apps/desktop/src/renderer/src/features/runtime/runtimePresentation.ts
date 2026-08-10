import type { RuntimeContextItem } from "@suocode/runtime-protocol";

const toolNames: Record<string, string> = {
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  grep: "搜索内容",
  find: "查找文件",
  ls: "查看目录",
  bash: "执行命令",
  terminal: "终端会话",
  todo: "任务管理",
  subagent: "子代理",
  mcp: "MCP 工具",
  mcpScript: "MCP 脚本",
  image: "图片处理",
};

export function tokenNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(absolute >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return Math.round(value).toLocaleString("zh-CN");
}

export function toolDisplayName(name: string): string {
  return toolNames[name] ?? name;
}

export function contextRanking(items: RuntimeContextItem[], limit = 6): RuntimeContextItem[] {
  return items
    .filter((item) => item.active && item.estimatedTokens > 0)
    .sort((left, right) => right.estimatedTokens - left.estimatedTokens)
    .slice(0, limit);
}
