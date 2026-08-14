# SuoCode 内置浏览器

SuoCode 的内置浏览器由 Electron `WebContentsView` 渲染。Agent 的高频网页操作以
[`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) 为语义层；
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) 与
SuoCode 自有调试 MCP 通过搜索按需提供网络、性能、Sources 和存储等高级能力。

## 安全边界

- 不启动外部 Chrome，也不下载独立浏览器内核。
- 不开启 Electron 全局 `--remote-debugging-port`。
- 主进程只为 SuoCode 创建的浏览器 `WebContentsView` 暴露私有 CDP 桥；应用
  Renderer、设置页和其他 WebContents 不在可发现目标中。
- CDP WebSocket 仅监听 `127.0.0.1`，使用随机路径和随机 Bearer Token；地址与
  凭据只通过内置 Runtime 子进程环境传递。
- `Browser.close` 会被拦截；网页、本地文件、`data:` 等 Chromium 可加载地址均由
  内置浏览器承载，不把应用 Renderer 暴露给 Agent。
- 浏览器 MCP 只注入 Agent 的有效能力视图，不写入用户或工作区的 MCP 配置文件。
- 每个 Agent 会话拥有独立的 capability scope。它只能发现和操作自己创建的标签页；
  后台会话不会切走用户当前右栏，运行时归档或被回收时会同时关闭其 CDP 连接和网页。

## 上游复用方式

Playwright 和 Chrome DevTools MCP 均作为 Apache-2.0 npm 依赖保留，SuoCode 不复制
它们的通用工具层。`apps/desktop/src/main/browser-runtime.ts` 实现 capability-scoped
兼容层，把 Playwright/Puppeteer 需要的 browser → tab → page 目标层级映射到 Electron
的单页 debugger。这样可继续升级上游 MCP，同时连接层始终由 SuoCode 控制。

Playwright 的参数较少不是因为浏览器能力更少，而是它预先处理了原始 CDP 状态：

- `snapshot ref` / selector 被解析成 Locator 与具体 frame、node、execution context；
- click/fill/drag 内置可见、稳定、未被遮挡、可编辑等 actionability 检查和自动等待；
- Page/BrowserContext 管理导航、弹窗、下载和页面生命周期；
- 调用者通常只需表达“对哪个语义元素做什么”，不用持续传递 CDP session、frame、
  backend node、坐标和等待条件。

因此 SuoCode 将快照、查找、点击、输入、导航、标签页、等待和截图等高频能力直接
提供给 Agent；Console、任意脚本求值、Network 明细以及更底层的 Debugger/Fetch/
Storage 工具通过 MCP 搜索渐进披露。能力没有删除，只避免把低频 schema 和复杂参数
常驻在每轮模型上下文中。

## 当前界面

右侧“浏览器”页签提供多标签页、地址/搜索输入、前进、后退、刷新与关闭。UI 与
Agent 操作的是同一组 WebContentsView；Agent 新建、选择、关闭或导航页面时，右栏
会实时同步。Agent 首次连接内置 MCP 时，SuoCode 会自动打开右侧浏览器页签，避免
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
  使用 Renderer `<webview>` 和自研 CDP/MCP 工具，能力丰富但必须启用
  `webviewTag`，隔离边界不如主进程 `WebContentsView`，因此只参考其多标签和
  OOPIF 处理，不采用容器方案。
- [`bah-browser`](https://github.com/alexvilelabah/bah-browser/blob/953522e5dc095eb4067e4ba65ab17f1cc3ec09e5/src/renderer/components/WebViewContainer.tsx)
  也是 `<webview>` 加直接 CDP/AX Tree 工具，适合独立浏览器产品，但没有一个可供
  Pi 直接复用的标准 MCP 控制层。
- [`agentify-sh/desktop`](https://github.com/agentify-sh/desktop/blob/d20e2e3fed6677cc5b4df1c03dd37d2b8161e1dd/electron-browser-backend.mjs)
  用独立 `BrowserWindow` 或外部 Chrome CDP，MCP 主要操作 ChatGPT 等网页产品，
  不是嵌在 Agent 工作区右栏中的同一个可见页面。

许可证分别为 Apache-2.0、MIT、Apache-2.0、MIT、MPL-2.0。SuoCode 当前只新增
Apache-2.0 的官方 `chrome-devtools-mcp` 依赖；对上述项目只做架构审计，没有复制
其源码。
