# oh-my-pi 可借鉴功能对照表（2026-08-19）

调研对象：[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)（下称 omp）。

## 为什么值得抄

- omp 是 **pi-mono（即我们 vendor/pi 的上游 earendil-works/pi）的 fork**，25.6k stars、MIT 协议、18k+ commits、迭代极快（每天发版）。
- 与 SuoCode 同源：同一套 agent/extension/tool API 血统。很多能力不是"参考思路"，而是**可以直接以 npm 包依赖**（`@oh-my-pi/hashline`、`@oh-my-pi/pi-mnemopi`、`@oh-my-pi/omptype` 等都独立发包）或小范围移植。
- 它是 TUI 产品，我们是 Electron 桌面产品——凡是"runtime 层"的能力都可平移，"TUI 层"的能力需要换成我们的桌面 UI。

## 改动量标尺

- **S** < 300 行；**M** 300–1500 行；**L** 1500–5000 行；**XL** 引入子系统 / Rust native / 需长期维护。

## 对照表

| # | 借鉴项 | 作用（解决什么） | SuoCode 现状 | 集成路径 | 改动量 | 建议 |
|---|--------|------------------|--------------|----------|--------|------|
| 1 | **Hashline 哈希锚点编辑**（`@oh-my-pi/hashline`） | edit 工具用"行内容哈希锚点"取代原文匹配：编辑失败率大降、输出 token 省 ~61%、改到过期文件会被拒绝而不是写坏 | 用 vendor/pi 自带 edit（原文匹配），string-not-found 重试常见 | 直接依赖 npm 包，在 runtime-core 里注册替换版 edit 工具 + system prompt 说明 | **M** | ⭐ 高优先，性价比最高 |
| 2 | **子代理工作区隔离**（task 工具 + pi-iso） | 并行子代理各自在隔离工作区（APFS clone / overlayfs / git worktree）跑，互不踩踏、无合并冲突 | 已有 subagent 派发与 UI，消息里已预留 `worktreePath` 字段但未真正隔离 | 第一步用 `git worktree` 实现（纯 Node 可做）；pi-iso 的 APFS clone 是 Rust，可后置 | **M**（git worktree 版）/ XL（native 版） | ⭐ 高优先，用户点名要的"子引擎多工作区" |
| 3 | **Agent Hub 子代理管理台** | 实时查看每个子代理的转录/用量，可发消息引导（steer）、唤醒、单杀，而不用中断父会话 | 已有 SubagentActivity 卡片 + 详情弹窗（只读） | runtime-protocol 加 steer/kill 消息 → runtime-core 转发给子代理 → desktop 弹窗加输入框和按钮 | **M** | ⭐ 高优先，在现有 UI 上补交互即可 |
| 4 | **子代理结构化输出**（schema-validated yield） | 子代理按 JSON Schema 返回类型化结果，父代理直接读字段，不用解析散文 | 子代理只回自由文本 | task 工具加 schema 参数 + 结果校验（可用 `@oh-my-pi/omptype` 或 zod） | **S–M** | ⭐ 配合 #2/#3 一起做 |
| 5 | **Advisor 第二模型旁观** | 挂一个便宜的旁观模型读每个 turn，内联注入提醒/质疑/硬阻断，抓住主模型赶工漏掉的问题 | 无 | runtime-core 在 turn 边界调第二模型，注入 system reminder；desktop 显示 advisor 便签卡片 | **M** | 高价值，差异化功能 |
| 6 | **时间旅行流规则**（TTSR） | 规则平时不占上下文；正则命中流式输出时中断、注入规则、原点重试——"不为每条规则付上下文税" | 规则只能进 system prompt | 在 runtime-core 的流式处理管道加正则监听 + abort/retry；规则文件加载器 | **M–L** | 高价值，实现有一定精细度要求 |
| 7 | **conflict:// 冲突解决** | 每个 merge 冲突变成一个可读写 URL，写 `@theirs/@ours/@base` 即解决，支持 `conflict://*` 批量 | 无（冲突靠 bash） | read/write 工具的路径解析层加一个 scheme handler | **S–M** | 值得做，小而美 |
| 8 | **omp commit 原子拆分提交** | 把工作区改动按依赖序拆成多个原子 commit，锁文件排除、源码权重高于测试/文档 | 无 | 以技能（skill）+ git 辅助工具实现即可，不必进 runtime | **S–M** | 值得做，可先做成内置技能 |
| 9 | **/review 分级评审** | 评审产出 P0–P3 分级 + 置信度 + 能不能发布的结论，并行 reviewer 子代理扫分支/commit/未提交改动 | 无固定评审流 | 内置技能 + 子代理编排（workflow 包已有基础） | **S–M** | 值得做 |
| 10 | **配置继承**（8 种格式免迁移） | 直接读 `.claude`/`.cursor`/`.windsurf`/`.codex`/copilot 等已有 rules/skills/MCP，零迁移 | pi-mcp-adapter 已导入 MCP 部分（Cursor/Claude/Codex）；rules/skills 未继承 | 扩展 skill/rules 加载器识别各家目录与格式 | **M** | 值得做，降低用户迁移成本 |
| 11 | **内部 URL scheme 家族**（pr:// issue:// agent:// skill://） | GitHub PR/issue、子代理输出、技能都变成"文件系统路径"，一个 read 工具通吃，模型零学习成本 | 无 | read/grep 工具加 scheme 解析层，逐个 scheme 增量加 | **L**（全家桶）/ 每个 scheme **S–M** | 按需挑 pr:// 和 agent:// 先做 |
| 12 | **LSP 接入** | 写文件即时拿诊断，rename 走 willRenameFiles 正确更新 re-export；"IDE 知道的 agent 都知道" | 无 | lsp 工具 + language server 生命周期管理（omp 有配置文档可参考） | **L** | 中期做，收益大但工程量实 |
| 13 | **Mnemopi 记忆引擎**（`@oh-my-pi/pi-mnemopi`） | 本地 SQLite 记忆库：retain/recall/reflect/learn，会话间自动携带项目心智模型 | 已有 memory workspace（文件式） | 直接依赖 npm 包做可选后端 | **M** | 中期做 |
| 14 | **eval 持久内核**（Python/JS 双内核 + 工具回调） | 持久 REPL 单元格，内核内可回调 agent 工具（Python 里 tool.read 读文件再用 JS 画图） | 有 bash/终端，无持久 REPL | 子进程内核 + loopback 桥；桌面端可做成真正的 notebook UI | **L** | 中期做，桌面端展示反而是我们的优势 |
| 15 | **ast_edit / ast_grep 结构化改写** | tree-sitter 结构查询 + 预览后接受（proposed → Accept）的原子改写 | 无 | 依赖 ast-grep（有 npm 发行）+ 预览/接受 UI | **M–L** | 中期做，"预览后接受"与桌面 UI 很搭 |
| 16 | **omp-stats 用量看板** | 本地 AI 用量统计仪表盘 | 已有 runtime 指标/性能弹窗，无历史聚合 | 聚合落 SQLite + desktop 图表页 | **S–M** | 低优先 |
| 17 | **/collab 会话协作**（relay + 链接/二维码加入） | 把会话放上中继，别人终端或浏览器加入围观/共驾，端侧加密 | 无 | 需要 relay 服务 + 协议 + 权限模型 | **XL** | 暂缓，观望 |
| 18 | **DAP 调试器驱动** | agent 直接开 lldb/dlv/debugpy 断点单步看变量，而不是撒 print | 无 | debug 工具 + DAP 客户端 | **L–XL** | 暂缓 |
| 19 | **原生 Rust 工具链**（in-process rg/bash/58 个 coreutils） | 零 fork-exec、Windows 原生无 WSL | 用系统 shell（node-pty） | 需引入 Rust/N-API 构建链 | **XL** | 暂缓，桌面场景收益有限 |
| 20 | **浏览器 relay 扩展**（接管用户已开的 Chrome 标签页） | agent 直接驱动用户现有浏览器会话，不抢焦点、带登录态 | 已有内置 browser panel（webview + CDP），能力不同向 | Chrome 扩展 + 本地 relay | **L** | 暂缓，与现有内置浏览器定位重叠 |

## 建议的第一批（审计通过后）

1. **#1 Hashline**：一个依赖 + 一个工具注册，立刻提升编辑可靠性。
2. **#2 + #4 子代理隔离与结构化输出**（git worktree 版）：用户点名的核心诉求。
3. **#3 Agent Hub 交互**：现有子代理 UI 已完成 70%，补 steer/kill 即闭环。
4. **#7 conflict:// / #8 原子提交 / #9 分级评审**：三个小而美，各自独立可单独上。

## 风险与注意

- omp 更新极快（日更），**抄接口语义、别抄实现细节**，避免跟着它的内部重构走。
- 直接依赖 `@oh-my-pi/*` 包时锁定版本，纳入 vendor 审计流程（MIT，无合规问题）。
- omp 的 TUI 交互（hotkey、卡片流）不必照搬，桌面端应转译成我们的面板/弹窗语言。
