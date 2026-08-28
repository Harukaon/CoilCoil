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
