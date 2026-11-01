/** Bundled documentation stays available without a running runtime or a source checkout. */
export const MCP_DOCS = `# CoilCoil MCP：外部 Agent 简明接入文档

通过运行中的 CoilCoil Desktop 或 CLI，读取已配置的 MCP 并调用工具。
客户端与 CoilCoil 在同一台机器上运行；配置和登录状态由 CoilCoil 管理。
macOS 关闭窗口但未退出应用时，MCP 仍可用；退出应用后服务停止。
查看本文档无需启动 CoilCoil，也无需配置模型。

## 三步使用

1. 列出当前项目可用的 MCP：
   coilcoil mcp list --cwd /absolute/path/to/project

2. 查询选中服务器的工具、说明及 inputSchema：
   coilcoil mcp tools SERVER --cwd /absolute/path/to/project

3. 按 inputSchema 填写参数并调用工具：
   coilcoil mcp call SERVER TOOL --cwd /absolute/path/to/project --args '{"query":"example"}'

SERVER、TOOL 和示例参数需替换为实际名称和参数。
先 list，再查询需要的服务器，最后 call；无需预先查询所有服务器。

## 命令入口

安装 CLI 后：coilcoil mcp <command>
桌面版自带命令：coilcoil-mcp <command>（完整路径或加入 PATH 后使用）
源码仓库根目录：npm run --silent cli -- mcp <command>
本文档：coilcoil mcp docs
参数速查：coilcoil mcp --help

## 项目和运行时选择

--cwd 默认是客户端当前工作目录，可指定其他项目的绝对路径。
coilcoil mcp instances 列出运行中的 CoilCoil 进程。
只有一个进程时自动选中；多个进程时用 --instance INSTANCE_ID 选择。
coilcoil mcp contexts --instance INSTANCE_ID 列出已打开的会话。
用 --runtime-id RUNTIME_ID 固定某个会话，并给出对应的 --cwd。
已有会话时复用其 MCP 连接和启停状态；没有会话也可按项目配置访问。
访问不会创建对话或切换桌面当前对话。

## 调用 CoilCoil 内置浏览器

桌面版将内置浏览器作为 coilcoil-browser 暴露，无需另外配置 MCP：
coilcoil-mcp tools coilcoil-browser --cwd /absolute/path/to/project
coilcoil-mcp call coilcoil-browser list_pages --cwd /absolute/path/to/project
coilcoil-mcp call coilcoil-browser new_page --cwd /absolute/path/to/project --args '{"url":"https://example.com"}'
coilcoil-mcp call coilcoil-browser take_snapshot --cwd /absolute/path/to/project

tools 返回实际工具名和参数；支持浏览、点击、输入、截图等浏览器操作。
已有会话时共享该会话的标签页，--runtime-id 可明确选择会话。
没有会话时使用该项目的草稿标签页；登录状态按项目隔离。
多个 Agent 操作同一会话时，建议按工具 inputSchema 传 pageId 指定页面。
浏览器调用需要保留 CoilCoil 桌面窗口；关闭全部窗口后，重新打开再调用。
只有 CLI 运行时不会提供内置浏览器。这里的“外部”指同一台机器的客户端。

## 参数、结果和错误

参数必须是 JSON 对象。复杂参数可用 --args-file /path/to/args.json，
或通过 --args-file - 从标准输入读取。
默认超时 300000 毫秒，可用 --timeout 毫秒 调整；Ctrl+C 中断请求。

docs 和 --help 输出文本；其他命令在 stdout 输出 JSON。
list 返回 { cwd, servers: [{ server, status, toolCount }] }。
tools 返回 { status, tools: [{ name, description, inputSchema }], failure? }。
call 返回原始 MCP 结果，保留 content、structuredContent 和 isError。
客户端错误在 stderr 输出 { "ok": false, "error": "…" }，退出码非零。
工具返回 isError: true，或 tools 返回未连接状态时，退出码也非零。
需要认证时，在 CoilCoil 设置中完成认证后重试。
`;
