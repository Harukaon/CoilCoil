# SuoCode 需求完成审计

本文件是“完成所有需求并做好实际测试”的验收索引。状态只能依据当前代码、自动化测试和打包应用行为更新，不能以计划或口头说明替代。

状态说明：

- `已验证`：实现存在，并有覆盖该需求范围的自动化或打包应用证据。
- `部分完成`：已有实现，但字段、交互或测试范围仍不足。
- `未完成`：当前产品缺少该能力。
- `待人工复核`：自动化证据通过，但仍需要特定视觉或系统行为的人工确认。

## 基础产品与运行时

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| SuoCode 内置 Pi，不依赖用户本机 Pi | 已验证 | Runtime 使用私有 Agent/Session 目录；打包 smoke 验证 Home 与内置 Helper 启动器。 |
| 工作流、MCP、子 Agent 以 Pi 扩展形式随包交付 | 已验证 | Runtime 显式加载 `@suocode/workflow`；MCP 由 `pi-mcp-adapter` 提供，子 Agent 由 SuoCode 自有扩展以内嵌 child `AgentSession` 提供。 |
| CLI 与 Desktop 共用 Runtime Core | 已验证 | Workspace 构建、类型检查和 Runtime smoke。 |
| 不向 Renderer 暴露 Node | 已验证 | Desktop smoke 检查 `window.require` / `window.process` 不存在。 |
| 超限桌面代码按功能域拆分 | 已验证 | 全局样式从 613 行降至 507 行；设置/MCP 与预览样式归入功能目录，生产构建和打包 Desktop smoke 通过。 |
| 设置使用独立页面而非模态弹窗 | 已验证 | 打包 Desktop smoke 验证设置会替换工作区主界面，使用左侧栏目导航与右侧配置内容，不存在模态背景层。 |

## 对话与历史

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| 工具、Reasoning、回复按 Pi 实际事件顺序渲染 | 已验证 | 时间线投影及 Desktop smoke 的真实工具事件顺序。 |
| 工具集合摘要与展开详情 | 已验证 | Desktop smoke 覆盖展开、工具名称与输出。 |
| Markdown 表格窄栏横向滚动 | 已验证 | Desktop smoke 的 315px Markdown/代码布局断言。 |
| 普通正文、长路径和代码窄栏适配 | 已验证 | Desktop smoke 的极窄布局与溢出断言。 |
| 历史消息原地编辑与 Pi 线性回溯 | 已验证 | Desktop smoke 覆盖确认弹窗、立即截断和重新发送。 |
| 历史图片恢复、编辑、粘贴和移除 | 已验证 | 标准 Pi Session 图片 fixture 与打包 Desktop smoke 覆盖恢复、进入编辑、粘贴、移除和返回消息气泡。 |
| 文件/文件夹拖入当前编辑器为绝对路径文本 | 已验证 | Desktop smoke 覆盖底部 Composer 和历史编辑器。 |
| 流式输出只在用户位于底部时自动跟随 | 已验证 | Desktop smoke 覆盖用户上滚后不被强制拉回。 |
| Provider 连接失败仍保留已发生事件 | 已验证 | 标准 Pi Session fixture 在已完成子 Agent 工具事件后注入 Provider error，打包 Desktop smoke 验证工具卡与错误消息同时保留。 |

## 工作区、会话和布局

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| Home 与多个 Workspace 同时挂载 | 已验证 | Desktop smoke。 |
| Workspace 行只展开/折叠，不自动切会话 | 已验证 | Desktop smoke。 |
| Workspace 与会话列表使用紧凑纵向间距 | 已验证 | 每组只在会话列表末尾保留 3px，组间 2px；打包 Desktop smoke 检查最终计算样式。 |
| 每组最多四条、临时新对话、更多展开 | 已验证 | Desktop smoke。 |
| 会话右键归档、归档查看与恢复 | 已验证 | Runtime 与 Desktop smoke。 |
| 单 Runtime 进程内的多会话并行、运行中和未读完成状态 | 已验证 | Runtime Server 单元测试、真实 MiniMax M3 并发 smoke，以及打包应用进程树检查；切换会话不终止后台 Agent。 |
| 左右栏 40px、中栏 315px，外窗按优先级压缩 | 已验证 | Desktop smoke 的 resize 断言。 |
| macOS 红绿灯与窄栏按钮热区 | 已验证 | Desktop smoke 的按钮尺寸/命中区域断言。 |

## 活动、Todo 与子 Agent

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| Todo 与子 Agent 共用可切换活动面板 | 未完成 | 合并自有子 Agent 引擎时已移除依赖旧扩展结构的专用 UI；等待按稳定 Runtime 协议重建。 |
| 子 Agent 时间线卡片、详情、工具/消息/Reasoning 投影 | 未完成 | Runtime 已提供结构化活动、消息与工具摘要；Desktop 专用投影视图尚待重建。 |
| 停止子 Agent | 部分完成 | Runtime 已提供 stop/status/resume RPC；Desktop 停止入口尚待按新协议接回。 |
| 子 Agent 不产生独立 Workspace 会话 | 已验证 | 投影基于父工具调用。 |
| macOS 不出现 `exec` Dock 图标 | 已验证 | 子 Agent 直接创建进程内 child `AgentSession`，不再派生外部 `exec` 应用；live Desktop smoke 继续检查 Runtime 后代进程的 LaunchServices 注册。 |

## 文件与预览

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| 文件树逐层懒加载 | 已验证 | Runtime 与 Desktop smoke 使用 1205 项目录 fixture。 |
| 文件树右键复制绝对路径与相对路径 | 已验证 | Typed IPC 使用 Electron 系统剪贴板；打包 Desktop smoke 打开文件右键菜单并通过 `pbpaste` 验证两种路径。 |
| 右侧只保留文件面板 | 已验证 | Desktop smoke。 |
| 文本、Markdown、HTML、PDF 右栏分栏预览 | 已验证 | 文件树保持可操作，预览内容实时更新。 |
| 预览磁盘实时更新 | 已验证 | Desktop smoke 修改文件后检查窗口内容。 |
| 未知格式操作菜单及移到废纸篓确认 | 已验证 | 打包 Desktop smoke 通过 typed preload 触发未知格式路径，并验证“在访达中显示 / 作为文本尝试预览 / 移到废纸篓”三项原生菜单动作；删除仍由主进程确认框保护。 |

## 性能与上下文

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| 首字、tok/s、输出 token、缓存 token 持久化 | 已验证 | Runtime metrics fixture 与 Desktop smoke。 |
| 无数据时隐藏性能摘要 | 已验证 | Desktop smoke。 |
| GitHub contribution 风格请求方块与悬浮详情 | 已验证 | Desktop smoke。 |
| 放宽黄/红评级 | 已验证 | 评级逻辑与 UI smoke。 |
| 上下文圆环与性能信号交互 | 已验证 | Desktop smoke。 |

## MCP

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| 复用 `pi-mcp-adapter`，不重写 MCP 协议 | 已验证 | 配置、连接、状态和 OAuth 动作均调用扩展原生实现；SuoCode 只增加事件总线与 typed IPC 薄桥。 |
| UI 新增/编辑/复制/移除，全局和项目作用域 | 已验证 | Runtime smoke 与最新打包 Desktop smoke 均覆盖扩展原生配置、复制、项目作用域和移除。 |
| stdio、HTTP、env、headers、auth、生命周期、超时、direct tools、排除、资源、debug | 已验证 | Typed bridge 直接映射扩展原生 schema；Runtime smoke 覆盖持久化，打包 Desktop smoke 覆盖高级字段。 |
| 启用/停用 Server | 已验证 | 升级并固定 `pi-mcp-adapter` 2.21.0，直接调用其 `writeProjectServerDisabledOverride` 与 reload 生命周期；Runtime smoke 和打包 Desktop smoke 均覆盖停用、状态投影和恢复启用。 |
| 状态、工具数量、测试连接、重连 | 已验证 | Runtime 订阅扩展稳定事件 `pi-mcp-adapter/status/v1`；干净 HOME 的 Runtime smoke 使用官方 MCP SDK stdio fixture 完成真实连接和工具发现，并保留失败诊断覆盖；打包 Desktop smoke 验证设置页动作与状态展示。 |
| 资源数量 | 已验证 | 直接投影 `pi-mcp-adapter` 2.21.0 原生状态中的 `resourceCount` / `totalResources`；真实 stdio fixture 暴露资源并验证发现计数，设置页展示服务器与汇总资源数。 |
| OAuth 认证/登出 UI | 已验证 | 使用官方 MCP SDK 的本地受保护 Resource Server 与 OAuth Provider，Runtime smoke 完成 DCR、PKCE、授权回调、Token 交换、受保护工具发现、登出及登出后重新要求认证；产品仍复用 `pi-mcp-adapter` 原生命令/流程。 |
| 凭据遮盖和错误脱敏 | 已验证 | MCP 编辑器对敏感 env/header 键只显示掩码并在未修改时保留原值；Runtime 对扩展动作文本、结构化 details 和错误执行递归脱敏。Runtime 与打包 Desktop smoke 使用哨兵凭据验证不回显。 |

## Terminal 工作区

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| Project 下打开独立 Terminal 工作区 | 已验证 | Workspace 行提供独立终端入口；打开后不创建 Agent 对话，右侧继续使用惰性目录树。 |
| 多 Terminal、PTY 尺寸同步与恢复语义 | 已验证 | Electron main 持有多 PTY，xterm/FitAddon 同步尺寸；切换视图不杀进程，renderer 重挂载通过有界缓冲恢复。完整退出明确终止 PTY，不伪造跨进程重连。 |
| 一键启动 Claude Code、Codex、内置 Pi | 已验证 | 打包 Terminal Desktop smoke 验证普通 shell、Claude Code、Codex 和安装包内置 Pi 均在项目 cwd 中启动；内置 Pi 显式加载 SuoCode 工作流扩展且不读取用户 PATH 中的 Pi。 |

## 最终完成门槛

目标只能在以下条件全部满足后标记完成：

1. 本表不再存在 `未完成` 或 `部分完成`。
2. `待人工复核` 项已获得实际系统行为确认。
3. `npm run check`、`npm test`、Runtime smoke、最新打包 Desktop smoke 全部通过。
4. 至少一个可用 Provider 下完成真实新会话、工具、图片、MCP、子 Agent 与停止流程。
5. `npm run smoke:concurrency` 验证单进程会话复用和打开耗时；`npm run smoke:concurrency:live` 使用 MiniMax M3 验证一个会话运行时切换并运行另一个会话，随后两个会话均独立完成。
5. 最新 DMG/ZIP 从干净用户数据目录启动并完成首次配置验证。

## 最终验证记录

- `npm run check`：通过。
- `npm test`：47/47 通过。
- `node scripts/runtime-smoke.mjs`：通过。
- `node scripts/runtime-smoke.mjs --live`：MiniMax M3 真实模型与工具执行通过。
- `node scripts/desktop-smoke.mjs`：最新打包应用通过。
- `node scripts/desktop-smoke.mjs --live`：MiniMax M3 真实 Agent、工具、恢复会话、子 Agent 停止与打包进程检查通过。
- `npm run package:desktop`：生成最新 arm64 DMG 与 ZIP；测试使用独立临时用户数据目录启动打包应用。
