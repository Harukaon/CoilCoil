import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The setup guide: the written tutorial half of the `coilcoil` tool.
 *
 * A skill install is a file copy and an MCP change is a config edit — the
 * model already owns file tools, so what it is missing is *where* and *how*.
 * This serves that knowledge as text; the `mcp` / `skill` operations of the
 * tool then run the same methods the settings panel uses (write file + reload
 * the live session + connect), which no amount of bash can replace. Reading
 * this first is what keeps the model from hand-editing files the panel owns.
 */
export type GuideTopic = "skill" | "mcp" | "auth";

const MASKED_SECRET_VALUE = "••••••";

export function agentDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    if (configured === "~") return homedir();
    if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
    return configured;
  }
  return join(homedir(), ".pi", "agent");
}

export function skillInstallGuide(agentDir: string): string {
  return [
    "在 CoilCoil 里装 Skill，本质就是把别人的 Skill 目录拷进系统目录——没有注册表，没有下载器。",
    "",
    "目录（按场景选一个，不要自己发明）：",
    `- 全局自维护：${join(agentDir, "skills")}（装到这里，所有项目都能用；这就是 install 干的事）`,
    "- 当前项目专用：<项目>/.pi/skills（只给这个项目用）",
    "- 第三方共享：~/.agents/skills（别的工具放的也能读到）",
    "内置 bundled：删不掉也关不掉，看到就跳过。",
    "",
    "Skill 目录长什么样（缺 SKILL.md 就不是 Skill，别拷）：",
    "  my-skill/",
    "    SKILL.md        ← 必需：名字和说明从这里读",
    "    其他文件…       ← 参考资料、脚本，随便跟什么",
    "",
    "步骤：",
    "1. 先读一遍来源目录，确认有 SKILL.md 且内容是想要的。",
    "2. 用 skill op=install + path（本地目录）拷进去——工具会先校验 SKILL.md，拷完自动 reload 会话，不用你再调别的。",
    "3. 装完用 skill op=list 确认它在列表里且 enabled；想只给当前会话关掉，用 op=disable_session（不改配置）。",
    "",
    "坑：",
    "- 别用 bash/cp 自己拷：跳过校验，拷完会话也不 reload，装完 Skill 不会出现。",
    "- 别碰 bundled：传它的 filePath 会直接被拒绝。",
    "- 删（remove）只是从列表拿掉，文件还在；彻底删文件用 op=delete，且只允许删自维护目录里的。",
  ].join("\n");
}

export function mcpSetupGuide(agentDir: string): string {
  return [
    "在 CoilCoil 里配 MCP，本质就是改 mcp.json——但只改文件不够，改完必须 reload 会话、连上测通。",
    "",
    "文件（都在系统目录里，不在项目里，别往仓库里写）：",
    `- 全局：${join(agentDir, "mcp.json")}（大部分 Server 放这里）`,
    `- 当前工作区专属：${join(agentDir, "workspaces", "<项目>-<hash>", "mcp.json")}（只给这个工作区用，用 scope=project 写）`,
    "改 Cursor / Claude / Codex 那边的源文件没用：导入是抄一份过来，不是挂上去，源头以后再改不会同步。",
    "",
    "一个 Server 长什么样（二选一）：",
    '  stdio（本地起进程）：{ "command": "npx", "args": ["-y", "xxx-mcp"], "env": {...} }',
    '  http（远端地址）：{ "url": "https://…/mcp", "headers": {...} }',
    `  占位符 ${"${VAR}"} / $env:VAR 会在启动时从环境变量展开；没设置的变量展开成空，不要把 token 明文写进文件。`,
    "",
    "步骤：",
    "1. 用户给的配置先用 mcp op=parse_snippet 解析：README 里抄来的裸对象、VS Code 的 {servers} 写法都能认，返回规整的字段再填给 save。",
    "2. 用 mcp op=save 写进去（带上 scope；name 只能是字母数字点下划线连字符）。",
    "3. 用 mcp op=connect 真连一次：连上才算配好，连不上把服务器原话的第一行告诉用户（比如 Invalid API key），不要自己编原因。",
    "4. 机器上别的工具（Cursor/Claude/Codex…）配好的可以用 mcp op=discover 看看、op=import 抄过来；同名的会被跳过，不会覆盖用户改过的参数。",
    "",
    "坑：",
    `- 别用 bash 改 mcp.json：绕过校验不说，会话不 reload，配完 Agent 照样看不到；删和停用还有 removed/disabled 两套私账，手改文件会跟面板打架。`,
    `- 敏感值（env/headers 里名字带 token/key/secret/password 的）读出来是 ${MASKED_SECRET_VALUE}，那是掩码不是值：原样传回去表示“不改”，真要换就填新值。`,
    "- 需要登录的 Server 走 auth 那一套（见 topic=auth），不要让用户把 token 贴进配置文件。",
  ].join("\n");
}

export function mcpAuthGuide(): string {
  return [
    "MCP 认证：token 不在 mcp.json 里，在凭据库里；OAuth 要走浏览器一圈，Agent 在中间只负责递话。",
    "",
    "OAuth（浏览器登录）四步，顺序不能乱：",
    "1. mcp op=auth_start：返回 authorizationUrl（把链接给用户去点）和 awaitingCallback。",
    "2. 用户在浏览器里点完同意，回调会回到本地监听器；Agent 不用等，用 op=auth_await_each 等回调到手（回来就报，不要和下一步合成一次调）。",
    "3. 回调到手后调 op=auth_finish：换令牌、重连、列工具。",
    "4. 用户如果关了对话框不玩了，调 op=auth_cancel 把占着的回调位放掉。",
    "回调没回到监听器（远程机器、端口被挡）：让用户把浏览器地址栏整段粘回来，用 op=auth_complete + input 传过去，一样能换令牌。",
    "",
    "bearer：save 时填 bearerTokenEnv（环境变量名），不要把 token 本体写进 headers；填完 connect 测一次。",
    "登出：mcp op=logout 清掉这台机器存的登录信息（配置还在）。",
    "",
    "坑：",
    "- 认证是给人点的，不是给 Agent 点的：Agent 永远不要自己去 curl 授权地址，能做的只有发起、递链接、等回调、收尾。",
    "- op=connect 报 needs-auth 不是失败，是“该去走上面四步了”。",
  ].join("\n");
}

export function setupGuide(topic: GuideTopic, agentDir?: string): string {
  const dir = agentDir ?? agentDirFromEnv();
  if (topic === "skill") return skillInstallGuide(dir);
  if (topic === "auth") return mcpAuthGuide();
  return mcpSetupGuide(dir);
}

/**
 * What the settings panel already knows, kept next to the guide that points at it.
 *
 * The panel masks sensitive env/header values before they cross IPC; the agent
 * bridge must speak the same language or a masked value round-trips back as a
 * literal password. And `environment` here is the runtime process's own —
 * exactly what the server child will inherit at launch — so reporting what is
 * missing is a fact, not a guess.
 */
export const SETUP_MASKED_VALUE = MASKED_SECRET_VALUE;

export function isSensitiveConfigKey(key: string): boolean {
  return /(?:authorization|api[-_]?key|token|secret|password|cookie|credential)/i.test(key);
}

/** Names referenced as `${VAR}` / `$env:VAR` (plus bearerTokenEnv) but absent from the environment. */
export function missingEnvPlaceholders(
  server: {
    command?: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    url?: string;
    headers: Record<string, string>;
    bearerTokenEnv?: string;
  },
  environment: Record<string, string | undefined>,
): string[] {
  const referenced = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)/g)) {
        referenced.add(match[1] ?? match[2]!);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) scan(item);
    }
  };
  scan([server.command, server.args, server.env, server.url, server.headers, server.cwd]);
  if (server.bearerTokenEnv?.trim()) referenced.add(server.bearerTokenEnv.trim());
  return [...referenced].filter((name) => !environment[name]).sort();
}

/**
 * The bundled runtime's own document shelf: what exists for an agent to read.
 *
 * `workflowDir` is the workflow package root (the folder holding
 * `package.json`); `..` up from it is `packages/`, `../..` is the repo root.
 * The setup tool passes `getAgentDir()` — the agent *data* directory — which
 * is not the package; callers there resolve the package via
 * `resolveWorkflowDirectory` instead. This helper only joins paths, so both
 * shapes are testable here.
 */
export function bundledDocRoots(workflowDir: string): { docsDir: string; readmeFile: string } {
  return { docsDir: join(workflowDir, "..", "..", "docs"), readmeFile: join(workflowDir, "..", "..", "README.md") };
}

/**
 * Read one bundled document by name. Names only, no paths: the shelf is a
 * fixed set of files, not a file reader with a root.
 */
export function readBundledDoc(workflowDir: string, name: string): { path: string; content: string } {
  const { docsDir, readmeFile } = bundledDocRoots(workflowDir);
  const wanted = name.trim().toLowerCase();
  const candidates = new Map<string, string>();
  candidates.set("readme", readmeFile);
  if (existsSync(docsDir)) {
    try {
      for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        const base = entry.name.toLowerCase().replace(/\.md$/, "");
        candidates.set(base, join(docsDir, entry.name));
        candidates.set(entry.name.toLowerCase(), join(docsDir, entry.name));
      }
    } catch {
      // A shelf that cannot be listed is an empty shelf, not a crash.
    }
  }
  const path = candidates.get(wanted);
  if (!path || !existsSync(path)) {
    const names = [...candidates.keys()].filter((key) => !key.includes(".")).sort();
    throw new Error(
      `没有这份文档「${name.trim()}」。可选：${names.join("、") || "（暂无）"}。`,
    );
  }
  return { path, content: readFileSync(path, "utf8") };
}

/** One bundled document, trimmed to a character budget with the cut marked. */
export function summarizeBundledDoc(
  path: string,
  content: string,
  maxChars: number,
): { path: string; content: string; truncated: boolean; totalChars: number } {
  const totalChars = Array.from(content).length;
  if (totalChars <= maxChars) return { path, content, truncated: false, totalChars };
  const chars = Array.from(content).slice(0, maxChars).join("");
  return {
    path,
    content: `${chars}\n\n…（文档太长，只读了前 ${maxChars} 字）`,
    truncated: true,
    totalChars,
  };
}
