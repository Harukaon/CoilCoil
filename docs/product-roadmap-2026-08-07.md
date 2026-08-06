# SuoCode 产品演进路线

本文档把桌面端后续大型需求整理成可实施的阶段。SuoCode 始终是自包含产品：运行时、Pi、MCP、子 Agent 和工作流均由 SuoCode 安装包维护，不调用用户本机安装的 Pi，也不依赖 `/Users/hao/Desktop/project/hao-pi-workflow` 或 `/Users/hao/Desktop/project/shelf` 才能运行。这两个项目仅作为迁移来源和设计参考。

## 阶段 0：组件拆分门槛

在 Terminal 工作区和高级子 Agent UI 开发前，先拆分当前大型桌面组件。

### 建议约束

- React 页面或功能组件超过 400 行时必须评审拆分；超过 600 行不得继续叠加新功能。
- 单个 hook、状态控制器或纯逻辑模块超过 300 行时评审职责边界。
- 样式按功能域拆分，避免所有布局、会话、Composer、文件树和弹窗继续共用一个无边界样式文件。
- 拆分不是机械分文件：运行状态、持久状态、视图状态和 IPC 副作用必须有明确所有者。

### 目标结构

```text
apps/desktop/src/renderer/src/
├── app/                 # 应用壳、路由、顶层状态组装
├── features/
│   ├── conversation/    # 时间线、消息、reasoning、工具集合
│   ├── composer/        # 输入、图片、模型菜单、性能状态
│   ├── workspaces/      # Workspace、会话列表、归档
│   ├── activity/        # Todo、子 Agent、运行状态面板
│   ├── files/           # 懒加载文件树、拖放、预览
│   ├── terminal/        # 后续 Terminal 工作区
│   └── settings/        # Provider、模型和凭据
├── hooks/               # runtime 订阅和可复用交互
└── ui/                  # 小型通用组件
```

### 完成标准

- 拆分前后现有用户行为一致。
- 关键 reducer/投影逻辑有单元测试。
- App 顶层只负责组合，不直接承载所有消息、文件树和弹窗细节。

## 阶段 1：通用活动面板

当前输入框上方的 Todo 面板升级为通用活动面板，作为 Todo、子 Agent 和以后后台任务的统一入口。

### 显示规则

- 只有 Todo：标题显示 `Todo`。
- 只有子 Agent：标题显示 `N 个代理正在执行`，结束后显示完成数量。
- Todo 与子 Agent 同时存在：顶部提供紧凑的分段切换，不并排堆叠两套大面板。
- 面板折叠时只保留摘要；展开时显示当前分类的详细列表。

### 子 Agent 列表

每个子 Agent 至少展示：

- 名称或任务摘要
- 排队、运行、完成、失败、已停止状态
- 已执行轮数
- 工具调用次数
- 运行时间
- 活跃任务的“停止”按钮

主会话时间线只展示紧凑的子 Agent 活动卡，不创建新的 Workspace 会话记录。点击卡片打开非阻塞的详情窗口，查看子 Agent 的消息、reasoning 和工具事件。

### Runtime 要求

不能只把 `subagent` 当作普通工具调用。运行时协议需要投影：

- 父任务与子任务 ID
- 子任务生命周期事件
- 子任务消息和工具事件
- 轮数、工具数和 usage
- 停止单个子任务的命令与结果

## 阶段 2：Terminal 工作区

将 `/Users/hao/Desktop/project/shelf` 中已经验证的终端渲染与扫描逻辑迁移到 SuoCode，但最终代码、依赖和运行时都归 SuoCode 所有。

### 产品形态

```text
左：工作区/文件夹    中：Terminal    右：目录树与辅助面板
```

- 在指定 Project 下打开 Terminal 工作区。
- Terminal 初始 cwd 为对应工作区目录。
- 支持从界面立即启动 Claude Code、Codex 和 SuoCode 内置 Pi。
- 打开 Terminal 工作区本身不创建新的 Agent 对话记录。
- 复用 shelf 的终端显示、PTY、尺寸同步和目录扫描经验，但先审查许可证、依赖和模块边界。
- 多个终端可独立运行；关闭视图不应误杀仍需保留的后台任务。

### 实施前置

1. 完成阶段 0 的组件拆分。
2. 把 PTY 生命周期放在 Electron main/runtime，不放进 React renderer。
3. 定义 Terminal session 协议、恢复策略和退出语义。
4. 明确 Claude Code/Codex 属于用户选择启动的外部 CLI；SuoCode Pi 使用安装包内置 CLI。

## 阶段 3：会话归档与管理

- 会话只提供“归档”，不直接删除。
- Workspace 会话行提供右键菜单。
- 默认列表隐藏已归档会话。
- 后续提供归档视图、恢复和永久清理数据的独立管理入口。
- 临时“新对话”未产生内容时不持久化。

## 阶段 4：文件与预览增强

- 文件树继续采用按需扫描：只读取根目录和用户实际展开的目录。
- 文件/文件夹拖入文本编辑器时插入带单引号的绝对路径纯文本。
- 文件预览保持非阻塞、可移动，并实时响应磁盘变化。
- Markdown、HTML、PDF 和文本预览继续使用独立渲染器；未知格式提供“在访达中显示”“以文本方式尝试打开”“归档/移除”等安全操作。
- Diff 与工作区文件回滚需要先评估 Pi 是否提供可靠事件和快照能力，再决定是否实现；不把聊天回溯错误地等同于文件回滚。

## 阶段 5：请求性能与上下文可视化

- 每次模型请求保存首 token 延迟、输出 tok/s、输出 token、可用的缓存 token 与上下文占用。
- 缓存字段只展示，不参与速度评级。
- 没有有效字段时隐藏，不显示破折号占位。
- 性能历史采用类似 GitHub contribution graph 的紧凑方块：一个方块代表一次请求，颜色表达综合体验，悬浮后才显示详细数据。
- 首字 7–16 秒且输出 25–90 tok/s 通常应评为黄色或中等，而不是直接判红；评级应同时考虑首字与持续输出，不使用过严单阈值。
- 上下文圆环与信号图标位置保持一致，点击分别查看上下文和请求性能详情。

## 阶段 6：MCP 配置管理 UI

MCP 不能只作为安装包内置扩展存在。SuoCode Desktop 需要向用户提供完整的 MCP 管理界面，让用户直接配置自己的 MCP Server。

### 产品边界

- 配置由 SuoCode 前端管理，通过 typed IPC 交给 Runtime 校验和保存。
- 配置保存到 SuoCode 自己的应用数据目录，不读取、覆盖或修改用户本机 Pi 的 `~/.pi/agent/mcp.json`。
- Desktop 与 CLI 共享同一份 SuoCode MCP 配置模型；项目级配置可以覆盖或补充全局配置。
- Renderer 不直接读写配置文件，不直接持有长期明文凭据。

### 管理能力

- 查看已配置的 MCP Server 列表。
- 新增、编辑、复制、启用、停用和移除 Server。
- 支持常见连接形式：
  - stdio：command、args、cwd、env
  - HTTP / Streamable HTTP：URL、headers
  - SSE：URL、headers
- 支持全局 MCP 和项目级 MCP，并清楚显示配置来源与生效范围。
- 提供“测试连接”，展示连接中、可用、需要认证、配置错误、启动失败和超时状态。
- 成功连接后展示 Server 暴露的 tools、resources 和 prompts。
- 支持刷新和重新连接，不需要重启整个 SuoCode。
- 删除或修改正在使用的 Server 时给出影响提示，并安全终止旧连接。

### 凭据与环境变量

- 敏感值使用系统安全存储或 SuoCode 的凭据层保存，配置文件只保留引用，不落明文。
- UI 中默认遮盖 token、Authorization header 和其他 secret。
- 支持为 stdio Server 配置环境变量，并区分普通值与敏感值。
- 导出配置时默认排除敏感值。
- Runtime 日志、工具结果和错误信息不得泄露凭据。

### 前端交互建议

- 设置页新增独立的 `MCP` 分类，不与模型/Provider 下拉菜单混在一起。
- 列表页展示名称、连接类型、作用域、启停状态和健康状态。
- 编辑使用侧栏或独立设置页面，不使用会遮挡 Agent 工作区的全屏阻塞弹窗。
- 测试连接时实时显示步骤与错误原因，避免只返回“连接失败”。

### Runtime 协议

需要增加以下 typed commands/events：

- `list_mcp_servers`
- `create_mcp_server`
- `update_mcp_server`
- `remove_mcp_server`
- `set_mcp_server_enabled`
- `test_mcp_server`
- `refresh_mcp_server`
- MCP 状态、认证请求和能力列表事件

所有写操作由 Runtime 完成，并进行 schema 校验、路径校验、命令参数校验和敏感字段处理。

### 验收标准

1. 全新安装、不依赖本机 Pi 配置即可从 UI 添加一个 MCP Server。
2. 重启应用后配置和启停状态能够恢复。
3. Agent 只看到当前启用且连接成功的 MCP 能力。
4. 项目级 Server 不会错误暴露给其他 Workspace。
5. 配置错误能够定位到具体字段，凭据不会出现在日志或界面错误详情中。
6. MCP Server 异常退出后 UI 能更新状态并允许重新连接。

## 暂不承诺的能力

以下功能需要先完成技术调查，不纳入当前 UI 修复的完成条件：

- 聊天回溯时自动恢复 Agent 已修改的工作区文件。
- 完整 Git diff 编辑器。
- 基于本地 Git 或文件快照的任意时间点恢复。

调查必须明确 Pi 原生支持范围、存储成本、跨平台行为和大仓库性能，再决定是否进入实施阶段。
