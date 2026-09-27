# 内置浏览器「共用页面」改造技术方案

- 日期：2026-09-26
- 状态：**已实施（2026-09-27），P0–P5 完成，只在本地提交、未推送，等验收。** 做了什么、和计划哪里不同、还剩什么，见第 12 节「实施记录」。方向（2026-09-26 定）：采用本文推荐的「离屏统一 + 输入转发」；AI 可直接使用当前对话的全部标签页；页面不加锁（见第 11 节）
- 适用：Electron 43.3.0，macOS 与 Windows 都支持（CoilCoil 发 Windows 版；Windows 尚未实机验证，见第 10 节）
- 依据：本机实测（第 4 节，十余组对照实验）+ 源码核对（Chromium、Electron、VS Code）+ 拆包分析（Codex 26.917、Cursor 3.22.7）

---

## 0. 结论

**推荐方案：所有标签页都改用「离屏页面」（也就是今天 AI 标签页的做法），在面板里用 GPU 共享纹理以 60fps 实时显示，再把用户的鼠标、键盘和中文输入法转发进页面。**

这样 AI 和你操作的是同一个活页面，不用接管，也不刷新。

| 你的三条要求 | 本方案怎么满足 | 实测证据 |
|---|---|---|
| 1. 最小化、折叠不影响 AI 操作浏览器 | 离屏页面不依赖窗口是否可见。App 最小化、Cmd+H 隐藏、被别的窗口挡住、面板折叠时，AI 跳到新网站、截图、点击都照常 | E6：截图 18/18 新鲜，点击 6/6 |
| 2. AI 操作不影响我的光标 | 离屏页面不在任何可见窗口的焦点链上，AI 的点击和打字只进页面自己；网页弹窗、文件选择、全屏等会抢焦点的出口全部收进面板 | E1、E3、E9 |
| 3. AI 能操作，我也能操作 | 你直接在面板画面上点击、打字（含中文输入法）、滚动、选中复制、右键。和 AI 是同一个活页面，没有接管，不刷新 | E7、E8 |

**为什么不选另外三条路：**

- **原生视图（WebContentsView，VS Code 的做法）**：焦点问题能解决（E2），但 **App 最小化或隐藏时，页面只要一跳转，AI 就一直截不到图（直到窗口恢复）**。四种摆法全部失败，加 Chromium 开关也没用（E5）。另外，原生视图永远盖在界面最上层，应用的 20 多个浮层会被它挡住。2026-08 我们就因为这一点放弃过它（见 `docs/bundled-browser.md`）。
- **`<webview>` + 页面内模拟事件（Cursor 3.22.7 的做法）**：网页一直嵌在窗口里、从不搬家，所以 Cursor 的「接管」（Take control）只是拿掉盖在网页上的透明挡板，天然不刷新。为了不抢焦点，Cursor 的 AI 点击和打字都不用真实输入，而是在页面里用脚本模拟 DOM 事件（`isTrusted=false`，工具说明写明 "Use this instead of CDP Input.*"）。代价是 AI 能力打折：模拟事件不算用户手势，也不触发浏览器的默认行为，所以上传文件、弹出新窗口、复制到剪贴板、悬停展开的菜单、富文本编辑器里输入、带风控的页面都可能失败。AI 只要改用真实输入，就会抢焦点（E1）。最小化不是它的短板：补测（E13）显示这类内嵌网页在最小化、隐藏时跳转后仍能截图（早先版本写错，已更正）。
- **照搬 Codex**：Codex 跑在 OpenAI 自研的 Chromium 分支 Owl 上，靠私有能力实现「活页面在两个宿主之间搬家」（`adoptWebContents`、`webviewrole="tab"`、`webContents.clone()`）。标准 Electron 没有这些能力，无法照抄。

**代价**（第 6、10 节细说）：页面里的交互由我们转发，要自己补齐几样原生能力：Mac 编辑快捷键、输入法候选框的位置、原生下拉框和日期控件（离屏时不显示，需要自绘）、拖放文件、悬停提示。不支持页面的无障碍读屏。共享纹理接口在 Electron 43 里还是实验性的，需要保留位图回退路径。

**顺带得到的好处：**
- 主窗口可以关掉 `webviewTag`，攻击面变小。
- 标签页归主进程所有，界面重载或热更新不会再销毁所有标签页。
- 画面本身就是 DOM 里的画布，浮层、动画和「AI 在用」的光效都照常显示。
- 修复一个现存隐患：AI 操作的页面弹 alert 时，离屏页会弹出不带父窗口的系统对话框。按 Electron 源码推断它会抢焦点，实施时先补测确认。

**已定和待定事项**见第 11 节。

---

## 1. 背景：为什么现在接管一定会刷新

现状（提交 f37070808 起）：

- **AI 的标签页**：每页一个隐藏的离屏 `BrowserWindow`（`offscreen: true`）。`paint` 帧压成 JPEG 后推给面板里的 `<img>` 显示（`browser-offscreen.ts`、`AgentPageView.tsx`）。
- **你的标签页**：渲染层里的 `<webview>`（`guestLayer.ts`）。
- **接管**：在两种承载之间换。只能用 `navigationHistory.restore` 把历史「恢复」进一个新的 WebContents（`browser-runtime.ts` 的 `takeOverForUser` / `takeOverForAgent`）。页面脚本因此会重跑，单页应用的内存状态、播放进度、填到一半的流程都会丢。**这是架构决定的，修不好。**

当初分成两种承载，是因为 `<webview>` 会抢焦点：它是嵌在应用里的内层 WebContents，和应用共用一套焦点。AI 用 CDP 发一次鼠标按下，Chromium 在派发前会把整个窗口的键盘焦点交给这个网页。具体路径是 `RenderWidgetHostImpl::OnInputEventPreDispatch → FocusOwningWebContents → SetFocusedFrameTree`，内层 WebContents 会委托给外层（E1）。5a5fea810 试过「抢了再还」，因为有竞态被 revert。

---

## 2. 目标与验收标准

| 编号 | 验收标准（可自动化） |
|---|---|
| A1 焦点 | AI 在任意标签页连续点击、输入、跳转、触发 alert/confirm、点文件选择框、开新页的同时，用户用**真实按键**往主界面输入框打字：文字 100% 落在输入框，输入框不失焦 |
| A2 后台 | 在 App 最小化、Cmd+H 隐藏、被其它窗口完全挡住、面板折叠四种状态下，AI 连续 10 轮执行「跳到另一个网站 → 截图 → 点击」：截图全部是新画面（像素比对），点击全部生效 |
| A3 共用 | AI 打开页面并填了一半表单后，用户在画面上直接点击、输入（含中文输入法组字）、滚动、选中复制、右键、选下拉框。**页面不重载**（页面加载 id 不变），之后 AI 继续操作同一页面，能读到用户输入的内容 |
| A4 流畅 | 正在显示的标签页 60fps；从输入到画面更新 ≤ 2 帧；拖动面板不掉帧（沿用「拖动不能破坏动画」的约定） |
| A5 不回退 | 现有 e2e（标签上限、按会话隔离、句柄、草稿交接、远程端看画面）改写后全部通过 |
| A6 你优先 | 你在页面里连续打字时，AI 同时对该页点击和输入：你的字一个不丢，也不串到别的输入框；你停手后 AI 的动作继续完成，并且 AI 收到「用户刚操作过」的提示 |

---

## 3. 调研结论

### 3.1 Chromium 与 Electron 的相关规则（已核对源码）

- `content/browser/renderer_host/render_widget_host_impl.cc` 的 `OnInputEventPreDispatch`：鼠标按下、触摸开始、点按前一律调用 `delegate_->FocusOwningWebContents(this)`。CDP 注入的事件也走这条路。
- `content/browser/web_contents/web_contents_impl.cc` 的 `SetFocusedFrameTree`：内层 WebContents（`<webview>` guest）的焦点会委托给外层，所以会连带应用一起失焦。顶层 WebContents（原生视图、离屏页）各自独立。
- Electron `WebContents::ReadyToCommitNavigation`：每次主框架导航都会 `SetInitialFocus()`，除非设置 `webPreferences.focusOnNavigation: false`。VS Code 也是这样关掉的。
- Electron 的网页对话框在 JS 层处理（`lib/browser/api/web-contents.ts` 监听内部事件 `'-run-dialog'`）。**离屏页会调用不带父窗口的 `dialog.showMessageBox(options)`，弹出应用级模态框（按源码推断会抢焦点，实施时补测）。**

### 3.2 市面做法

| 产品 | 页面承载 | AI 怎么操作 | 焦点 | 最小化/后台 | 人机交接 |
|---|---|---|---|---|---|
| Codex 26.917（本机拆包） | 自研 Chromium 分支 Owl 的私有 `<webview webviewrole="tab">` | CDP Input（白名单：mouse/key/insertText），操作前开焦点模拟 | 靠魔改内核 | 后台页用 `opacity: 0.001` 停靠保持合成 | 无接管；`adoptWebContents` 让活页面换宿主 |
| Cursor 3.22.7（本机拆包） | 工作台 `<webview>`（`WebviewBrowserManager`） | **页面内合成 DOM 事件**；工具说明写明 "Use this instead of CDP Input.*" | 模拟事件不抢焦点，但 `isTrusted=false` | 隐藏标签 `opacity: 0` 加「渲染租约」保持合成；截图用 `capturePage`（不强制出新帧，最小化时常拿到旧画面，E13） | `browser_lock` = 在网页上盖一层 DOM 挡板，拦住鼠标和滚轮；用户点「Take control」拿掉挡板。网页始终是同一个，不换页 |
| VS Code 集成浏览器（开源） | `WebContentsView` + `focusOnNavigation: false` | Playwright `connectOverCDP` | 原生视图不抢 | 截图前切换可见性预热；未见针对最小化的处理 | 页面「共享给 Agent」后才能操作 |
| CoilCoil 现状 | AI：离屏页；用户：`<webview>` | CDP（chrome-devtools-mcp） | 离屏页不抢 | 离屏页不受影响 | 接管 = 历史恢复，**会刷新** |

### 3.3 我们以前走过的路（`docs/bundled-browser.md`）

- 最早用 `WebContentsView`，因为浮层被遮挡而放弃（Electron 至今没有「单个视图点击穿透」的接口）。
- 离屏方案当时被否，理由有两条：
  1. **离屏页没有原生输入法钩子，中文输入不可用。** 本方案不依赖离屏页的原生钩子：输入法在应用自己的输入框里正常组字，组字结果用 CDP `Input.imeSetComposition` / `Input.insertText` 送进页面。实测组字事件完整，最终能上屏（E7）。
  2. **`<select>` 弹层结构上修不了。** 确实如此，原生弹层在离屏时不出现（E7）。本方案改为由应用自己画下拉：主进程先查点击位置是不是下拉框，是的话读出选项，由应用画列表，选中后回写值。这和原生弹层能不能显示无关。

---

## 4. 实测数据（本机 Electron 43.3.0，macOS）

测试方法：

- **真实按键**：通过 ObjC `[NSApp postEvent:]` 给本进程投递真实的键盘和鼠标事件，和用户按键走同一条系统路由。
- **截图是否新鲜**：每次截图前把页面背景改成随机颜色，截图后解码取像素比对，排除「截到的是旧画面」。
- **跨站跳转**：在 `127.0.0.1` 和 `localhost` 两个站点之间跳转，强制换渲染进程。

| 编号 | 实验 | 结果 |
|---|---|---|
| E1 | `<webview>` + AI 用 CDP 点击，随后用户按键 | ❌ 输入框失焦，字进了网页；加焦点模拟（Codex 做法）仍然 ❌ |
| E2 | 原生视图 + `focusOnNavigation:false`，14 类动作（点击、打字、导航、刷新、autofocus 页面、页面自己调 focus、改大小、显示/隐藏、挂上/摘下）后用户按键 | ✅ 14/14 仍在输入框；AI 和用户同时打字，各进各的；用户点进网页操作全程 0 次重载 |
| E3 | 原生视图的边角动作 | `Page.bringToFront` ❌ 抢（现在的 CDP 桥已拦截）；`DOM.focus` ✅；alert/confirm ❌ 主窗口弹系统 sheet 并抢焦点 → **换成自己处理 `-run-dialog` 后 ✅**；文件选择用 CDP 拦截 ✅；`window.open` ✅；AI 用 CDP 按 Cmd+W ✅（不触发 `before-input-event`，不会误关窗口）；页面请求全屏 ✅ |
| E4 | 原生视图后台，**不跳转**：显示中、压在下面、隐藏三种全尺寸摆法，以及 1×1 停靠 | 全尺寸三种在最小化、隐藏应用、被遮挡、面板折叠下截图 ✅ 点击 ✅；1×1 停靠在最小化时 ❌ |
| E5 | 原生视图后台，**有跳转**（最常见的真实场景） | 最小化、隐藏应用时跳转后截图 **0/12**（四种摆法 × 3 次）；加 `disable-backgrounding-occluded-windows` 仍是 0/12；出生就隐藏的视图在最小化时 0/4；「截图前切一下可见」「可见截图唤醒」都无效 |
| E6 | 离屏页，有跳转 | 正常、最小化、隐藏应用、被遮挡 × 跨站跳转：截图 **18/18 新鲜**，点击 6/6，持续出帧 |
| E7 | 离屏页的输入转发 | 点击 ✅，打字 ✅，退格 ✅，Tab ✅，滚轮 ✅，拖选文字 ✅，双击选词 ✅，光标形状（`cursor-changed`）✅，右键事件 ✅；**中文输入法组字→上屏 ✅**（composition 事件完整）；Cmd+A 用 `sendInputEvent` ❌，改用 CDP 带编辑命令 `commands:['selectAll']` ✅；复制粘贴（`webContents.copy/paste`）✅；开启焦点模拟后页面 `hasFocus` ✅、光标闪烁；**原生 `<select>` 弹层不出现 ❌**（要自绘） |
| E8 | 离屏页 → GPU 共享纹理 → 主窗口 canvas（沙箱 preload，和 CoilCoil 主窗口配置一致） | **60fps，0 丢帧，0 泄漏，传递延迟 ≤1ms**；另测从按键到离屏页出新帧 5–7ms（位图模式）。注意：高层接口 `sharedTexture.sendSharedTexture` 在沙箱 preload 下会卡死主进程，**只能用 `subtle` 手动传递** |
| E9 | 离屏页的边角 | `Page.bringToFront` 不抢焦点、不会把隐藏窗口显示出来 ✅ |
| E10 | 原生视图压力测试：6 轮开关标签页 | 最小化、隐藏、遮挡下已有标签 45/45 ✅；但「正常」状态下新开的隐藏标签首次截图失败 5/15；最小化时新开的标签截图 0/6 ❌ |
| E11 | 共享纹理模式的离屏页（方案里所有标签页都用这种），AI 截图和远程端截图 | 60fps、后台 1fps、1fps 加主窗口最小化、1fps 加隐藏应用 × 跨站跳转：CDP 截图 12/12 新鲜，`capturePage` 8/8 新鲜 |
| E12 | 离屏页用 CDP 按键打字，以及 Mac 编辑命令 | 带 `text` 打字 ✅；⌥← `moveWordLeft` ✅；⌥⌫ `deleteWordBackward` ✅；⌘Z `undo` ✅ |
| E13 | `<webview>`（Cursor 同款，也是现在用户标签页的承载），主窗口关闭后台节流 | 正常、最小化、隐藏应用 × 跨站跳转：CDP 截图 **18/18 新鲜**；`capturePage` 12 次只有 4 次是新画面（它不强制出新帧，正常状态也会拿到旧画面） |

结论：**后台加跳转之后仍然可靠的是离屏页和 `<webview>`，原生视图不行。** 但 `<webview>` 只要 AI 用真实输入就抢焦点（E1）。三条要求都满足、并且 AI 仍用真实输入的，只有离屏页。

---

## 5. 方案对比

| | A 离屏统一 + 输入转发（推荐） | B 原生视图 WebContentsView | C `<webview>` + 页面内模拟事件（Cursor 做法） | D 维持现状 |
|---|---|---|---|---|
| 要求 1（最小化/折叠） | ✅ 全状态可靠 | ❌ 跳转后最小化或隐藏必挂 | ✅ 截图可用（E13）；面板折叠时要「藏而不停」 | ✅ AI 只在离屏页上操作 |
| 要求 2（不抢光标） | ✅ | ✅（需拦截对话框和前置） | ✅（前提是不用真实输入） | ✅（靠分家实现） |
| 要求 3（共用、不刷新） | ✅ | ✅ | ✅ | ❌ 接管就刷新 |
| 用户交互手感 | 接近原生；下拉框、拖放、悬停提示要补 | 原生 | 原生 | 原生（仅用户页） |
| AI 操作可靠性 | 真实输入 | 真实输入 | 模拟事件：上传、弹窗、复制、悬停菜单、富文本输入、风控页可能失败 | 真实输入 |
| 浮层与动画 | ✅ 画面就是 DOM | ❌ 被原生视图遮挡 | ✅ | ✅ |
| 安全 | 可关掉 `webviewTag` | 可关掉 | 需开 `webviewTag` | 需开 `webviewTag` |
| 改动量 | 大（输入转发 + 画面管线） | 大（浮层管理 + 停靠） | 中（把 AI 现有的浏览器工具换成模拟事件版） | 无 |

---

## 6. 推荐方案设计

### 6.1 总体结构

```
主进程                                                      主窗口渲染层
┌──────────────────────────────────────────┐   帧（GPU 共享纹理）  ┌──────────────────────────────┐
│ BrowserRuntime                           │ ───────────────────▶ │ LivePageSurface               │
│  └ 每个标签页 = 离屏 BrowserWindow        │                      │  ├ <canvas> 页面画面          │
│     (offscreen, useSharedTexture,        │   输入（MessagePort）  │  ├ 透明 textarea（键盘/输入法）│
│      focusable:false, 永不 show)          │ ◀─────────────────── │  ├ 自绘下拉 / 对话框 / 提示    │
│  ├ FrameStream：subtle 手动传递，背压 ≤3 帧│                      │  └ AI 在用的光圈等浮层        │
│  ├ InputRouter：sendInputEvent + CDP     │   页面事件（光标、光标 │                              │
│  ├ PageDialogs：-run-dialog / 文件选择    │ ─位置、下拉、对话框）─▶ │                              │
│  ├ PagePickers：下拉/日期/颜色命中与回写   │                      └──────────────────────────────┘
│  └ CdpBridge（AI 的 chrome-devtools-mcp）│
└──────────────────────────────────────────┘
```

### 6.2 标签页模型

- 只有一种标签页：离屏页面。保留 `owner`（谁打开的），用于 AI 标签上限回收和界面分组。
- 删除以下字段：`control`、`guest` / `guestNonce`、`phase: awaiting-guest`、`offscreen` 与 `guest` 的二选一。
- **当前对话里的所有标签页，AI 都能直接看到和操作**（用户 2026-09-26 决定，不设共享开关）。AI 连上浏览器时仍先拿到自己的空白页，默认在自己的标签页里干活；需要用你的页面时直接切过去，不接管、不刷新。其它对话的标签页照旧互不可见。
- 其余不变：按会话 scope 显示，按工作区 partition 分 cookie，AI 标签上限 5 张，草稿占位页的交接规则。

### 6.3 画面管线

- **显示中的标签页**：离屏页创建时开启 `offscreen: { useSharedTexture: true, deviceScaleFactor: 屏幕缩放 }`。
  - 主进程在 `paint` 事件里调用 `sharedTexture.subtle.importSharedTexture` → `startTransferSharedTexture`，再用 `webContents.send` 发给主窗口。
  - preload 调用 `sharedTexture.subtle.finishTransferSharedTexture` 得到 `VideoFrame`，画到 canvas 上（2D `drawImage`，以后可换 WebGPU）。
  - 画完释放，并回执主进程。在途最多 3 帧，渲染端跟不上时直接丢弃新到的帧、不排队（E8 实测 60fps、≤1ms）。
- **回退路径**：`paint` 没有 `texture` 时（GPU 不可用），改走位图（`image.toBitmap()` 经 MessagePort 转成 `ImageData`），不再压 JPEG。
- **没在显示的标签页**：离屏页继续渲染，帧率降到 1fps，纹理立即释放，不推给界面。AI 截图走 CDP，不依赖推帧（E6）。
- **面板折叠、窗口最小化或隐藏时**：停止推帧，节省电量。离屏页照常工作。
- **页面尺寸**：显示中的标签页等于面板的大小。拖动面板或播放动画的过程中，画布按 CSS 缩放旧画面；停下 150ms 后再改离屏页尺寸，只重排一次，保证拖动不掉帧。隐藏的标签页保持最后一次的尺寸，避免 AI 做到一半时页面排版突然变化。AI 用 `Browser.setContentsSize` 等设置的尺寸沿用现有规则。

### 6.4 输入转发

用户点击画面时，焦点进入 `LivePageSurface` 里的透明 textarea（它是焦点代理）；点到画面外就离开。所有事件都附带 `tabId`，只转发给当前正在显示的那一张。

| 用户动作 | 渲染层采集 | 主进程转发方式 |
|---|---|---|
| 移动、按下、抬起鼠标 | pointer 事件 + 指针捕获（拖出画布也能跟住）；移动按帧合并 | `sendInputEvent` 的 `mouseMove/Down/Up`（按钮、`clickCount = event.detail`、修饰键） |
| 滚轮、触控板 | `wheel`（阻止面板自身滚动），按帧累加 | `mouseWheel`（deltaX/Y，`hasPreciseScrollingDeltas`、`canScroll`） |
| 右键 | `contextmenu` | 转发右键；页面的 `context-menu` 事件复用 `browser-context-menu.ts` 的菜单，在画布位置弹出 |
| 普通按键 | textarea 的 keydown/keyup；先让应用快捷键处理，处理过的不转发 | CDP `Input.dispatchKeyEvent`（key、code、keyCode、text、modifiers、location、autoRepeat） |
| Mac 编辑快捷键（Cmd+A、⌥←、⌘⌫ 等） | 同上 | 按对照表附带 `commands`（参考 Playwright 的 macEditingCommands）；Cmd+C/X/V/Z/⇧Z 直接调用 `webContents.copy/cut/paste/undo/redo`（E7 已验证） |
| 中文、日文输入法 | textarea 的 composition 事件；组字期间（keyCode 229）不转发按键 | 组字中用 `Input.imeSetComposition`，上屏用 `Input.insertText`（E7 已验证） |
| 输入法候选框位置 | 页面的隔离世界脚本在 `selectionchange` / `focusin` 时上报光标矩形 | textarea 移到对应位置，候选框就出现在页面光标旁 |
| 光标形状 | —— | `cursor-changed` → 画布的 CSS cursor |
| 悬停提示（title） | 隔离世界脚本上报 | 应用自己的 tooltip（P4） |
| 拖入文件 | 画布的 drop 事件 | CDP `Input.dispatchDragEvent`（dragEnter/Over/drop，带文件路径）（P4） |

- 页面焦点：每个标签页常开 `Emulation.setFocusEmulationEnabled(true)`，让页面始终认为自己有焦点（光标闪烁，焦点样式正常。E7 已验证；Codex 也这样做）。
- 浏览器快捷键：Cmd+L（地址栏）、Cmd+R（刷新）、Cmd+[ / ]（后退/前进）、Cmd+F（页面内查找）由浏览器面板自己处理。
- 元素选择器：鼠标悬停经转发后触发 `Overlay.setInspectMode` 的高亮，现有 `browser-element-picker.ts` 照常工作。

### 6.5 焦点规则（对应要求 2）

1. 页面永远不在窗口焦点链上：离屏窗口 `focusable: false`，从不 `show`。
2. 用户焦点只有在你点击页面画面时才进入焦点代理，点到画面外就离开。**AI 的任何动作都不会移动应用里的焦点。**
3. 页面不允许弹出任何系统窗口：对话框、文件选择、打印、全屏一律改成面板内的界面，或者直接拦截（见 6.7）。
4. CDP 桥继续拦截 `Page.bringToFront` 和 `Target.activateTarget`，只切换面板里的标签，不激活窗口（现状已如此，保留）。

### 6.6 后台可靠性（对应要求 1）

- 离屏渲染和主窗口是否可见无关，实测所有后台状态加跳转都可靠（E6）。
- AI 使用浏览器期间持有 `powerSaveBlocker.start('prevent-app-suspension')`，防止 App 隐藏时被 macOS 的 App Nap 降频。做法照搬 `remote/remote-access.ts`。
- 锁屏或显示器睡眠时离屏页预计不受影响（它不依赖屏幕刷新信号），实施时补测。

### 6.7 人机共用与网页弹出物（对应要求 3）

- **没有接管，也不加锁**（用户 2026-09-26 决定：技术上能不锁就不锁）。AI 操作期间页面四周保留「AI 在用」光圈，你随时可以直接点进去操作。
- **「你优先」规则**（代替锁，防止两边互相干扰；细节待确认）：
  - 要防的情况：页面只有一个输入焦点，两边同时打字，字会串进对方的输入框；AI 按旧截图的坐标点击，你刚好滚动过，就会点错；你把页面跳走后，AI 还在新页面上接着操作。
  - 你正在操作某个页面时（最近一次输入后约 1.5 秒内），AI 发往这个页面的点击、按键、输入先排队，等你停手再执行。AI 已经开始的一次点击或按键会做完，不会被切成两半。排队超过 10 秒，就把「用户正在操作」告诉 AI，由它决定继续等还是换一页。
  - 你动过页面之后，AI 下一次调用浏览器工具时，返回里会附一句「用户刚操作过这个页面」，提醒它先重新看一眼再动手。机制与现有的「标签页被回收」提示相同。
- **网页对话框（alert/confirm/prompt）**：在每个页面上替换 Electron 的 `'-run-dialog'` 处理（E3 已验证可行），不再弹系统框。
  - 标签页正在显示时，由面板内的 DOM 对话框处理；在后台时先排队，等你切过去再显示。
  - AI 通过 CDP `Page.javascriptDialogOpening` / `handleJavaScriptDialog` 仍然可以处理，任何一方处理完，另一方就收起。
  - 这同时堵上了「AI 页面弹 alert 可能抢焦点」的现存隐患（见第 0 节）。
- **文件选择**：始终开启 CDP `Page.setInterceptFileChooserDialog`（E3 已验证）。
  - 由你触发时（最近的输入来自你），用 `dialog.showOpenDialog(主窗口)` 选择文件，再调用 `DOM.setFileInputFiles` 填回。这是你主动发起的操作，允许弹窗。
  - 由 AI 触发时只把事件转给 AI，不弹窗。
- **下拉框、日期、颜色控件**：你的点击在转发前，先用 CDP `DOM.getNodeForLocation` 查一下点中了什么。如果是这类控件，就读出选项或当前值，由应用在画布上方画出选择器，选中后回写值并派发 `input` / `change` 事件。AI 用的 `select` 等工具本来就是直接设值，不受影响。
- **全屏和打印**：页面请求全屏时忽略（或只让面板最大化）；`window.print` 用隔离脚本拦截，改成面板提示，你确认后再打印（P4）。
- 新窗口转成新标签页、权限一律拒绝、下载处理：**保持现状**。

### 6.8 CDP 桥（AI 侧）

- 可见范围：`cdpTabs(scope)` 去掉 `control === 'agent'` 的过滤，返回当前对话的全部标签页。
- 删除 `/coilcoil/user-tabs/`、`/coilcoil/take-over/` 两个接口，以及工具 `browser_user_tabs`、`browser_take_over`（所有页面本来就能看到）。
- 「你优先」：桥按标签页记录用户最近一次输入的时间，按 6.7 的规则暂缓 AI 的 `Input.*` 命令；「用户刚操作过」的提示与回收提示走同一条通道（`/coilcoil/recycled-tabs/` 扩展为通用提示接口）。
- 我们内部用的命令（焦点模拟、文件选择拦截、对话框事件、隔离世界脚本）和 AI 的命令共用同一个 `webContents.debugger`：
  - AI 对 `Page.setInterceptFileChooserDialog` 的开关请求只做记录（虚拟化），实际的拦截始终开着，事件按记录决定转给谁。
  - `Page.reload` 改写成 `Page.navigate` 等现有规则，全部保留。
- AI 看到的页面和 chrome-devtools-mcp 的全部工具都不变（它现在本来就操作离屏页）。

### 6.9 其它能力迁移

| 能力 | 处理 |
|---|---|
| 右键菜单 | 事件从 guest 改为离屏页的 `context-menu`，菜单逻辑不变 |
| 缩放 | `setZoomFactor` 不变（Chromium 按站点记住缩放，导航后要重设，沿用现有逻辑） |
| 页面内查找 | `findInPage` 加面板内的查找条 |
| 元素选择器 | 不变（悬停需要转发，见 6.4） |
| UA、客户端提示头、`window.chrome` 注入 | 不变（离屏页现在就在用） |
| 密码自动填充 | 不变（基于页面脚本） |
| 开发者工具 | `openDevTools({ mode: 'detach' })` |
| 远程 / 手机端 | 继续用截图看画面；以后可以复用同一套输入转发，实现手机上直接点页面 |
| 界面重载 | 标签页不再随之销毁（主进程持有），这是相对 `<webview>` 的改进 |

### 6.10 安全与性能

- **安全**
  - 删掉主窗口的 `webviewTag: true`，以及 `will-attach-webview` 相关的整套加固和 guest 名册。
  - 离屏窗口沿用现有加固：sandbox、contextIsolation、按工作区分 partition、权限一律拒绝。
  - 输入通道只接受当前界面 scope 里正在显示的标签页，坐标会裁剪，频率有上限。
  - 隔离世界脚本只做上报，页面主世界看不到它。
- **性能**
  - 只有显示中、并且内容有变化的标签页才会出帧，静止页面不耗资源。
  - 后台标签页 1fps，不推帧。
  - 共享纹理零拷贝；去掉 JPEG 编码后，主进程 CPU 反而下降。

---

## 7. 代码改动清单

**删除**

- 渲染层：`features/browser/BrowserGuestLayer.tsx`、`features/browser/guestLayer.ts`
- 主进程：
  - `browser-guests.ts`
  - `browser-runtime.ts` 里的 `takeOverForAgent` / `takeOverForUser` / `historyOf` / `attachGuest` / guest 名册相关
  - `browser-webview-policy.ts` 里的 webview 加固和恢复标记（`restoreGuestSrc` / `restoreTabIdFromSrc`）。partition 相关函数挪出保留
- `index.ts`：`webviewTag: true`、`will-attach-webview` / `did-attach-webview` 处理、`webviewHostIds`、guest 名册 IPC
- preload 与 `shared/desktop-api.ts`：`browserGuestLayerReady` / `registerBrowserGuest` / `reportBrowserGuestFailure` / `onBrowserGuestRoster` / `takeOverBrowserTab` / `BROWSER_RESTORE_SRC_PREFIX`
- 测试：`tests/browser-guests.test.ts`、`browser-webview-policy.test.ts` 里的恢复标记用例
- 工具与接口：`packages/workflow/extensions/browser-act.ts` 里的 `browser_user_tabs` / `browser_take_over`；CDP 桥的 `/coilcoil/user-tabs/`、`/coilcoil/take-over/`

**修改**

- `browser-runtime.ts` / `browser-runtime-types.ts`：只保留离屏页这一条创建路径，去掉 `control` 字段，调整视口规则（6.3）
- `browser-offscreen.ts`：开启 `useSharedTexture`；`OffscreenFrameStream` 改为「共享纹理手动传递 + 背压 + 位图回退」；帧率策略
- `browser-cdp-bridge.ts` / `browser-cdp-commands.ts`：可见范围改为当前对话全部标签页；删除 take-over；「你优先」的暂缓与提示；文件选择拦截虚拟化
- `index.ts` 的 `installGuestContextMenu`：改为挂在离屏页上，菜单在画布位置弹出
- `AgentPageView.tsx` → `LivePageSurface.tsx`：canvas、焦点代理、自绘选择器和对话框、「AI 在用」浮层
- `BrowserPanel.tsx`：所有标签页都使用 LivePageSurface；地址栏、前进后退、刷新、元素选择对所有标签页可用（去掉只针对 AI 标签页的只读限制）
- `preload/index.ts`：共享纹理接收（`subtle`）；输入 MessagePort；页面事件订阅
- `packages/workflow/extensions/browser-act.ts`：浏览器工具说明补一句「默认在自己的标签页里干活；用户开的页面可以直接用」
- `docs/bundled-browser.md`：更新渲染方式和取舍章节

**新增**

- `main/browser-input.ts`：输入路由（鼠标、滚轮、键盘、输入法、编辑命令对照表、校验）
- `main/browser-page-dialogs.ts`：`-run-dialog` 替换、文件选择中转、全屏和打印策略
- `main/browser-page-pickers.ts`：下拉、日期、颜色控件的命中判断与回写
- `main/browser-page-agent.ts`：隔离世界脚本（光标位置、悬停提示），通过 `Runtime.addBinding` 回传
- `renderer/features/browser/LivePageSurface.tsx`、`surfaceKeys.ts`（键位映射）、`PagePicker.tsx`、`PageDialog.tsx`
- `shared/mac-editing-commands.ts`
- e2e：`browser-shared-control.mjs`（焦点、共用、不刷新）、`browser-background.mjs`（最小化、隐藏、折叠加跨站跳转截图）

**现有 e2e 的影响**

- `browser-takeover.mjs`：断言的是「接管后从离屏换成 webview、帧消失」，整体改写为共用场景，其中的 `focused()` 焦点断言直接复用。
- `draft-handoff.mjs`：删掉 `browser_take_over` 相关断言，改为断言 AI 能直接看到草稿里你开的页面。
- `agent-tab-resize.mjs`（断言离屏窗口尺寸跟随面板）、`agent-tab-live.mjs`（远程端看画面）：离屏页照旧，断言继续有效；远程端截图在共享纹理模式下已实测可用（E11）。
- `agent-tab-limit.mjs`、`browser-handles.mjs`、`browser-per-session.mjs`、`subagent-no-browser.mjs`：不受影响。

---

## 8. 分阶段实施

每个阶段都能单独发布；整体放在功能开关 `browser.sharedPage` 后面，出问题可以一键切回现状。

| 阶段 | 交付 | 验收 | 规模 |
|---|---|---|---|
| P0 准备 | 功能开关。先在现状上写好两条回归用例（「最小化/隐藏时 AI 跨站截图」「真实按键焦点」），并补测「离屏页弹 alert 是否抢焦点」 | 现状下 AI 标签页的截图、点击、打字焦点应通过（alert 场景若失败，即确认了现存隐患） | 小 |
| P1 AI 的页面可直接操作（核心） | LivePageSurface（先用现有 JPEG 帧）+ 鼠标、滚轮、键盘、输入法、编辑快捷键、复制粘贴、光标、右键转发；基础版自绘下拉；自接管网页对话框；去掉 AI 标签页的「接管」按钮和只读限制；「你优先」规则 | A1、A3、A6（AI 标签页范围内） | 大 |
| P2 GPU 画面 | 共享纹理 60fps + 位图回退；拖动时缩放画布，停下后再改尺寸 | A4 | 中 |
| P3 统一标签页 | 你新开的标签页也改成离屏页；删除 webview 图层、guest 登记、接管与恢复、`webviewTag`；AI 直接看到并能操作当前对话的全部标签页（删除接管工具）；改写 e2e | A1–A6 全部 | 大 |
| P4 细节补齐 | 文件选择、日期和颜色控件、悬停提示、页面内查找、拖入文件、全屏和打印策略、输入法候选框定位打磨 | 手测清单通过 | 中 |
| P5 收尾 | Windows 验证（共享纹理或回退）、耗电与性能检查、清理旧代码、更新文档 | 全量 e2e 通过 | 小 |

建议先做 P1 和 P2：你最痛的「接管就刷新」在 P1 完成后，对 AI 打开的页面就已经消失了。「AI 直接用你开的标签页」要等 P3：你的标签页换成离屏页之后，AI 去操作它才不会抢你的光标。

---

## 9. 测试方案

- **自动化（e2e，真实 App + mock 模型网关）**
  1. 焦点：AI 连续点击、输入、跳转、触发 alert、点文件选择框、开新页，同时往主输入框打字。断言文字全部在输入框，现有的 `focused()` 为真。另有一条 dev 专用用例，用 NSApp 真实按键投递。
  2. 后台：分别在 `BrowserWindow.minimize()`、`app.hide()`、面板折叠状态下，让 AI 跨站跳转、截图、点击。断言截图是新画面（随机背景色像素比对），点击生效。
  3. 共用：AI 开页并填一半表单 → 在画布上模拟用户点击和输入（含 composition 事件）→ 断言页面加载 id 不变 → AI 能读到用户输入的内容。
  4. 兼容：标签上限、按会话隔离、句柄、草稿交接、远程端画面。
  5. 你优先：模拟用户在一个输入框里持续打字，同时让 AI 点另一个输入框并输入。断言用户的字全部在原输入框里，AI 的动作在用户停手后完成。
- **单测**：键位和编辑命令映射、坐标换算（缩放与 DPR）、CDP 可见范围（当前对话全部标签页）、「你优先」的暂缓与放行、对话框和文件选择的路由（用户触发还是 AI 触发）。
- **手测清单**：中文和日文输入法的候选框位置；长文本选中复制；表单下拉框和日期控件；登录流程（含验证码 iframe）；视频播放；页面缩放；Retina 屏和外接屏切换；深浅色；面板拖动流畅度；锁屏后 AI 是否继续工作；多标签页时的耗电。

---

## 10. 风险与兜底

| 风险 | 影响 | 兜底 |
|---|---|---|
| 共享纹理在 Electron 43 里是实验接口 | 升级 Electron 后行为可能变化 | 保留位图回退；e2e 覆盖出帧；升级前回归 |
| 高层 `sendSharedTexture` 在沙箱下会卡死主进程（E8） | 主进程无响应 | 只用 `subtle` 手动传递，加背压，不走高层接口 |
| `'-run-dialog'` 是 Electron 内部事件 | 升级后可能失效，系统框重新出现 | e2e 断言「不出现系统框」；失效时退回 `disableDialogs: true`，由 CDP 处理 |
| 输入手感（输入法候选框位置、拖放、悬停提示、无障碍） | 个别场景不如原生 | 分阶段补齐；保留「在系统浏览器中打开」的出口；无障碍明确列为不支持 |
| 原生下拉和日期控件在离屏时不显示 | 表单难用 | P1 就做基础版下拉，P4 补日期和颜色 |
| Windows | 方案本身跨平台：离屏页、输入转发、CDP 都和系统无关，共享纹理 Electron 也支持 Windows 句柄（`ntHandle`）。Windows 上 Ctrl+A/C/V/X/Z/Y 这些编辑快捷键由 Chromium 内核自己处理（`editing_behavior.cc` 中 `#if !BUILDFLAG(IS_MAC)` 那一段），比 Mac 简单。但我手上没有 Windows 机器，GPU 传画面和 Windows 的后台降频都没有实机验证过 | 共享纹理出问题时自动回退位图（功能一样，只是多占一点 CPU）；需要一台 Windows 机器跑 e2e 和手测清单 |
| 离屏页的缩放比例创建后不能改 | 在不同 DPI 的屏幕间移动窗口时，画面可能略糊 | 接受；以后可以在页面空闲时重建 |
| 你和 AI 同时操作 | 字串进对方的输入框；AI 按旧画面点错位置 | 不加锁，用「你优先」规则兜住（6.7） |
| 后台标签页耗电 | CPU/GPU 占用 | 后台 1fps、不推帧；只在 AI 活动期间持有防降频 |

---

## 11. 已定与待定事项

**已定（2026-09-26）**

- AI 可以直接看到并操作当前对话里的全部标签页，不设共享开关（6.2）。
- 页面不加锁（6.7）。后来也不做「你优先」规则，见下面 2026-09-27 那条。
- 必须支持 Windows（CoilCoil 发 Windows 版）。
- 方向：采用「离屏统一 + 输入转发」，P0–P5 全部实施（用户对比了学 Cursor、学 Codex 改内核、给底座打补丁等方案后选定）。
- **不做「你优先」规则**（2026-09-27）：用户和 AI 可以同时操作，谁也不等谁；平时用户不会自己去操作 AI 在用的页面，就算操作了、影响到 AI 也没关系。只要在 AI 操作时给个提示：面板上显示「Agent 正在操作这个页面」，AI 停手 8 秒后收起（不管页面是谁开的）。
- **网页全屏保持「忽略」**（2026-09-27）：视频点全屏没反应，不做面板内全屏。

**待定**

1. **Windows 实机验证**：需要一台 Windows 机器跑测试。验证之前，Windows 版的画面先走位图回退，可以吗？——**已按这个默认做了**（Windows、Linux 默认走 JPEG 画面，`COILCOIL_BROWSER_GPU_FRAMES=1` 可强制打开 GPU 画面做验证），你不同意可以改回；真机验证还没做。

---

## 附录 A：关键代码（实验中已跑通）

**共享纹理手动传递**（主进程 → 沙箱 preload，60fps）

```js
// 主进程
page.webContents.on('paint', (e) => {
  const texture = e.texture; if (!texture) return;          // 为空说明 GPU 不可用，走位图回退
  if (pending.size >= 3) { texture.release(); return; }     // 背压：渲染端跟不上就丢帧
  const imported = sharedTexture.subtle.importSharedTexture(texture.textureInfo);
  const transfer = imported.startTransferSharedTexture();
  pending.set(++seq, { imported, texture });
  mainWindow.webContents.send('browser:frame', seq, transfer);
});
ipcMain.on('browser:frame-done', (_e, id) => {
  const d = pending.get(id); if (!d) return; pending.delete(id);
  d.imported.release(() => d.texture.release());
});
// preload（sandbox: true）
ipcRenderer.on('browser:frame', (_e, id, transfer) => {
  const imported = sharedTexture.subtle.finishTransferSharedTexture(transfer);
  const frame = imported.getVideoFrame();
  canvas.getContext('2d').drawImage(frame, 0, 0);
  frame.close();
  imported.release(() => ipcRenderer.send('browser:frame-done', id));
});
```

**不弹系统对话框、不弹文件选择窗**

```js
wc.removeAllListeners('-run-dialog');                        // Electron 内部事件，需 e2e 守护
wc.on('-run-dialog', (info, callback) => queueInPanelDialog(tabId, info, callback));
await wc.debugger.sendCommand('Page.enable');
await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
// Page.javascriptDialogOpening / Page.fileChooserOpened 按「谁触发的」分发给面板或 AI
```

**输入转发的基本调用**

```js
wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY, canScroll: true, hasPreciseScrollingDeltas: true });
await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] });
await cdp('Input.imeSetComposition', { text: 'ni hao', selectionStart: 6, selectionEnd: 6 });
await cdp('Input.insertText', { text: '你好' });
```

实验脚本放在 `/tmp/focus-exp`（临时目录，重启会丢）。复现要点和真实按键的投递方法已写入项目记忆。

## 附录 B：参考源码位置

- Chromium：`content/browser/renderer_host/render_widget_host_impl.cc`（`OnInputEventPreDispatch`）、`content/browser/web_contents/web_contents_impl.cc`（`FocusOwningWebContents` / `SetFocusedFrameTree`）
- Electron：`shell/browser/api/electron_api_web_contents.cc`（`ReadyToCommitNavigation`、`HandleNewRenderFrame`、`RunJavaScriptDialog`）、`lib/browser/api/web-contents.ts`（`'-run-dialog'`）、`shell/browser/native_window.cc`（`UpdateBackgroundThrottlingState`）、`docs/api/shared-texture.md`、`spec/api-shared-texture.spec.ts`
- VS Code：`src/vs/platform/browserView/electron-main/browserView.ts`、`src/vs/workbench/contrib/browserView/electron-browser/overlayManager.ts`
- Cursor 3.22.7：`/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`（`WebviewBrowserManager`）、`extensions/cursor-browser-automation/dist/extension.js`（工具定义与合成事件）
- Codex 26.917：`/Applications/ChatGPT.app/Contents/Resources/app.asar`（`.vite/build/main-*.js`、`webview/assets/app-shared-*.js`），运行时 `Codex Framework.framework`（Owl）

---

## 12. 实施记录（2026-09-27）

从 `a8cf059bf`（本文档）起的这一批提交，只在本地，没有推送。

### 12.1 各阶段交付

| 阶段 | 交付 | 验证（e2e 场景） |
|---|---|---|
| P0 | 回归基线：最小化、Cmd+H 隐藏、面板收起时 AI 跨站跳转后截图新鲜、点击生效 | `browser-background`（及 GPU 版） |
| P1a–b | 用户的鼠标、滚轮、键盘、输入法、Mac 编辑快捷键、光标形状、右键菜单转进离屏页；去掉接管按钮和只读限制 | `browser-shared-control`（22 项，含真实按键） |
| P1c | 网页 alert / confirm 改成面板卡片，用户和 AI 都能答；点击触发对话框时告诉 AI「操作已生效」 | `browser-page-dialogs` |
| P1d | 原生下拉框由面板画列表，写回前逐项核对选项没被改过 | `browser-shared-control` |
| P2 | GPU 共享纹理画面（实测 61 帧），JPEG 退路 | `browser-live-frames`、`*-gpu` |
| P3 | 全部标签页统一为离屏页；删除 `<webview>` 图层、嵌入页登记、接管与恢复；AI 用 `browser_tabs` 直接使用当前对话全部标签页，不刷新 | `draft-handoff`、`browser-handles`、`agent-tab-*` |
| P4a | AI 点到选文件、打印：什么都不弹、App 不卡；用户点：照常选文件、打印出 PDF | `browser-page-system` |
| P4b | 页内查找（⌘F）、输入法候选框跟光标、页面内拖拽与从访达拖文件、日期/时间/颜色选择器（Chromium 自己的）、跨站内嵌页的下拉框和颜色框、悬停提示 | `browser-find`、`browser-caret`、`browser-drag`、`browser-value-pickers`、`browser-frame-pickers`、`browser-tooltip` |
| P5 | 窗口最小化、隐藏、被完全挡住时降到一秒一帧（唤醒从每秒 32 次降到 0）；Windows、Linux 默认 JPEG 画面；安全底线改在主进程核对；全屏请求不会让藏着的窗口冒出来；清理旧检查脚本、旧命名和文档 | `browser-power`、`browser-security`、`browser-fullscreen` |

### 12.2 和计划不一样的地方

- **没有做功能开关**（第 8 节写的 `browser.sharedPage`）。P3 直接删掉了旧结构，出问题的退路是回退这批提交；GPU 画面单独有开关（`COILCOIL_BROWSER_GPU_FRAMES`）。
- **拖面板时**网页跟着实时改大小，没做「拖动时只缩放画面、停下再改尺寸」。目前没测到卡顿；重页面上拖着卡再做。
- **右键菜单、悬停提示、日期选择器**都比计划做得更贴近原生：日期、时间、颜色用的是 Chromium 自己的选择器（在输入框位置放一个同类型的隐形输入框打开），不是自绘。
- **全屏**按 6.7 的「忽略」做；实施中发现 Electron 默认会把藏着的窗口变成全屏窗口冒出来（被权限拒绝挡住了），又在页面设置里加了一道「全屏不改窗口」。
- **实施中顺带修的**：鼠标只是从画面上经过，也会让 AI 的标签页永久免于回收（上限失效），改成只有点击、按键、滚动才算「用户用过」。

### 12.3 还剩的事

- Windows 真机验证（GPU 画面、后台降频、输入法）。
- 不支持：网页无障碍读屏、网页脚本自己调 `showPicker()`、跨站内嵌页里的日期框。
- `scripts/desktop-smoke.mjs`（打包版总检查）在新手引导一带就过时了（期待首次启动自动开设置页等），到不了浏览器那段；浏览器那段已按新结构改写，并在 e2e 里对着现在的界面验证过。
