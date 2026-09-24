# 端到端测试：真实桌面 App + mock 模型

单元测试和类型检查看不到「用户真的点了、Agent 真的调了工具之后」会发生什么。这里把
真实的 CoilCoil 桌面端跑起来，接一个可编排的 mock 模型网关，用 Playwright 像人一样
点界面、打字、发消息，再检查界面和实际效果。除了模型的回答是剧本写好的，其余全是
真的：运行时、工具执行、CDP 桥、内置浏览器、真实网页、真实文件。

## 怎么跑

```bash
npm run build --workspace @coilcoil/desktop   # 跑的是构建产物，改完代码先构建
npm run e2e                                   # 全部场景
npm run e2e -- agent-tab-limit file-diff      # 只跑这几个
```

Linux 服务器上没有屏幕时套一层虚拟显示：`xvfb-run -a npm run e2e`。mac 和 Windows
直接跑，会弹出真实窗口。每个场景都用全新的临时数据目录，不碰你自己的 CoilCoil 数据。
有失败时退出码非零；截图路径会打印在最后。

## 它怎么工作

- `mock-gateway.mjs`：实现 OpenAI Chat Completions 的流式接口，在 CoilCoil 里被配成
  一个普通的自定义模型「Mock 1」（默认模型，也是各个子 Agent profile 的模型）。
- `harness.mjs`：启动 App（临时数据目录、预配 mock 模型、挂载 projA / projB 两个
  文件夹、跳过引导页）、起一个本地测试网站（`site/`），以及模拟用户操作的辅助函数。
- `scenarios/*.mjs`：每个场景一个文件，导出 `description` 和 `run(ctx)`；用
  `check(说明, 是否通过, 细节)` 记录结果，`shot(名字)` 截图。
- `run.mjs`：按顺序跑场景、汇总结果。

## 剧本怎么写

发给 App 的消息里带一段 `MOCK:[...]`，模型就按它一步步回复。前面可以带一个标签，
它同时会成为会话标题，方便在侧栏里找：

```
会话一 MOCK:[{"tool":"browser_open","args":{"url":"http://..."}},{"echo":true}]
```

每一步是其中之一：

| 步骤 | 模型这一轮做什么 |
|---|---|
| `{"tool": "名字", "args": {...}}` | 调一次工具（`purpose` 字段自动补上） |
| `{"tools": [{...}, {...}]}` | 同一轮里调好几个工具 |
| `{"text": "..."}` | 回一段文字 |
| `{"echo": true}` | 回一段「工具返回：……」，原样引用上一个工具的结果，方便在界面上核对 |

聊天里看到的「工具返回：……」就是 `echo` 这一步，是测试手段，真实模型不会这样回复。

子 Agent 的剧本写在派发它时的 `task` 里，同样用 `MOCK:[...]`。网关把收到的每个请求
（带了哪些工具、最后一条消息、这一轮的回复）记在日志里，场景里用 `gatewayLog()`
读，可以检查某个 Agent 当时手里到底有哪些工具。
