# CoilCoil 内置浏览器

内置浏览器的每张标签页，都是主进程里的一个**离屏页面**：一个隐藏、不可聚焦的
`BrowserWindow`（`offscreen: true`，见 `apps/desktop/src/main/browser-offscreen.ts`）。
右侧面板里看到的是它的实时画面；用户在画面上点、打字、用输入法、滚动，由主进程转进
页面；Agent 通过 CDP 桥操作的也是这同一张页面。所以用户和 Agent 之间没有「接管」，
页面也不会因为换人而刷新。

Agent 有两层浏览器工具：

- 交互层 `browser_open` / `browser_navigate` / `browser_click` / `browser_type` /
  `browser_tabs`（`packages/workflow/extensions/browser-act.ts`）：拿句柄操作页面，
  每一步自带页面状态，是模型直接看得到的工具。
- 调试层官方 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)：
  脚本、控制台、网络、性能、快照等约 30 个工具。服务器启动后预加载可搜索的工具元数据，
  `directTools: false` 保证这些 schema 不进模型的默认工具面，Agent 通过统一 MCP 网关
  按需搜索、描述和调用。

## 用户和 Agent 共用同一张页面（2026-09）

方案、实测和取舍见 `docs/browser-shared-page-plan.md`。

- **看**：macOS 上画面走 GPU 共享纹理（主进程把页面的纹理借给 App 窗口，窗口画完还回来，
  全程不拷像素），一秒约 60 帧；Windows、Linux 和关了 GPU 的机器走 JPEG，一秒约 30 帧
  （`browser-frame-stream.ts`、`preload/browser-surfaces.ts`）。Windows 上的 GPU 画面还没
  在真机上验证，`COILCOIL_BROWSER_GPU_FRAMES=1` 强制打开、`=0` 强制关掉。
- **操作**：鼠标、滚轮用 `sendInputEvent` 送进页面，键盘、输入法、编辑命令走 CDP；Mac 上
  ⌘A/⌘C/⌘V/⌘Z 这类编辑快捷键按 Playwright 的编辑命令表转（`browser-input.ts`）。面板上
  一个看不见的输入框接住键盘和输入法组字，它跟着网页里的光标挪，输入法候选框就出现在打字
  的地方（`browser-page-caret.ts`）。
- **浏览器自带、离屏页面里没有的，由面板补上**：
  - 网页的 alert / confirm：面板里的一张卡片，用户和 Agent 都能答（`browser-page-dialogs.ts`）。
    `prompt` 在 Electron 里本来就不支持。
  - 原生下拉框：面板画出选项列表；日期、时间、颜色框：在输入框的位置打开 Chromium 自己的
    选择器；跨站内嵌页（比如付款表单）里的下拉框、颜色框也一样（`browser-page-selects.ts`）。
  - 选文件、打印：用户点的照常（打印存成 PDF，用系统查看器打开）；Agent 点的什么都不弹，
    上传用它自己的 `upload_file` 工具（`browser-page-requests.ts`）。
  - 页内查找（⌘F）、悬停提示（元素的 `title`）、右键菜单（只在用户右键时弹）、页面里的拖拽、
    从访达拖文件进网页（`browser-page-drags.ts`、`browser-page-tooltip.ts`）。
  - 网页请求全屏：忽略（见「安全边界」）。
- **焦点**：离屏页面不在任何可见窗口的焦点链上，Agent 的点击、打字只进页面，用户在对话框里
  打字不受影响。网页「以为自己有焦点」这个开关由用户和 Agent 合起来算，任一方要就开着。
- **同时操作**：用户和 Agent 可以同时操作同一张页面，不排队、谁也不等谁。Agent 一动手（不管
  页面是谁开的），面板底部就出现一个浅色小标签「Agent 正在操作这个页面」，停手 8 秒后收起。
  只是一句提示：不发光、不动、不盖住网页（原先的彩色描边、光晕、毛玻璃用户嫌太重，已去掉）。
- **看不见的时候**：只有用户正看着的那张每秒几十帧；别的标签页、面板收起、窗口最小化 /
  隐藏 / 被别的窗口完全挡住时都降到一秒一帧，页面大小不变，Agent 照常截图、点击
  （e2e：`browser-background`、`browser-power`）。
- **Agent 能用哪些页面**：当前对话里的全部标签页，用户开的也在（`browser_tabs` 列出来、给
  句柄、标出用户正看着哪张）。Agent 自己开的最多留最近用过的 5 张，超了先关最久没用的；
  用户在里面点过、打过字、滚过的不收。
- **不支持**：网页的无障碍读屏（离屏页面没有接到系统的无障碍接口）；网页脚本自己调
  `showPicker()` 打开的选择器；跨站内嵌页里的日期框；网页全屏（按约定忽略，视频点全屏没反应）。

## 安全边界

- 不启动外部 Chrome，也不下载独立浏览器内核；不开启 Electron 全局 `--remote-debugging-port`。
- **每张页面由主进程创建，设置写死**（`browser-page-policy.ts`）：沙箱、上下文隔离、没有
  Node、没有预加载脚本、不许再嵌 `<webview>`、全屏时不改窗口。Cookie 按工作区分开存
  （`persist:coilcoil-browser-<工作区路径哈希>`）。权限请求一律拒绝，权限查询也一律答
  「没有」，看上去就是一个拒绝过授权的普通用户。
- **界面造不出网页**：主窗口关了 `webviewTag`，所有窗口的 `will-attach-webview` 一律拒绝。
  以前网页嵌在界面里时，要靠「界面登记、主进程逐条核对」防止串线；现在网页只由主进程建，
  这个口子没有了。e2e 的 `browser-security` 场景在主进程里逐项核对这些设置。
- 主进程只为这些离屏页面暴露私有 CDP 桥；App 自己的界面、设置页和其他 WebContents 不在
  可发现目标里。桥只从主进程的标签页表里找目标，每个 Agent 连接只看得到它所在对话的
  标签页；后台会话不会切走用户当前看着的标签页，会话归档或被回收时一并关掉它的连接和网页。
- CDP WebSocket 仅监听 `127.0.0.1`，使用随机路径和随机 Bearer Token；地址与凭据只通过
  内置 Runtime 子进程环境传递。
- `Browser.close` 被拦截；`Page.bringToFront` 这类「切到前台」只切换面板里显示的标签页，
  不碰系统焦点。
- **桥和 App 共用每张页面的同一条调试会话**，有几条规矩：App 从不打开 Runtime 域（不然
  后连上来的 Agent 拿不到执行上下文，连字都打不进去）；Agent 发的 `Page.disable`、关掉
  选文件拦截会把 App 的设置一起清掉，桥直接吞掉；「页面以为自己有焦点」、拖拽拦截这两个
  开关由宿主合起来算，Agent 关不掉用户那边的。App 自己要在页面里跑的只读脚本（光标位置、
  悬停提示）放在一个隔离环境里，不走这条会话。
- 页面要系统窗口的出口全部收进面板或拦下：对话框在面板里显示成卡片；选文件、打印只在用户
  自己点时才弹，Agent 点的什么都不弹；全屏一律忽略。浏览器 MCP 只注入 Agent 的有效能力
  视图，不写入用户或工作区的 MCP 配置文件。

## 渲染方式的取舍

### 现在：离屏页面（2026-09）

`<webview>` 解决了浮层遮挡（见下），却留下一个绕不开的问题：Chromium 在把一次鼠标按下、
按键派发给某个页面之前，会无条件把焦点交给那个页面（`RenderWidgetHostImpl::OnInputEventPreDispatch`
→ `FocusOwningWebContents`）。网页嵌在 App 窗口里时，Agent 一点击，用户正在打字的输入框
就丢了焦点，接着打的字进了网页。当时的折中是 Agent 的标签页做成离屏页面、用户的还是
`<webview>`，两边靠「接管」交接——接管要把页面换个地方重建，页面会刷新，用户填了一半的
表单就没了。

2026-09 改成全部标签页都是离屏页面。离屏页面不在任何可见窗口的焦点链上，Chromium 那条
规则只在它自己身上生效；画面画在界面里的一块画布上，App 的浮层天然盖得住。

代价是浏览器替网页做的那一层要自己补：画面传输、输入转发、Mac 编辑快捷键、输入法候选框
位置、原生弹层（下拉框、日期和颜色选择器、对话框）、选文件、打印、拖放、页内查找、悬停
提示——上一节列的都已补上。早先否决离屏渲染时担心的两件事也有了答案：中文输入法不靠页面
自己的输入法接口，而是面板上的隐形输入框接住组字，用 CDP 的 `Input.imeSetComposition` /
`Input.insertText` 转进去；`<select>` 的弹层确实出不来（纹理模式下弹层一帧都不送），由面板
自己画列表、写回。

### 更早的两种（留作记录）

- **主进程 `WebContentsView`（至 2026-08）**：原生视图无条件合成在 Renderer 之上，应用内
  20 多个浮层（Radix popover / tooltip / context menu、`createPortal` 模态、toast）全被遮挡，
  `z-index` 够不着；Electron 没有 per-View 的点击穿透（[#1335](https://github.com/electron/electron/issues/1335)、
  [#23863](https://github.com/electron/electron/issues/23863)、[#49039](https://github.com/electron/electron/issues/49039)
  均未排期）。另外 App 最小化或隐藏时页面一跳转，Agent 就截不到图（实测，见方案文档 E5）。
- **Renderer `<webview>`（2026-08 至 2026-09）**：解决了遮挡，但 Agent 点击抢焦点（见上），
  用户和 Agent 交接只能靠会刷新页面的「接管」；Renderer 重载或崩溃会带走所有网页。

## 导入登录状态与一键清空

内置浏览器的 `persist:coilcoil-browser` 分区与用户日常使用的浏览器互不相通，
Agent 因此在每个网站都是未登录状态。「设置 → 浏览器」提供两个互为对称的动作：
把某个已有浏览器配置文件的登录状态复制进来，以及一键把内置浏览器清空。

- **Cookie 导入**：Chrome 系浏览器的 Cookie 库是 SQLite，值用 macOS 登录钥匙串里的
  `<Browser> Safe Storage` 口令派生的 AES-128-CBC 加密（PBKDF2-SHA1、盐 `saltysalt`、
  1003 次迭代、IV 为 16 个空格）。较新的 Chrome 会在明文前加 32 字节的
  `sha256(host_key)` 做域绑定，只有确实等于该哈希时才剥掉，否则旧记录会被截断。
  读取前把数据库连同 `-wal`/`-journal` 复制到临时目录，绝不在用户浏览器持有的文件上
  开写事务。Safari 的 `Cookies.binarycookies` 不加密，但位于沙盒容器内，
  需要「完全磁盘访问权限」，被系统拒绝时给出明确指引而不是报错。
- **配置文件选择**：Chrome 按角色分目录（`Default`、`Profile 1`…），显示名和登录邮箱
  来自 `Local State` 的 `profile.info_cache`——不显示这两项的话，用户无从分辨要导入哪一个。
- **密码导入（可选）**：来自同一浏览器的 `Login Data`，但密码在 Electron 里
  没有归宿，因此存进 CoilCoil 自己的库：`safeStorage` 加密后写在 userData 下的
  `browser-credentials.bin`。**密码不进入模型、不进入工具、不随远程控制离开这台电脑**，
  唯一的消费者是内置浏览器页面里的自动填充：同源、且只匹配到一条凭据、且密码框为空时
  才填，且永不自动提交。Safari 的密码是逐条受控的钥匙串项，系统不允许整批导出。
- **一键清空**：`clearStorageData` + `clearCache` + `clearAuthCache` 三者缺一不可
  （只清前者会留下 HTTP 缓存和代理凭据，网站仍可能认出用户），并同时删除密码库。
  把登录态交给一个 Agent 是可以接受的，前提是收回它只要一次点击。

- **Windows Chrome / Edge**：用户选择配置并确认后，Windows 弹一次管理员批准。
  两者的 App-Bound 外层由短时 SYSTEM 任务打开，内层在当前登录用户下解密；
  Chrome 137+ 多出的 CNG 保护也由同一次批准启动的 SYSTEM 任务解锁，
  通过完整性验证后才读取 v20 Cookie。明文密钥不落盘；浏览器更新导致格式不符时拒绝导入。
  临时任务和受限目录完成即删除，不往浏览器进程注入代码，也不改原浏览器的数据。
  导入前必须完全退出来源浏览器（包含后台进程），否则 Windows 会锁住 Cookie 库；
  读不到库时不请求管理员批准，直接提示先退出。Windows 原生助手由本机 / CI
  构建时编译，随 Windows 安装包分发，不提交可执行文件到仓库。
- Chrome 154 与 Edge 新版资料均已在 Windows 11 ARM64 虚拟机用真实来源数据库验证。
  目前 Windows CI 发行包没有代码签名证书，UAC 可能显示「未知发布者」；不能把它写成
  和 Codex 的「已验证发布者 OpenAI」相同。发布前应签名桌面程序和导入助手。

## 上游复用方式

Chrome DevTools MCP 作为 Apache-2.0 npm 依赖保留，CoilCoil 不复制它的通用工具层。
浏览器的主进程实现按职责拆开：

- `browser-runtime.ts` 管理标签页、面板状态和各项补齐的入口；每一项补齐的逻辑各在自己的
  文件里（`browser-input.ts`、`browser-frame-stream.ts`、`browser-page-*.ts`）；
- `browser-cdp-bridge.ts` 把上游 Puppeteer 需要的 browser → tab → page 目标层级映射到
  每张页面自己的 debugger；
- `browser-cdp-commands.ts` 保存可独立回归的协议改写规则。

运行时、桥这几份文件有行数上限（`apps/desktop/tests/browser-compatibility.test.ts`），防的是
「一个文件什么都装」，不是防长文件本身。

当前固定使用 `chrome-devtools-mcp@1.7.0`。该版本有少量会破坏 Electron 页面的上游
行为，由 `scripts/patch-chrome-devtools-mcp.mjs` 在安装后做版本锁定、幂等的兼容修正；
版本不匹配会直接失败，避免升级后静默套错补丁。主要兼容点是：stale selected page
不能阻塞 `list_pages`/`close_page` 的恢复，导航失败必须返回 MCP error，`wait_for.text`
同时接受字符串和数组，以及 Network/Performance 的明确错误语义。`setup` 即使使用
`npm ci --ignore-scripts` 也会显式执行该补丁。

Electron 的 `Page.reload` 可能替换页面的主 frame（最初在 `<webview>` 上发现，离屏页面上
保留这条路由），导致 Puppeteer 报
`Navigating frame was detached`；移动端/触摸 viewport 又会由 Puppeteer 隐式触发
同一 reload。因此 CDP 桥把 `Page.reload` 路由成当前 URL 的 `Page.navigate`，保持
target identity 不变。Lighthouse 的临时 direct session 查询 target 时，桥接层返回
合成的 `type: page` 身份（而不是 Electron 自己报的类型），使其 session 能进入
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
  **2026-09 又改为离屏页面**：`<webview>` 下 Agent 一点击就抢走用户的输入焦点，用户和
  Agent 交接页面只能靠会刷新页面的「接管」（见上文「渲染方式的取舍」）。
- [`bah-browser`](https://github.com/alexvilelabah/bah-browser/blob/953522e5dc095eb4067e4ba65ab17f1cc3ec09e5/src/renderer/components/WebViewContainer.tsx)
  也是 `<webview>` 加直接 CDP/AX Tree 工具，适合独立浏览器产品，但没有一个可供
  Pi 直接复用的标准 MCP 控制层。
- [`agentify-sh/desktop`](https://github.com/agentify-sh/desktop/blob/d20e2e3fed6677cc5b4df1c03dd37d2b8161e1dd/electron-browser-backend.mjs)
  用独立 `BrowserWindow` 或外部 Chrome CDP，MCP 主要操作 ChatGPT 等网页产品，
  不是嵌在 Agent 工作区右栏中的同一个可见页面。

许可证分别为 Apache-2.0、MIT、Apache-2.0、MIT、MPL-2.0。CoilCoil 当前只新增
Apache-2.0 的官方 `chrome-devtools-mcp` 依赖；对上述项目只做架构审计，没有复制
其源码。
