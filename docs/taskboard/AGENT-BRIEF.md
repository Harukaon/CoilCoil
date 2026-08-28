# 子 agent 作业说明（2026-08-29 轮次）

你在一个 **git worktree** 里工作，只做分配给你的那几个 Issue。看板在
`docs/taskboard/`，任务正文在 `docs/taskboard/tasks.json`。

## 1. 这个仓库有两侧

同一个 checkout 同时被两个地方看到：

| | 路径 |
|---|---|
| macOS 主机 | `/Users/hao/Desktop/project/SuoCode` |
| Orb Ubuntu（你所在的地方） | `/home/hao/Workspace/SuoCode`（sshfs 挂载） |

**改文件在 Ubuntu 这边直接改**（Read/Edit/Write/grep 都正常）。
**但是 git、npm、tsc、测试、构建一律在 Mac 上跑** —— `node_modules` 是
darwin-arm64 的原生件（esbuild / electron / node-pty），在 Linux 里根本执行不了；
worktree 的 gitdir 也是 macOS 绝对路径。

用这个包装脚本，不要自己拼 ssh：

```
bash docs/taskboard/mac.sh <你的worktree名> '<命令>'
```

例：

```
bash docs/taskboard/mac.sh r1a 'npm run check --workspace @coilcoil/desktop'
bash docs/taskboard/mac.sh r1a 'git add -A && git commit -m "..."'
bash docs/taskboard/mac.sh r1a 'git log --oneline -3'
```

`mac.sh main ...` 是主仓库，**不要动主仓库**，你只在自己的 worktree 里提交。

## 2. 测试与隔离策略（必须遵守）

这一轮有 3 个 agent 同时在跑，Mac 是共享的。所以：

**允许（并且要求你做）**

- `npm run check --workspace <你改到的包>` —— tsc，必须过。
- `npm test --workspace <你改到的包>` —— 单元测试，必须过。
- 单文件重跑：`node --experimental-strip-types --test tests/<x>.test.ts`。
- 只跑你改到的 workspace，不要全仓库 `npm run check` / `npm test`，那会让三个人互相拖慢。

**禁止**

- ❌ `npm run package:desktop` / `electron-builder` / `npm run smoke*` ——
  这些要打包整个 Electron app，三个人并发会抢 electron-builder 缓存和 DevTools 端口。
  端到端冒烟由**管控方在合并到 main 之后串行跑**，不是你的活。
- ❌ `npm run dev` —— 会起一个真的 app 窗口，抢用户正在用的东西。
- ❌ 碰 `~/Library/Application Support/@coilcoil/desktop/` —— 那是用户**正在运行**的
  CoilCoil 的真实数据（会话、settings.json、models.json）。任何读写都不行。
  需要 app 数据目录就用 `mkdtemp` 造临时的，仓库里现成的 smoke 脚本就是这么做的
  （`--user-data-dir=<临时目录>`）。
- ❌ `git push`、`git merge main`、切分支、动别人的 worktree。
- ❌ 重启/退出用户 Mac 上正在跑的 CoilCoil.app。

已知会 flake 的测试：`packages/workflow/tests/terminal-cleanup.test.ts` 在整仓库压力下
偶发失败（断言窗口只有几十毫秒），单独重跑该文件通过就算过，不要为它改产品代码。

## 3. 交付物

### 3.1 代码提交

在自己的 worktree 里提交，**一个 Issue 一个 commit**，标题带上 issue 号：

```
fix(desktop): 终端不再强制滚动到底部 (#1)
```

commit message 里写清楚**为什么**这么改，不只是改了什么。结尾加：

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

### 3.2 看板结果文件（每个 Issue 一份，必须写）

写到 `docs/taskboard/results/task-<id>.json`，**和代码一起提交**。
一个 agent 只写自己负责的那几个 id，所以并发不会打架。

```json
{
  "id": 1,
  "status": "review",
  "agentNotes": [
    {
      "by": "r1a",
      "at": "2026-08-29T04:00:00.000Z",
      "text": "根因：xterm 的 scrollback 在 write 回调里被无条件 scrollToBottom。改成只有用户本来就贴底时才跟随。\n验证：npm run check + npm test（desktop）全过。\n遗留：长时间渲染错乱没能复现，加了一个可疑点的说明，见 commit。"
    }
  ],
  "commits": [
    { "ref": "abc1234", "at": "2026-08-29T04:00:00.000Z", "message": "fix(desktop): ...", "files": ["apps/desktop/src/renderer/Terminal.tsx"] }
  ]
}
```

`status` 只能填：

- `review` —— 你改完了、测试过了，等用户验收。**正常情况都填这个。**
- `reply` —— 你需要用户拍板才能继续（做不了 / 有歧义 / 需要用户给截图）。
  这时 `agentNotes` 里必须写清楚卡在哪、你需要什么信息、你倾向哪个方案。
- `doing` —— 你只做了一半（比如时间不够），写清楚做到哪了、下一步是什么。

**不要**直接改 `tasks.json`，那是管控方和用户共用的文件。
**不要**改 `index.html`，它是生成物。

### 3.3 【提问】/【检查】/【方案讨论】类 Issue

有些 Issue 不是让你改代码，是让你查清楚然后回答（标题里带【】）。
这类就把答案写进 `agentNotes`，`status` 填 `review`，没有 commit 也没关系
（但 results 文件本身要提交）。答案要具体到文件和行号，不要泛泛而谈。

## 4. 工作方式要求

- 先读代码搞清楚现状，再动手。改不动或者发现需求本身有问题，写进 `agentNotes`，
  用 `reply` 状态，不要硬猜着改一通。
- 这个产品的中文界面文案、既有代码风格（命名、注释密度）要跟着周围代码走。
- 用户看不懂代码，`agentNotes` 用中文写人话，讲清楚"现在会变成什么样"，
  不要贴 diff。
- 不要问人。这一轮没有人可以回答你，把问题写进 `agentNotes` 就行。
