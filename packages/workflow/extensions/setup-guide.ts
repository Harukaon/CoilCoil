import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The setup guide: the written tutorial half of the `coilcoil` tool.
 *
 * A skill install is a file copy, an MCP change is a config edit, and a model
 * provider change is a private models/auth edit — the model already owns file
 * tools, so what it is missing is *where* and *how*. This serves that knowledge
 * as text; the `mcp` / `skill` / `model` operations then run the same methods
 * the settings panel calls (write, validate, reload and refresh), which no
 * amount of bash can replace. Reading this first is what keeps the model from
 * hand-editing files the panel owns.
 */
export type GuideTopic = "skill" | "mcp" | "auth" | "model";

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
    "3. 装完用 skill op=list 确认它在列表里且 enabled；想只给当前会话关掉，用 op=session_disable（不改配置）。",
    "",
    "四个关系容易搞混的操作：",
    "- op=disable：停用，还在列表里，op=enable 恢复。",
    "- op=session_disable：只在当前对话里关掉，配置不动。",
    "- op=remove：从列表里隐起来，文件不删；用 op=enable 加同一个 filePath 就能把它恢复回来。",
    "- op=delete：连目录一起删，只能删自维护目录里的，删了就没了。",
    "",
    "坑：",
    "- 别用 bash/cp 自己拷：跳过校验，拷完会话也不 reload，装完 Skill 不会出现。",
    "- 别碰 bundled：传它的 filePath 会直接被拒绝。",
    "- Skill 按 SKILL.md 里的名字认人：同名的装不进去（会被直接拒掉），要换新版本先 op=delete 旧的。",
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
    "2. 用 mcp op=save 写进去：服务器定义放在 server 字段里（一个对象，含 name/transport/command 或 url 等），scope 单独传；name 只能是字母数字点下划线连字符。",
    "3. 用 mcp op=connect 真连一次：连上才算配好，连不上把服务器原话的第一行告诉用户（比如 Invalid API key），不要自己编原因。",
    "4. 机器上别的工具（Cursor/Claude/Codex…）配好的可以用 mcp op=discover 看看、op=import 抄过来；同名的会被跳过，不会覆盖用户改过的参数。",
    "整文编辑走 op=get_json 读、op=save_json 写，全文放在 text 字段里（里面的敲码值原样留着就是不改）。",
    "",
    "坑：",
    `- 别用 bash 改 mcp.json：绕过校验不说，会话不 reload，配完 Agent 照样看不到；删和停用还有 removed/disabled 两套私账，手改文件会跟面板打架。`,
    `- 敏感值（env/headers 里名字带 token/key/secret/password 的，以及地址里的密码与敏感参数）读出来都是 ${MASKED_SECRET_VALUE}，list 和 get_json 一样：那是掩码不是值，原样传回去表示“不改”，真要换就填新值；别把它当密钥读给用户。`,
    "- 会话级开关（session_enable/session_disable）只管这次对话藏不藏，救不回配置里已停用的 Server；要真启用用 op=enable。",
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

export function modelSetupGuide(): string {
  return [
    "在 CoilCoil 里配置模型，改的是服务商和模型目录，不是选择当前要用哪个模型。model area 不提供 set_default、use、session model 或 summarizer 操作。",
    "",
    "先用 op=list：",
    "- 返回所有内置/自定义服务商、凭据状态、启停状态、supportedApis，以及每个模型的完整能力字段。",
    "- contextWindow 是最大上下文窗口；maxTokens 是最大输出 Token；input 包含 image 表示支持图片；reasoning 和 thinkingLevelMap 控制 Thinking 及可用级别。",
    "- 还会返回 cost（含 tiers）、samplingParams、模型/服务商 headers、compat 等面板高级字段；敏感 header 会显示 ••••••，原样传回表示不改。",
    "",
    "新建或修改服务商用 op=save + provider：",
    "- 新自定义服务商至少需要 id、baseUrl、api 和 models；modelsMode=merge（默认）按模型 ID 增量合并，modelsMode=replace 才会替换整张目录。",
    "- provider.models 每项可以填 id/name/api/baseUrl/reasoning/thinkingLevelMap/input/contextWindow/maxTokens/cost/samplingParams/headers/compat。只改一个模型字段时只传 id 和要改的字段，其他字段会保留。",
    "- API Key 可以直接填 provider.apiKey 或 provider.credential.values；会进入本机私有凭据库，工具结果不会回显。也可以用 apiKeyReference=$ENV_VAR 或 !命令引用环境/命令凭据。",
    "- 不要用 bash 改 models.json/auth.json：工具会做校验、reload 运行时，并让当前 Agent 立即看到新目录。",
    "",
    "上游模型和元数据：",
    "1. 先用 op=fetch_models + request（baseUrl/api/headers/provider/apiKey）拉上游 /models，返回模型 ID 和匹配到的元数据。",
    "2. 元数据统一从 models.dev、OpenRouter、LiteLLM 目录查 contextWindow、maxTokens、图片输入、reasoning 等字段；也可以用 op=catalog + modelIds 单独查询，refresh=true 强制刷新 24 小时缓存。",
    "3. 把返回的字段整理进 provider.models 再 op=save；已有模型未传的字段不会被清空。",
    "",
    "其它面板功能：",
    "- op=test + request 发送一次真实请求测试连接；request.modelId 必须是要测试的模型。",
    "- op=enable / op=disable 只软切换服务商显示状态；op=remove 删除自定义目录，内置服务商用 op=logout 清凭据。",
    "- OpenAI Responses WS 面板用 op=ws_get / op=ws_save，字段是 ws.baseUrl、ws.apiKey、ws.preserveApiKey、ws.fast。",
    "",
    "订阅登录也是 OAuth：",
    "1. op=auth_start + providerId，返回 flowId；如果出现 authUrl，把链接给用户在浏览器打开。",
    "2. op=auth_await + flowId + revision 等下一步状态；如果返回 prompt，就让用户提供内容，再 op=auth_respond 传 flowId/promptId/value。",
    "3. 重复 auth_await 直到 succeeded/failed；中途放弃用 op=auth_cancel，清理凭据用 op=logout。设备码和浏览器链接都由运行时返回，Agent 不要自己 curl 授权地址。",
  ].join("\n");
}

export function setupGuide(topic: GuideTopic, agentDir?: string): string {
  const dir = agentDir ?? agentDirFromEnv();
  if (topic === "skill") return skillInstallGuide(dir);
  if (topic === "auth") return mcpAuthGuide();
  if (topic === "model") return modelSetupGuide();
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
