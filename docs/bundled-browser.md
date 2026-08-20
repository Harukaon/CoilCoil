# CoilCoil 内置浏览器

CoilCoil 的内置浏览器由 Renderer 中的 `<webview>` guest 渲染，元素挂在应用根部一个
常驻图层里，主进程通过 `getWebContentsId()` 拿到 guest 的 WebContents 后接管全部
控制。Agent 侧只接入官方
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)：服务器
启动后预加载可搜索的工具元数据，但 `directTools: false` 保证浏览器工具 schema 不进入
模型的默认工具面。Agent 必须通过统一 MCP 网关按需搜索、描述和调用，普通编码会话的
浏览器直接工具数始终为零。

## 安全边界

- 不启动外部 Chrome，也不下载独立浏览器内核。
- 不开启 Electron 全局 `--remote-debugging-port`。
- 主进程只为已绑定的浏览器 guest 暴露私有 CDP 桥；应用 Renderer、设置页和其他
  WebContents 不在可发现目标中。所有目标枚举与查找都只走主进程的标签页表，
  且过滤掉尚未公告的标签页。
- **guest 绑定是本方案的信任边界。** 元素由 Renderer 创建，因此由它提名
  `tabId → webContentsId` 的对应关系。主进程逐条校验后才绑定，任何一条不过即拒绝
  并抛错（Renderer 随即移除该元素）：每标签页一次性 nonce、
  `hostWebContents` 必须是本窗口、`getType()` 必须是 `webview`、session 必须是
  `persist:coilcoil-browser`、且该 webContentsId 未绑定到其他标签页。最后一条是防止
  跨 scope 串线的承重墙 —— 下游的 scope 校验只检查标签页记录上的 scope，
  不检查其背后 WebContents 的身份。绑定一次成立后永不静默改绑。
- 下发给 Renderer 的 guest 名册只含 `{tabId, nonce}`，不含 URL、不含 scopeId：
  应用 DOM 因此永远不持有任何 agent 的浏览状态。
- `webviewTag` 只在主窗口开启，且由 `will-attach-webview` 兜底：删除
  `preload`/`preloadURL`/`preloadURLs`，强制 sandbox、contextIsolation 与
  `nodeIntegration=false`，覆写（而非读取）`webpreferences`/`disablewebsecurity`
  等属性字符串，并拒绝分区不符或自行指定 `src` 的 guest。其余所有 WebContents
  一律 `preventDefault()`。
- CDP WebSocket 仅监听 `127.0.0.1`，使用随机路径和随机 Bearer Token；地址与
  凭据只通过内置 Runtime 子进程环境传递。
- `Browser.close` 会被拦截；网页、本地文件、`data:` 等 Chromium 可加载地址均由
  内置浏览器承载，不把应用 Renderer 暴露给 Agent。
- 浏览器 MCP 只注入 Agent 的有效能力视图，不写入用户或工作区的 MCP 配置文件。
- 每个 Agent 会话拥有独立的 capability scope。它只能发现和操作自己创建的标签页；
  后台会话不会切走用户当前右栏，运行时归档或被回收时会同时关闭其 CDP 连接和网页。

## 渲染方式的取舍（2026-08 复审）

内置浏览器最初由主进程 `WebContentsView` 渲染。该方案的致命问题是**原生视图无条件
合成在 Renderer 之上**：应用内 20+ 个浮层（Radix popover / tooltip / context menu、
`createPortal` 模态、toast）全部 portal 到 `document.body`，只要浏览器页签处于激活
状态就会被遮挡，`z-index` 完全够不着。Electron 至今没有 per-View 的点击穿透
API（[#1335](https://github.com/electron/electron/issues/1335) 2015 起、
[#23863](https://github.com/electron/electron/issues/23863) 2020、
[#49039](https://github.com/electron/electron/issues/49039) 2025 均未排期，
维护者回复为 "PRs welcome"），因此在原架构内无解。

已验证并排除的替代路径：

- **透明浮层 View**：透明本身可行（`setBackgroundColor('#00000000')`），但顶层视图会
  吞掉所有指针事件，无法穿透到下层。
- **离屏渲染（OSR）**：Electron v43 的 `osr_render_widget_host_view.cc` 中 IME 钩子
  全部是空实现，`GetTextInputClient()` 返回 `nullptr`，**中文输入不可用**；
  共享纹理模式下 popup 坐标从未暴露，`<select>` 结构性不可修。
- **截图冻结 + 隐藏原生视图**：可行但需要每个浮层手动接入，新增浮层必然遗漏；
  且冻结期间页面静止。

因此改为 `<webview>`。**这是一个明牌的取舍，代价如下：**

- **Electron 官方不推荐 `<webview>`**，理由是 Chromium 的 OOPIF 架构变动会影响其
  渲染、导航与事件路由的稳定性。
- **启用 `webviewTag` 是新增攻击面**，由上文「安全边界」中的加固措施补偿。
- **Renderer 重载或崩溃会摧毁所有 agent 标签页**（guest 存活于 Renderer 文档中，
  dev HMR 下尤其明显）。主进程的处理方式是干净地向所有 CDP client 广播
  `Target.targetDestroyed`，**不尝试用旧 `pageTargetId` 复活** —— 那会让 Puppeteer
  持有绑定到旧 execution context 的无效 Page。

**顺带修复的既有缺陷**：任何停止合成的隐藏方式都会让 `Page.captureScreenshot`
永久挂起。旧架构的 `BACKGROUND_VIEWPORT + setVisible(false)`（非活动标签页）和
`OFFSCREEN_VIEWPORT`（面板隐藏时的活动标签页）都属此列，即 agent 对后台标签页
截图此前一直是坏的。现在非活动 guest 保持 1×1 在屏并叠加
`Emulation.setDeviceMetricsOverride` 给出真实视口，截图恢复可用；活动标签页则清除
该覆盖，让页面按面板实际宽度回流。

## 上游复用方式

Chrome DevTools MCP 作为 Apache-2.0 npm 依赖保留，CoilCoil 不复制它的通用工具层。
浏览器实现按职责拆成三层，所有源文件都受 600 行架构上限约束：

- `browser-runtime.ts` 只管理标签页、guest 生命周期和 Renderer 状态；
- `browser-cdp-bridge.ts` 把上游 Puppeteer 需要的 browser → tab → page 目标层级映射到
  Electron 单页 debugger；
- `browser-cdp-commands.ts` 保存可独立回归的协议改写规则。

当前固定使用 `chrome-devtools-mcp@1.7.0`。该版本有少量会破坏 Electron guest 的上游
行为，由 `scripts/patch-chrome-devtools-mcp.mjs` 在安装后做版本锁定、幂等的兼容修正；
版本不匹配会直接失败，避免升级后静默套错补丁。主要兼容点是：stale selected page
不能阻塞 `list_pages`/`close_page` 的恢复，导航失败必须返回 MCP error，`wait_for.text`
同时接受字符串和数组，以及 Network/Performance 的明确错误语义。`setup` 即使使用
`npm ci --ignore-scripts` 也会显式执行该补丁。

Electron 的 `Page.reload` 可能替换 `<webview>` 主 frame，导致 Puppeteer 报
`Navigating frame was detached`；移动端/触摸 viewport 又会由 Puppeteer 隐式触发
同一 reload。因此 CDP 桥把 `Page.reload` 路由成当前 URL 的 `Page.navigate`，保持
target identity 不变。Lighthouse 的临时 direct session 查询 target 时，桥接层返回
合成的 `type: page` 身份（而不是 Electron 原生的 `webview`），使其 session 能进入
Lighthouse TargetManager。MCP 同时开启 structured content 和可选 pageId routing，
但仍保持 `directTools: false`，不会把 30 个 schema 注入模型默认上下文。

同一套上游工具已经覆盖导航、页面快照、点击、输入、截图、Console、Network、
Performance 与 Lighthouse。CoilCoil 只额外增加一个页级 `intercept_network_request`
工具，通过同一个 Chrome DevTools MCP 和 CDP `Fetch` 链路管理规则：`add/list/remove/clear`
四种操作覆盖 Mock 响应、阻断请求、修改 URL/方法/Headers/Body 后继续请求；规则跨页面
导航保留，关闭页面或 MCP 重连后释放，最新匹配规则优先，未匹配请求始终继续，避免页面
被意外挂起。该工具仍只存在于可搜索的 MCP 元数据中，不改变默认零直接工具的设计。

CoilCoil 不再同时装载 Playwright MCP，也不再维护独立的 Debugger/Fetch/Storage MCP；
能力缺口按真实需求逐项评估，不通过叠加整套控制框架补齐。

## 当前界面

右侧“浏览器”页签提供多标签页、地址/搜索输入、前进、后退、刷新与关闭。UI 与
Agent 操作的是同一组 `<webview>` guest；Agent 新建、选择、关闭或导航页面时，右栏
会实时同步。非活动标签页保持 1×1 在屏并常驻 1280×720 的模拟视口 —— **不会被
`display:none`/`visibility:hidden`/离屏隐藏**，否则 guest 停止合成，agent 的截图
会永久挂起。Agent 首次连接内置 MCP 时，CoilCoil 会自动打开右侧浏览器页签，避免
模型在用户不可见的后台页面中执行交互。

## 同类项目源码对比

本方案还对照了以下五个实际仓库（审计版本记录于 2026-08-13）：

- [`pi-desktop`](https://github.com/DLYZZT/pi-desktop/blob/463b483e03c97696b45f7e5a418213ff95d358d6/src/main/browser/browser-tab-manager.ts)
  同样使用主进程持有的 `WebContentsView` 和 `webContents.debugger`，并实现了
  `ownerSessionId`、分级授权、网络策略和较完整的原生 Browser 工具。它证明当前
  渲染路线成立；其会话所有权和授权分级值得后续吸收，但整套自研工具规模很大。
- [`browser-use/desktop`](https://github.com/browser-use/desktop/blob/f073b7574f7927185ebbebd87556391d5cb0cfd1/app/src/main/sessions/BrowserPool.ts)
  也为 Agent 创建沙箱化 `WebContentsView`，控制层可直接使用
  [`webContents.debugger`](https://github.com/browser-use/desktop/blob/f073b7574f7927185ebbebd87556391d5cb0cfd1/app/src/main/hl/cdp.ts)，
  并以每个目标的 CDP 地址限制访问范围。它的进程/会话隔离很强，但带有另一套
  Agent Harness，不适合直接并入 Pi。
- [`rever-browser`](https://github.com/greekr4/rever-browser/blob/3bdabc7c8c51187d46677f44aa6f11355f4a535e/src/renderer/src/components/WebviewTab.tsx)
  使用 Renderer `<webview>` 和自研 CDP/MCP 工具。**该结论已于 2026-08 复审并推翻**：
  当时以「必须启用 `webviewTag`，隔离边界不如主进程 `WebContentsView`」为由否决，
  但原生视图导致的浮层遮挡在原架构内无解（见上文「渲染方式的取舍」），因此改为
  采用 `<webview>`，并以 guest 绑定校验、名册脱敏和 `will-attach-webview` 加固
  补偿隔离边界。Cursor（Electron，反编译确认）采用的正是同一形状：主窗口
  `webviewTag: true` + `document.createElement("webview")` + 把 `getWebContentsId()`
  传给主进程；其浏览器菜单为纯 DOM 组件，天然浮于网页之上。
  （对照：ChatGPT/Codex 桌面端不是 Electron 应用，而是完整的 Chromium 分支，
  其菜单为浏览器原生 views 菜单，不构成同类参照。）
- [`bah-browser`](https://github.com/alexvilelabah/bah-browser/blob/953522e5dc095eb4067e4ba65ab17f1cc3ec09e5/src/renderer/components/WebViewContainer.tsx)
  也是 `<webview>` 加直接 CDP/AX Tree 工具，适合独立浏览器产品，但没有一个可供
  Pi 直接复用的标准 MCP 控制层。
- [`agentify-sh/desktop`](https://github.com/agentify-sh/desktop/blob/d20e2e3fed6677cc5b4df1c03dd37d2b8161e1dd/electron-browser-backend.mjs)
  用独立 `BrowserWindow` 或外部 Chrome CDP，MCP 主要操作 ChatGPT 等网页产品，
  不是嵌在 Agent 工作区右栏中的同一个可见页面。

许可证分别为 Apache-2.0、MIT、Apache-2.0、MIT、MPL-2.0。CoilCoil 当前只新增
Apache-2.0 的官方 `chrome-devtools-mcp` 依赖；对上述项目只做架构审计，没有复制
其源码。
