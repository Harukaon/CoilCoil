# 内置浏览器性能测量脚本

用来查 issue #2「浏览器首次打开网页很卡」。都是**独立的最小 Electron 进程**，
不启动 CoilCoil 本体、不碰用户的 app 数据目录（每次自己 `mkdtemp` 一个临时档案）。

在 macOS 主机的仓库根目录跑：

```
./node_modules/.bin/electron apps/desktop/bench/browser-cold-start.cjs
./node_modules/.bin/electron apps/desktop/bench/browser-render-path.cjs --mode=view --rounds=4 --url=<url1>,<url2>,...
./node_modules/.bin/electron apps/desktop/bench/proxy-check.cjs
```

- `browser-cold-start.cjs` —— 复刻 `BrowserRuntimeManager.createCdpTab` 的真实顺序
  （建 `<webview>` → about:blank 的 dom-ready → 回报 id → `debugger.attach` →
  `Emulation.setDeviceMetricsOverride` → `loadURL`），逐段计时，页面用本机 http
  服务以排除网络。`--seed=N` 先写 N 条 Cookie 再退出，配 `--user-data=<dir>`
  可以量「导入过大量登录状态的档案」冷读的代价。
- `browser-render-path.cjs` —— 同一个网址，CoilCoil 的 `<webview>` 路子 vs
  `WebContentsView`，各跑若干轮。
- `proxy-check.cjs` —— 内置浏览器那个 session 分区解析出来的代理是什么。
