# SuoCode 产品演进路线

本文档把桌面端后续大型需求整理成可实施的阶段。SuoCode 始终是自包含产品：运行时、Pi、MCP、子 Agent 和工作流均由 SuoCode 安装包维护，不调用用户本机安装的 Pi，也不依赖 `$PROJECT_ROOT/hao-pi-workflow` 或 `$PROJECT_ROOT/shelf` 才能运行。这两个项目仅作为迁移来源和设计参考。

## 总体实现原则：扩展优先

新增 Agent 能力时，优先寻找并复用成熟的 Pi 扩展，而不是在 SuoCode 中重新实现相同能力。

- Pi 扩展负责真正的工具、协议、生命周期和 Agent 行为。
- SuoCode Runtime 提供很薄的状态/配置桥接。
- SuoCode Desktop 提供用户需要的配置界面、运行状态、预览、停止和错误诊断。
- 如果扩展只提供 TUI，优先为扩展增加可复用的 headless 状态 API，再由 GUI 消费。
- 如果现有扩展基本可用但缺少少量能力，优先做薄 fork、补丁或上游贡献；避免复制后形成两套长期分叉的实现。
- 选用第三方扩展前检查许可证、维护状态、打包兼容性、安全边界和事件可观测性，并固定版本。
- 所有扩展随 SuoCode 安装包交付，绝不在运行时依赖用户本机 Pi 已安装的扩展。

典型应用：

- MCP：复用 `pi-mcp-adapter`，GUI 只编辑配置并展示扩展状态。
- 子 Agent：使用 SuoCode 自有 Pi 扩展以内嵌 child `AgentSession` 执行，GUI 只消费 Runtime 标准化后的活动、详情和控制协议。
- Todo：复用现有结构化 Todo 扩展，GUI 将状态投影为活动面板。
- 后续能力在立项时先完成“可复用扩展调查”，再决定是否自行实现。

每项新需求开始前必须记录：候选扩展、能力归属、配置格式、可观察事件、停止/恢复方式、打包兼容性，以及 GUI 所需的最小薄桥。没有完成这一步，不直接在 Desktop 或 Runtime Core 中另起一套协议、状态机或工具实现。

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

> 当前决策：本轮暂缓 Terminal 会话化、浅色主题、文件拖入终端和会话清理等修改，保留现有实现，待产品形态重新确认后再继续。

将 `$PROJECT_ROOT/shelf` 中已经验证的终端渲染与扫描逻辑迁移到 SuoCode，但最终代码、依赖和运行时都归 SuoCode 所有。

当前实现状态：首版已接入。PTY 由 Electron main 管理，桌面端使用 xterm/FitAddon；普通终端、Claude Code、Codex 和 SuoCode 内置 Pi 可以并行运行。内置 Pi 通过安装包路径启动并显式加载 SuoCode 自带扩展。完整应用退出后不恢复已经死亡的 PTY，后续若需要跨重启任务恢复，应采用可重连的后台会话服务，而不是伪造 PTY 重连。

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

## 阶段 3.5：项目级记忆

- 继续复用 SuoCode 内置的 `project-memory` Pi 扩展，不在 Desktop 另写一套记忆系统。
- 每次 Agent 请求完全 settled 后，扩展使用 SuoCode 安装包内置的 Pi CLI 启动隔离后台 worker，整理当前 session。
- 记忆按项目根目录隔离，写入 SuoCode 私有 Agent 数据目录下的项目 `MEMORY.md`，不写入用户项目，也不读取用户本机 Pi 的记忆目录。
- 同一项目后续新对话通过 `before_agent_start` 注入现有项目记忆；不同项目之间不得串用。
- 项目锁防止同一项目重复并发整理；记忆 worker 不得创建窗口、Dock 图标或依赖用户 shell 中的 Pi。
- `/memory` 仍保留为用户主动触发的手动入口。

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

## 阶段 5.5：Agent 运行时管理中心

主工作区增加高频“技能”入口，右侧栏增加“运行时”视图，用于查看和管理当前 Session 真正生效的上下文、System Prompt、技能、MCP 与项目记忆。设置页继续负责持久配置，运行时视图负责当前会话的状态和高频控制。

详细产品边界、数据口径、上下文精简安全要求和 typed protocol 见 [`agent-runtime-management.md`](./agent-runtime-management.md)。在运行时只读快照完成前，不直接实现历史工具结果删除或 System Prompt 原位修改。

## 阶段 6：MCP 配置管理 UI

MCP 的协议实现、连接管理和工具暴露全部复用 SuoCode 已内置的 `pi-mcp-adapter`。SuoCode Desktop 只为这个扩展提供图形化配置界面，不重新实现 MCP Client、Transport、OAuth、工具发现或资源调用。

### 产品边界

- `pi-mcp-adapter` 是唯一的 MCP 实现层，继续负责 stdio、Streamable HTTP、SSE fallback、OAuth、生命周期、连接测试、工具缓存和代理工具。
- SuoCode 不定义另一套 MCP Server schema，UI 字段直接对应固定版本 `pi-mcp-adapter` 2.21.0 支持的配置格式。
- 全局配置写入 SuoCode 自己的 Agent 目录下的 `mcp.json`，不读取、覆盖或修改用户本机 Pi 的 `~/.pi/agent/mcp.json`。
- 项目级配置沿用扩展已支持的 `.mcp.json` / `.pi/mcp.json` 规则，不创造新的 SuoCode 专有 MCP 文件格式。
- Renderer 不直接读写文件；Electron/Runtime 只充当安全的配置读写桥梁。

### 管理能力

- 查看已配置的 MCP Server 列表。
- 新增、编辑、复制、启用、停用和移除 Server。
- UI 映射扩展现有配置字段，包括：
  - stdio：command、args、cwd、env
  - HTTP：url、headers、auth
  - lifecycle、idleTimeout、requestTimeoutMs
  - directTools、excludeTools、exposeResources、debug
- 支持全局 MCP 和项目级 MCP，并清楚显示配置来源与生效范围。
- “测试连接”“重新连接”“认证”和状态展示调用 `pi-mcp-adapter` 已有能力，不在 SuoCode 中另写连接器。
- 成功连接后的 tools、resources 和状态信息直接使用扩展已有的 manager/cache 结果。
- 启用与停用使用扩展原生 `disabled` 配置和项目级 override writer，不创建 SuoCode 专有开关。
- 状态面板订阅扩展稳定的 `pi-mcp-adapter/status/v1` 事件，直接投影工具、资源、连接和停用统计。
- 保存配置后通知当前 Agent Session reload，或者调用扩展现有 reconnect 流程，不需要重启整个 SuoCode。

### 凭据与环境变量

- 优先使用扩展已经支持的 `${VAR}`、`$env:VAR` 和 `bearerTokenEnv` 引用，不改变其插值语义。
- 后续可由 SuoCode 凭据层为这些环境变量提供安全值，但不能修改 `pi-mcp-adapter` 期望的配置结构。
- UI 中默认遮盖 token、Authorization header 和其他 secret。
- 导出配置时默认排除敏感值。
- Runtime 日志、工具结果和错误信息不得泄露凭据。

### 前端交互建议

- 设置页新增独立的 `MCP` 分类，不与模型/Provider 下拉菜单混在一起。
- 列表页展示名称、连接类型、作用域、启停状态和健康状态。
- 编辑使用侧栏或独立设置页面，不使用会遮挡 Agent 工作区的全屏阻塞弹窗。
- 测试连接时把扩展返回的状态和错误清晰展示出来，避免只显示“连接失败”。

### SuoCode 桥接层

SuoCode 仍需要少量 typed IPC，但它们只是前端和主进程之间的配置桥，不是 MCP 协议实现：

- 读取扩展当前生效的配置和来源。
- 保存全局或项目级配置。
- 请求当前 Session reload/reconnect。
- 把扩展已有的状态、认证请求和错误转发给前端。

桥接层不直接使用 `@modelcontextprotocol/sdk` 建立连接，也不复制 `pi-mcp-adapter` 的 server manager。若扩展缺少稳定的程序化入口，优先给上游扩展补一个很薄的公共配置/状态 API，而不是在 SuoCode 内重写一套。

### 验收标准

1. 全新安装、不依赖本机 Pi 配置即可从 UI 添加一个 MCP Server。
2. 重启应用后配置和启停状态能够恢复。
3. 保存后由同一个 `pi-mcp-adapter` 扩展重新加载，Agent 能正常使用对应 MCP 能力。
4. 项目级 Server 不会错误暴露给其他 Workspace。
5. 配置错误能够定位到具体字段，凭据不会出现在日志或界面错误详情中。
6. MCP Server 异常退出后 UI 能更新状态并允许重新连接。
7. SuoCode 代码中不存在第二套 MCP transport、OAuth 或工具发现实现。

## 暂不承诺的能力

以下功能需要先完成技术调查，不纳入当前 UI 修复的完成条件：

- 聊天回溯时自动恢复 Agent 已修改的工作区文件。
- 完整 Git diff 编辑器。
- 基于本地 Git 或文件快照的任意时间点恢复。

调查必须明确 Pi 原生支持范围、存储成本、跨平台行为和大仓库性能，再决定是否进入实施阶段。
