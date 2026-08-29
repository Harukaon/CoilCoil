# 看板数据流

## 文件

| 文件 | 谁写 | 说明 |
|---|---|---|
| `tasks.json` | agent（`agentNotes`/`commits`/`status`）+ 用户（导出覆盖） | 唯一真相源 |
| `board.template.html` | 手写 | 看板模板，含注入标记 |
| `index.html` | `build.mjs` 生成 | **双击打开这个** |
| `results/task-<id>.json` | 各 agent 独立写 | 并发安全的中间产物 |

## 为什么要 build 这一步

双击打开的页面走 `file://`，`fetch()` 读同目录 JSON 会被 CORS 拦掉，看板会全白。
`build.mjs` 把 `tasks.json` 内联进 HTML，绕开这个限制。

## 两种打开方式

**推荐：起服务打开。** 在仓库根目录跑

```
node docs/taskboard/serve.mjs
```

然后打开它打印出来的地址（默认 http://127.0.0.1:4399/）。这样打开时，你在页面上
改状态、写回复、贴图，**每一下都直接写进 `tasks.json`**，不需要导出，我这边直接
就能读到。右上角会显示「已保存」。

**双击 index.html** 也还能用，但那是 `file://`，网页在这种情况下没有写磁盘的权限，
改动只存在浏览器里，要让我读到就得点导出、覆盖 `tasks.json`。除非不方便起服务，
否则用上面那种。

## 循环

```
我改 tasks.json / agent 写 results/*.json
        ↓
node docs/taskboard/build.mjs        # 合并 + 重新生成 index.html
        ↓
你双击 index.html → 改状态、打回、回复、贴图
        ↓
点「导出 tasks.json」→ 覆盖 docs/taskboard/tasks.json
        ↓
我读到你的 userComments，继续下一轮
```

你的改动实时存在浏览器 localStorage，不导出也不会丢；但要让我读到，得导出覆盖一次。

## 合并规则

`index.html` 加载时以内置数据为骨架合并 localStorage：

- `status`、`userComments` — 取你本地的
- `agentNotes`、`commits`、正文 — 取内置的（我这边更新的）
- 你在看板上新建的 Issue（内置数据里没有的 id）保留

所以我更新任务内容不会覆盖掉你写的回复。
