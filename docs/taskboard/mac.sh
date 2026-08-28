#!/usr/bin/env bash
# 在 macOS 主机上、指定 worktree 里跑一条命令。
#
#   bash docs/taskboard/mac.sh <worktree名|main> '<command>'
#
# 为什么需要它：仓库在 Orb Ubuntu 里是 sshfs 挂载的，改文件可以直接在 VM 里改，
# 但 node_modules 是 darwin-arm64 的（esbuild / electron / node-pty 全是原生件），
# 构建、tsc、测试只能在 Mac 上跑；worktree 的 gitdir 又是 macOS 绝对路径，
# 所以 git 命令也必须在 Mac 上跑。
set -euo pipefail

MAC_REPO="/Users/hao/Desktop/project/SuoCode"
NODE_BIN="/Users/hao/.nvm/versions/node/v24.14.1/bin"

wt="${1:?用法: mac.sh <worktree名|main> '<command>'}"
shift
cmd="${*:?缺少要执行的命令}"

if [ "$wt" = "main" ]; then dir="$MAC_REPO"; else dir="$MAC_REPO/.worktrees/$wt"; fi

exec ssh mac "export PATH=$NODE_BIN:\$PATH; cd '$dir' && $cmd"
