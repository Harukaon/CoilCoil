#!/usr/bin/env bash
# 多 agent 并行开发的 worktree 脚手架。
#
#   wt.sh add <name>     从 main 开一个 worktree 到 <repo>/.worktrees/<name>，分支 task/<name>
#   wt.sh drop <name>    删掉 worktree 和分支
#   wt.sh list           列出当前 worktree
#
# 两个关键点：
#
# 1) worktree 放在仓库内部的 .worktrees/ 下（已 gitignore）。这个仓库同时被两侧访问：
#    macOS 本机路径是 /Users/hao/Desktop/project/SuoCode，Orb Ubuntu 里是 sshfs
#    挂载的 /home/hao/Workspace/SuoCode。放在仓库内部，两侧都能看到同一批 worktree。
#    worktree 的 gitdir 是 macOS 绝对路径（--relative-paths 会打开 VM 侧 git 2.43
#    不认识的 relativeWorktrees extension），所以 **git 命令一律走 mac.sh 在 Mac 上跑**，
#    VM 这边只负责改文件。
#
# 2) 干净的 worktree 没有 node_modules / dist，tsc 和 test 都跑不起来。
#    node_modules 用相对软链指回主仓库（只读使用，省几个 G）；
#    dist 是构建产物，必须复制而不是软链，否则并发的 agent 会互相覆盖。
set -euo pipefail

MAIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WT_ROOT="$MAIN/.worktrees"

LINK_DIRS=(
  node_modules
  apps/desktop/node_modules
  packages/runtime-core/node_modules
  packages/workflow/node_modules
  vendor/pi/node_modules
)
COPY_DIRS=(
  apps/cli/dist
  packages/openai-responses-ws/dist
  vendor/pi/packages/agent/dist
  vendor/pi/packages/ai/dist
  vendor/pi/packages/client/dist
  vendor/pi/packages/coding-agent/dist
  vendor/pi/packages/protocol/dist
  vendor/pi/packages/server/dist
  vendor/pi/packages/telemetry/dist
  vendor/pi/packages/tui/dist
)

# 从 $WT_ROOT/<name>/<sub> 回到 $MAIN 需要几层 ..
up_to_main() {
  local depth=2                     # .worktrees/<name>
  local sub="$1"
  depth=$((depth + $(tr -cd '/' <<<"$sub" | wc -c)))
  local out=""
  for _ in $(seq 1 $depth); do out="../$out"; done
  printf '%s' "$out"
}

cmd="${1:-}"
case "$cmd" in
  add)
    name="${2:?缺少 worktree 名字}"
    dir="$WT_ROOT/$name"
    branch="task/$name"
    mkdir -p "$WT_ROOT"
    git -C "$MAIN" worktree add -B "$branch" "$dir" main >/dev/null

    for d in "${LINK_DIRS[@]}"; do
      [ -e "$MAIN/$d" ] || continue
      mkdir -p "$(dirname "$dir/$d")"
      ln -sfn "$(up_to_main "$d")$d" "$dir/$d"
    done

    # 软链出来的 node_modules 在 git 眼里是个文件，.gitignore 里 `node_modules/`
    # 带斜杠只匹配目录，所以要在 worktree 自己的 exclude 里再排一次。
    # info/exclude 只有 common git dir 那一份对所有 worktree 生效
    excl="$(git -C "$MAIN" rev-parse --git-common-dir)/info/exclude"
    mkdir -p "$(dirname "$excl")"
    for d in "${LINK_DIRS[@]}"; do
      grep -qxF "/$d" "$excl" 2>/dev/null || printf '/%s\n' "$d" >> "$excl"
    done

    for d in "${COPY_DIRS[@]}"; do
      [ -e "$MAIN/$d" ] || continue
      mkdir -p "$(dirname "$dir/$d")"
      rm -rf "$dir/$d"
      cp -Rc "$MAIN/$d" "$dir/$d" 2>/dev/null || cp -R "$MAIN/$d" "$dir/$d"
    done

    echo "$dir"
    ;;
  drop)
    name="${2:?缺少 worktree 名字}"
    git -C "$MAIN" worktree remove --force "$WT_ROOT/$name" 2>/dev/null || rm -rf "$WT_ROOT/$name"
    git -C "$MAIN" worktree prune
    git -C "$MAIN" branch -D "task/$name" 2>/dev/null || true
    echo "已删除 $name"
    ;;
  list)
    git -C "$MAIN" worktree list
    ;;
  *)
    echo "用法: wt.sh add|drop|list <name>" >&2
    exit 1
    ;;
esac
