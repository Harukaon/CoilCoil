# 让其他 Agent 使用 CoilCoil 配置的 MCP

CoilCoil 运行时提供本地访问接口。其他 Agent 只要能执行命令，就可以读取已经配置并启用的 MCP、查询工具及其参数，并请求 CoilCoil 执行工具。连接配置、环境变量和 OAuth 凭据由 CoilCoil 管理，客户端收到工具列表和调用结果。

## 在项目源码中使用

查看简明接入文档或参数速查（无需启动运行时）：

```bash
npm run --silent cli -- mcp docs
npm run --silent cli -- mcp --help
```

已安装 CLI 时使用 `coilcoil mcp docs`；桌面版自带命令使用 `coilcoil-mcp docs`。`docs` 输出中文文本，包含调用步骤、项目和运行时选择、参数、返回格式及错误处理。

先运行更新后的 CoilCoil Desktop 或 CLI。在仓库根目录执行：

```bash
npm run --silent cli -- mcp list --cwd /absolute/path/to/project
npm run --silent cli -- mcp tools <server> --cwd /absolute/path/to/project
npm run --silent cli -- mcp call <server> <tool> --cwd /absolute/path/to/project --args '{"query":"example"}'
```

客户端命令不需要配置模型，也不会创建对话。输出为 stdout 上的 JSON，客户端错误为 stderr 上的 `{ "ok": false, "error": "…" }` 并以非零状态退出。工具自身返回的 `isError: true` 保留在 stdout 的原始 MCP 结果中，退出状态同样非零。`tools` 返回连接失败、需要认证或停用状态时也以非零状态退出。认证可在 CoilCoil 设置中完成，再重试命令。

构建 CLI 后，可直接使用不依赖 TypeScript 加载器的客户端：

```bash
npm run build --workspace @coilcoil/cli
node apps/cli/dist/mcp.js list --cwd /absolute/path/to/project
```

`dist` 目录包含客户端所需的共享 JS 文件，分发时应保留整个目录。安装 CLI 包后也可使用 `coilcoil-mcp list`；它与 `coilcoil mcp list` 等价。

## 桌面版自带的命令

Desktop 构建包含 `out/main/mcp-cli.js`，启动桌面运行时时会在应用数据目录的 `agent/runtime-bin` 下生成 `coilcoil-mcp`（Windows 为 `coilcoil-mcp.cmd`）。它使用应用自带的 Node，无需单独安装 Node 或 npm，也无需安装项目依赖。

例如 macOS 默认安装的数据目录下：

```bash
"$HOME/Library/Application Support/@coilcoil/desktop/agent/runtime-bin/coilcoil-mcp" list --cwd /absolute/path/to/project
```

实际数据目录受安装方式影响。源码客户端的 `mcp instances` 输出包含 `dataDir`，命令位于 `<dataDir>/agent/runtime-bin`。可把这个完整命令路径提供给其他 Agent，或者自行将该目录加入 PATH。CoilCoil 运行时启动的工具和子进程已经继承此 PATH。

## 选择进程、项目和会话

```bash
coilcoil mcp instances
coilcoil mcp contexts --instance <instanceId>
coilcoil mcp list --instance <instanceId> --cwd /absolute/path/to/project
coilcoil mcp tools <server> --instance <instanceId> --cwd /absolute/path/to/project --runtime-id <runtimeId>
```

`instances` 列出存活的运行时进程及其数据目录。只有一个进程时自动选中；多个进程同时运行时必须显式传 `--instance`，避免读取另一个开发实例或数据目录。实例 ID 在进程重启后变化，PID 也可用来选择。

`--cwd` 默认是客户端当前工作目录。运行时按该项目合并全局配置、兼容配置和 CoilCoil 中保存的项目配置。已有会话时复用对应运行时的 MCP 管理器和连接；同一项目有多个会话时优先使用桌面当前选中的会话，否则选最近使用的会话。可通过 `contexts` 和 `--runtime-id` 固定某一会话，遵守该会话的 MCP 启停状态。会话不属于给出的项目，或运行时 ID 已失效时，请求会报错。

项目还没有打开会话时，运行时可按该项目配置连接 MCP，无需创建会话。访问其他项目不会切换桌面当前对话。

macOS 上关闭最后一个窗口后，只要没有退出 CoilCoil，MCP 运行时和正在执行的外部调用会继续保留；明确退出应用时才关闭服务。

## 外部 Agent 使用内置浏览器

CoilCoil Desktop 会在可用服务器中提供 `coilcoil-browser`，无需增加网关或另配浏览器 MCP。其他客户端通过相同命令入口查询和调用：

```bash
coilcoil-mcp tools coilcoil-browser --cwd /absolute/path/to/project
coilcoil-mcp call coilcoil-browser list_pages --cwd /absolute/path/to/project
coilcoil-mcp call coilcoil-browser new_page --cwd /absolute/path/to/project --args '{"url":"https://example.com"}'
coilcoil-mcp call coilcoil-browser take_snapshot --cwd /absolute/path/to/project
```

浏览器提供页面导航、读取页面、点击、输入、截图等工具。先用 `tools` 读取实际工具名及 `inputSchema`。调用结果沿用原始 MCP 格式，包含文本或图片。

已有会话时，外部调用共享该会话的浏览器标签页，可以操作主 Agent 和用户在同一会话中打开的页面。使用 `contexts` 找到会话，再给上述命令添加 `--runtime-id <runtimeId>` 固定目标。未指定时沿用同一项目的会话选择规则。没有会话时使用项目路径对应的草稿浏览器，新会话创建后会接手这批标签页。标签页按会话隔离，登录状态按项目隔离。

多个 Agent 同时操作一个会话会共享所选页面。需要固定页面时，按工具的 `inputSchema` 传 `pageId`；推荐对同一页面顺序执行操作。

持续运行的外部 Agent 应始终传 `--runtime-id`。只传 `--cwd` 时，会话会自动选择，桌面切换当前对话可能使后续调用改为访问另一个对话。`pageId` 仅在选中会话的浏览器连接内有效，不能作为跨会话的全局页面标识；浏览器重连后应重新查询页面列表。

这里的隔离是标签页和操作目标的隔离。同项目的不同对话共享 Cookie 和登录状态，跨项目使用不同的 Cookie 分区。当前本地访问令牌没有按 Agent 或按会话分配权限：持有令牌的客户端可以列出 `contexts` 并主动选择其他会话。因此，它适合本机受信任的 Agent 协作，不能用来限制一个客户端只能访问某个对话。

浏览器由桌面窗口承载，需要保留至少一个 CoilCoil 桌面窗口。关闭全部窗口后，普通 MCP 继续可用，浏览器调用会提示重新打开窗口。只有 CLI 的运行时不提供内置浏览器。内部工作流对子 Agent 的浏览器限制仍沿用原来的策略。

该入口面向同一台机器的外部客户端，继续使用本地运行时认证；不会返回浏览器 CDP 地址或其认证凭据。

### 运行浏览器接入测试（macOS）

在源码仓库中运行以下命令，可以测试已安装的应用：

```bash
npm run smoke:desktop:mcp-browser -- /Applications/CoilCoil.app/Contents/MacOS/CoilCoil
```

测试使用临时应用数据、本地测试网页和应用自带的 `coilcoil-mcp`。覆盖页面操作、同项目双对话隔离、Cookie 分区、会话切换与固定路由、草稿标签页接手、错误会话标识和关闭窗口后的错误提示；不调用模型，也不使用现有会话和浏览器数据。第三方网站的验证码、登录流程和其他工具未由此测试覆盖。

## 参数、超时和取消

参数必须是 JSON 对象，可以从文件或 stdin 读取，避免复杂的 shell 转义：

```bash
coilcoil mcp call <server> <tool> --args-file /path/to/arguments.json
printf '%s' '{"query":"example"}' | coilcoil mcp call <server> <tool> --args-file -
```

客户端默认等待 300 秒，可用 `--timeout <毫秒>` 调整。MCP 自身的 `requestTimeoutMs` 仍然生效。中断命令或客户端连接断开时，会向正在执行的工具传递取消信号。

## 本地 RPC 接口

不使用 CLI 的客户端也可以读取 `~/.coilcoil/runtimes/*.json` 中的运行时描述文件。测试或隔离环境可用 `COILCOIL_RUNTIME_DIR` 指定发现目录，服务端和客户端需要使用相同目录。文件包含 `version: 1`、`instanceId`、`pid`、`dataDir`、`port` 和随机 `token`，应当作为本机访问凭据保管。Unix 上目录以 0700、描述文件以 0600 创建。

服务只绑定 `127.0.0.1` 的动态端口，请求必须携带 `Authorization: Bearer <token>`，带浏览器 `Origin` 的请求会被拒绝。`GET /health` 返回 `{ "instanceId": "…" }`，用于确认描述文件对应的进程仍然存活。客户端会忽略失效描述文件。

`POST /mcp` 接受以下请求：

```jsonl
{ "action": "contexts" }
{ "action": "list", "cwd": "/absolute/project" }
{ "action": "tools", "cwd": "/absolute/project", "server": "example" }
{ "action": "call", "cwd": "/absolute/project", "server": "example", "tool": "search", "args": { "query": "example" } }
```

除 `contexts` 外的请求可以加 `runtimeId`。返回 `{ "ok": true, "result": … }` 或 `{ "ok": false, "error": "…" }`。工具调用保留原始 MCP 内容，包括图片、`structuredContent` 和 `isError`。请求体上限为 1 MiB，随包客户端接收的响应上限为 64 MiB。运行时退出时移除描述文件并关闭本地入口及 MCP 连接。
