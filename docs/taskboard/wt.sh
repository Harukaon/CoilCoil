#!/usr/bin/env bash
# 多 agent 并行开发的 worktree 脚手架。
#
#   wt.sh add <name>     从 main 开一个 worktree 到 ../SuoCode-wt/<name>，分支 task/<name>
#   wt.sh drop <name>    删掉 worktree 和分支
#
# 关键点：worktree 是干净检出，没有 node_modules，tsc 跑不起来。
# 这里把主仓库的 node_modules 软链过去，agent 就能直接 `npm run check`。
set -euo pipefail

MAIN="/Users/hao/Desktop/project/SuoCode"
ROOT="/Users/hao/Desktop/project/SuoCode-wt"
NM_DIRS=(node_modules packages/workflow/node_modules packages/runtime-core/node_modules apps/desktop/node_modules vendor/pi/node_modules)

cmd="${1:?用法: wt.sh add|drop <name>}"
name="${2:?缺少 worktree 名字}"
dir="$ROOT/$name"
branch="task/$name"

case "$cmd" in
  add)
    mkdir -p "$ROOT"
    git -C "$MAIN" worktree add -B "$branch" "$dir" main >/dev/null
    for d in "${NM_DIRS[@]}"; do
      [ -e "$MAIN/$d" ] || continue
      mkdir -p "$(dirname "$dir/$d")"
      ln -sfn "$MAIN/$d" "$dir/$d"
    done
    echo "$dir"
    ;;
  drop)
    git -C "$MAIN" worktree remove --force "$dir" 2>/dev/null || true
    git -C "$MAIN" branch -D "$branch" 2>/dev/null || true
    echo "已删除 $name"
    ;;
  *)
    echo "未知命令: $cmd" >&2
    exit 1
    ;;
esac
