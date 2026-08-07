# SuoCode 多 Agent 并行开发指南

## 目的

本文规定多个 Agent 同时开发 SuoCode 时的统一操作流程。

Agent A、Agent B、Agent C、Agent D 仅用于标识不同的开发环境，不代表任务类型、优先级或难度。具体任务由当前开发计划另行决定，所有 Agent 均遵循本文相同的规则。

## 核心规则

1. 一个 Agent 对应一个 Git 分支、一个 Git worktree 和一个 Electron 用户数据目录。
2. 不允许两个 Agent 同时在同一个工作目录内修改文件或执行 Git 操作。
3. 原始 `SuoCode` 目录默认作为主工作区，只用于同步 `main`、集成分支、解决冲突和最终验证。
4. Agent 只能在自己的 worktree 内开发、启动应用和运行测试。
5. 每次交付必须包含 Git commit、验证结果和必要的风险说明。
6. 不得切换、重写、强推或删除其他 Agent 正在使用的分支。
7. 不得把 API Key、Electron 用户数据、会话数据、缓存或本地配置提交到仓库。

## 标准环境映射

按实际并发数量创建所需环境，不要求每次都创建四个。

| 环境 | 分支 | worktree | Electron 用户数据目录 |
|---|---|---|---|
| Agent A | `agent/a` | `/Users/hao/Desktop/project/SuoCode-agent-a` | `/Users/hao/Desktop/project/.suocode-dev-data/a` |
| Agent B | `agent/b` | `/Users/hao/Desktop/project/SuoCode-agent-b` | `/Users/hao/Desktop/project/.suocode-dev-data/b` |
| Agent C | `agent/c` | `/Users/hao/Desktop/project/SuoCode-agent-c` | `/Users/hao/Desktop/project/.suocode-dev-data/c` |
| Agent D | `agent/d` | `/Users/hao/Desktop/project/SuoCode-agent-d` | `/Users/hao/Desktop/project/.suocode-dev-data/d` |

## 创建开发环境

环境创建应由负责集成的操作者统一执行。创建前确认主工作区没有未提交内容，也没有 Agent 正在其中写文件。

```bash
cd /Users/hao/Desktop/project/SuoCode
git status --short --branch
git switch main
git pull --ff-only
```

根据需要创建 worktree：

```bash
git worktree add ../SuoCode-agent-a -b agent/a main
git worktree add ../SuoCode-agent-b -b agent/b main
git worktree add ../SuoCode-agent-c -b agent/c main
git worktree add ../SuoCode-agent-d -b agent/d main
```

如果分支已经存在，只需要重新挂载 worktree：

```bash
git worktree add ../SuoCode-agent-a agent/a
```

每个新 worktree 都需要准备自己的依赖。不要手工复制或共享正在被其他环境使用的 `node_modules`。

```bash
cd /Users/hao/Desktop/project/SuoCode-agent-a
npm run setup
```

其他环境使用相同方式操作。

## Agent 开始任务前

每个 Agent 收到任务后，首先进入自己的 worktree，并确认路径、分支和工作区状态。

```bash
cd /Users/hao/Desktop/project/SuoCode-agent-a
pwd
git branch --show-current
git status --short --branch
git log -1 --oneline
```

预期结果必须同时满足：

- 当前路径属于该 Agent 的 worktree。
- 当前分支属于该 Agent。
- 没有来源不明的未提交修改。
- 当前任务的目标、验收条件和影响范围已经明确。

如果 `main` 在该环境创建后有新提交，应先确保自己的修改已经提交，再同步主分支：

```bash
git merge main
```

不要在有未确认修改时同步，也不要自行合并其他 Agent 的活动分支。如果当前任务依赖另一个 Agent 的修改，应先取得明确的 commit，再由集成流程决定合并或 cherry-pick。

## 开发过程

开发期间遵循以下规则：

- 只修改当前任务需要的文件。
- 定期执行 `git status --short` 和 `git diff`，及时发现意外改动。
- 使用小而完整的 commit，避免把多个无关修改放进一次提交。
- 修改公共接口、协议、共享类型或依赖配置时，应尽早通知其他正在工作的 Agent。
- 发现多个 Agent 需要修改同一文件时，应先协调修改顺序或接口边界，不要直接在其他 worktree 中编辑文件。
- 不依赖其他 worktree 中尚未提交的文件状态。
- 不在其他 Agent 的目录内执行安装、格式化、构建、清理或 Git 命令。
- 不使用 `git reset --hard`、强制删除 worktree、强制推送等可能破坏其他工作成果的操作。

## 启动 Desktop APP

多个 Agent 可以同时执行 `npm run dev`。当前 Electron Vite 配置没有锁死 renderer 端口，Vite 通常会自动选择下一个可用端口。

但是，SuoCode Desktop 默认通过 Electron `userData` 保存模型设置、凭据、会话和运行时数据。所有开发实例必须使用不同的 `--user-data-dir`。

Agent A：

```bash
cd /Users/hao/Desktop/project/SuoCode-agent-a
ELECTRON_CLI_ARGS='["--user-data-dir=/Users/hao/Desktop/project/.suocode-dev-data/a"]' npm run dev
```

Agent B：

```bash
cd /Users/hao/Desktop/project/SuoCode-agent-b
ELECTRON_CLI_ARGS='["--user-data-dir=/Users/hao/Desktop/project/.suocode-dev-data/b"]' npm run dev
```

Agent C：

```bash
cd /Users/hao/Desktop/project/SuoCode-agent-c
ELECTRON_CLI_ARGS='["--user-data-dir=/Users/hao/Desktop/project/.suocode-dev-data/c"]' npm run dev
```

Agent D：

```bash
cd /Users/hao/Desktop/project/SuoCode-agent-d
ELECTRON_CLI_ARGS='["--user-data-dir=/Users/hao/Desktop/project/.suocode-dev-data/d"]' npm run dev
```

启动后还必须确认 APP 内打开的是当前 Agent 自己的 worktree。例如 Agent A 应选择 `/Users/hao/Desktop/project/SuoCode-agent-a`，不能让多个实例同时操作同一个项目目录。

不同用户数据目录之间不会自动共享模型配置和凭据。需要测试真实模型时，应分别配置，或使用项目支持的环境变量注入凭据；不得把凭据写入仓库。

如果启用远程调试，不同实例不得指定相同的 `--remote-debugging-port`。

## 启动 CLI

并行测试 CLI 时也要隔离数据目录，并将 CLI 指向当前 Agent 自己的 worktree。

```bash
cd /Users/hao/Desktop/project/SuoCode-agent-a
SUOCODE_DATA_DIR=/Users/hao/Desktop/project/.suocode-dev-data/a-cli \
  npm run cli -- /Users/hao/Desktop/project/SuoCode-agent-a
```

其他 Agent 替换对应的环境标识和路径。

## 测试与验证

每个 Agent 应在自己的 worktree 中运行与修改范围匹配的检查。常用命令包括：

```bash
npm run check
npm test
npm run smoke
npm run smoke:desktop
npm run package:desktop
```

执行原则：

- 开发过程中优先运行受影响模块的快速检查。
- 提交前至少运行 TypeScript 检查及相关测试。
- Desktop smoke 脚本已经使用临时用户数据目录和可用端口，可以在不同 worktree 中运行。
- 构建产物位于各自 worktree 内，不要从其他 Agent 的构建目录取产物进行验证。
- `smoke:live` 和 `smoke:desktop:live` 会发起真实模型请求，只在任务明确要求时运行，并注意费用、限流和凭据隔离。

## 提交与交付

提交前检查全部修改：

```bash
git status --short
git diff --stat
git diff
git diff --check
```

只暂存当前任务需要的文件，然后创建含义明确的 commit。不要为了方便直接提交来源不明的文件。

完成后向集成操作者提供：

```text
Agent 环境：
分支：
Commit：
主要修改：
已运行检查：
未运行检查及原因：
已知风险或后续事项：
```

Agent 完成交付后应保持分支和 worktree 可用，等待集成完成。未经确认不得自行删除分支或工作目录。

## 集成流程

集成应在原始 `SuoCode` 主工作区中进行，不要在任何 Agent 的活动 worktree 中合并全部分支。

```bash
cd /Users/hao/Desktop/project/SuoCode
git status --short --branch
git switch main
git pull --ff-only
git switch -c integration/multi-agent-batch
```

逐个合并本批次需要的 Agent 分支：

```bash
git merge --no-ff agent/a
git merge --no-ff agent/b
git merge --no-ff agent/c
git merge --no-ff agent/d
```

只合并本批次实际参与的分支。每次合并后检查状态，必要时先运行相关测试，再继续合并下一个分支。

发生冲突时：

1. 先确认冲突来自哪些 commit 和哪些行为变化。
2. 不要简单选择 `ours` 或 `theirs` 覆盖另一方修改。
3. 对无法判断的业务语义，交由对应修改的 Agent 说明意图或在其分支中修正。
4. 解决冲突后重新运行受影响测试。
5. 检查最终 diff，确认没有把某个分支的有效修改意外删除。

全部合并后执行完整验证：

```bash
npm run check
npm test
npm run smoke
```

根据发布范围继续运行 Desktop smoke 或打包验证。确认集成分支通过后再合并到 `main`：

```bash
git switch main
git merge --no-ff integration/multi-agent-batch
```

## 长任务期间同步主分支

如果其他分支已经完成集成并进入 `main`，仍在开发的 Agent 应在收到同步通知后执行：

```bash
cd /Users/hao/Desktop/project/SuoCode-agent-a
git status --short
git merge main
```

同步前必须提交当前修改。同步冲突应在当前 Agent 自己的分支中解决并验证。

已经共享或推送的 Agent 分支优先使用 merge 同步，避免重写历史。不要 force-push，也不要 rebase 其他 Agent 的分支。

## 环境清理

只有在对应分支已经完成集成、worktree 没有未提交内容、相关开发进程已经停止后，才可以清理环境。

```bash
cd /Users/hao/Desktop/project/SuoCode
git worktree list
git worktree remove ../SuoCode-agent-a
git branch -d agent/a
git worktree prune
```

其他 Agent 使用对应路径和分支。不要使用 `--force` 绕过未提交修改检查。

Electron 用户数据目录默认保留，便于下一次继续测试。需要清理时应先确认目录和备份需求，不要使用指向项目根目录或其他宽泛路径的递归删除命令。

## 常见问题

### 两个 APP 的配置或会话混在一起

说明两个实例使用了同一个 Electron 用户数据目录。停止对应实例，检查启动命令中的 `--user-data-dir`，使用各自独立目录重新启动。不要在未确认内容时直接删除共享目录。

### 第二个 APP 启动时端口被占用

先查看 Electron Vite 输出的实际 renderer 地址。默认情况下 Vite 会选择其他可用端口；如果人为配置了固定端口或远程调试端口，应为不同实例分配不同端口。

### 一个 Agent 看到了另一个 Agent 的代码变化

先执行 `pwd`、`git branch --show-current` 和 `git worktree list`。最常见原因是进入了错误目录，或者两个 Agent 被指向同一个 worktree。立即停止写入，确认修改归属后再继续，不要直接覆盖或移动来源不明的文件。

### 依赖或原生模块异常

确认当前 worktree 已独立执行 `npm run setup`。不要让多个 Agent 共享一个正在被安装或重建的 `node_modules`。

### 多个分支修改了同一文件

各 Agent 先分别提交自己的完整修改，再通过集成分支解决冲突。不要让一个 Agent 直接进入另一个 worktree 修改未提交内容。

## 操作检查清单

开始任务前：

- [ ] 当前路径是自己的 worktree。
- [ ] 当前分支是自己的 Agent 分支。
- [ ] 工作区状态已确认。
- [ ] 任务目标和验收条件明确。
- [ ] 需要启动 APP 时已分配独立用户数据目录。

提交任务前：

- [ ] 只包含本任务相关修改。
- [ ] 已检查完整 diff。
- [ ] 已运行相关检查和测试。
- [ ] 已创建 Git commit。
- [ ] 已报告 commit、验证结果和风险。

集成完成前：

- [ ] 所有目标分支已逐个合并。
- [ ] 冲突解决保留了各方有效行为。
- [ ] 集成分支通过完整验证。
- [ ] 合并到 `main` 后状态干净。
- [ ] 仅在确认安全后清理 worktree 和分支。
