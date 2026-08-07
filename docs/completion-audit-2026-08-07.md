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
| 工作流、MCP、子 Agent 以 Pi 扩展形式随包交付 | 已验证 | Runtime 显式加载 `@suocode/workflow`、`pi-mcp-adapter`、`pi-subagents`。 |
| CLI 与 Desktop 共用 Runtime Core | 已验证 | Workspace 构建、类型检查和 Runtime smoke。 |
| 不向 Renderer 暴露 Node | 已验证 | Desktop smoke 检查 `window.require` / `window.process` 不存在。 |
| 超限桌面代码按功能域拆分 | 已验证 | 全局样式从 613 行降至 507 行；设置/MCP 与预览样式归入功能目录，生产构建和打包 Desktop smoke 通过。 |

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
| 每组最多四条、临时新对话、更多展开 | 已验证 | Desktop smoke。 |
| 会话右键归档、归档查看与恢复 | 已验证 | Runtime 与 Desktop smoke。 |
| 多会话并行、运行中和未读完成状态 | 已验证 | 多 Runtime 隔离及 UI 状态 smoke。 |
| 左右栏 40px、中栏 315px，外窗按优先级压缩 | 已验证 | Desktop smoke 的 resize 断言。 |
| macOS 红绿灯与窄栏按钮热区 | 已验证 | Desktop smoke 的按钮尺寸/命中区域断言。 |

## 活动、Todo 与子 Agent

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| Todo 与子 Agent 共用可切换活动面板 | 已验证 | `ActivityPanel` 与 Desktop smoke。 |
| 子 Agent 时间线卡片、详情、工具/消息/Reasoning 投影 | 已验证 | 标准 Pi Session fixture、Runtime smoke、Desktop smoke。 |
| 停止子 Agent | 已验证 | Runtime RPC 错误路径和 UI 控件；真实长任务停止仍需可用 Provider 环境复核。 |
| 子 Agent 不产生独立 Workspace 会话 | 已验证 | 投影基于父工具调用。 |
| macOS 不出现 `exec` Dock 图标 | 待人工复核 | 已改为真实 Helper Bundle 路径的 Headless wrapper；Desktop smoke 检查无 generic `exec`/Foreground 注册。仍需同时运行多个真实子 Agent 人工观察 Dock。 |

## 文件与预览

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| 文件树逐层懒加载 | 已验证 | Runtime 与 Desktop smoke 使用 1205 项目录 fixture。 |
| 右侧只保留文件面板 | 已验证 | Desktop smoke。 |
| 文本、Markdown、HTML、PDF 独立非模态预览 | 已验证 | 打包应用预览 smoke。 |
| 预览磁盘实时更新 | 已验证 | Desktop smoke 修改文件后检查窗口内容。 |
| 未知格式操作菜单及移到废纸篓确认 | 部分完成 | 主进程实现存在；缺少安全的打包 UI 自动化。 |

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
| 启用/停用 Server | 未完成 | 扩展 2.11.0 没有 Server enabled 字段；需要扩展薄 API/上游设计，不能另造不兼容字段。 |
| 状态、工具数量、测试连接、重连 | 已验证 | Runtime smoke 验证扩展状态和失败诊断；打包 Desktop smoke 验证设置页连接动作与状态展示。 |
| 资源数量 | 未完成 | 当前扩展公开状态只提供工具数量，需要扩展增加资源统计字段。 |
| OAuth 认证/登出 UI | 部分完成 | 认证开始、浏览器授权页、回调输入和认证完成均复用扩展流程；安全外链已测。真实 OAuth Server 与登出尚未验证/接入。 |
| 凭据遮盖和错误脱敏 | 部分完成 | 环境变量引用已支持；需要专门的错误/日志泄漏测试。 |

## Terminal 工作区

| 需求 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| Project 下打开独立 Terminal 工作区 | 未完成 | 当前只有 Agent 工具使用的终端会话，没有产品级 Terminal 页面。 |
| 多 Terminal、PTY 尺寸同步与恢复语义 | 未完成 | 需要迁移并审查 `shelf` 的已验证模块。 |
| 一键启动 Claude Code、Codex、内置 Pi | 未完成 | 尚无 UI 与外部 CLI 探测。 |

## 最终完成门槛

目标只能在以下条件全部满足后标记完成：

1. 本表不再存在 `未完成` 或 `部分完成`。
2. `待人工复核` 项已获得实际系统行为确认。
3. `npm run check`、`npm test`、Runtime smoke、最新打包 Desktop smoke 全部通过。
4. 至少一个可用 Provider 下完成真实新会话、工具、图片、MCP、子 Agent 与停止流程。
5. 最新 DMG/ZIP 从干净用户数据目录启动并完成首次配置验证。
