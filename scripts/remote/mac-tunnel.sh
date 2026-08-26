#!/usr/bin/env bash
# Keep CoilCoil's remote entry point reachable through your own VPS.
#
# The Mac dials out, so nothing has to be opened on your home router and the
# port on the VPS is bound to its loopback only: the reverse proxy in front of
# it is the sole way in.
#
#   COILCOIL_REMOTE_VPS=vps COILCOIL_REMOTE_PORT=7788 scripts/remote/mac-tunnel.sh
#
# Pass `install` to register it as a LaunchAgent that starts at login and
# restarts itself if the link drops.
set -euo pipefail

VPS="${COILCOIL_REMOTE_VPS:-vps}"
PORT="${COILCOIL_REMOTE_PORT:-7788}"
LABEL="app.coilcoil.remote-tunnel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# launchd cannot read a script that lives under Desktop, Documents or Downloads:
# macOS privacy protection denies it before the job ever starts. Install keeps
# its own copy somewhere launchd is always allowed to look.
INSTALLED="$HOME/Library/Application Support/CoilCoil/coilcoil-tunnel.sh"

run_tunnel() {
  echo "[coilcoil-tunnel] $VPS:127.0.0.1:$PORT -> 本机 127.0.0.1:$PORT"
  while true; do
    # ExitOnForwardFailure turns a port already in use into an exit instead of a
    # tunnel that connects but forwards nothing.
    ssh -N -T \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -o StrictHostKeyChecking=accept-new \
      -R "127.0.0.1:$PORT:127.0.0.1:$PORT" \
      "$VPS" || true
    echo "[coilcoil-tunnel] 断开，5 秒后重连"
    sleep 5
  done
}

install_agent() {
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$INSTALLED")"
  cp "$0" "$INSTALLED"
  chmod +x "$INSTALLED"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALLED</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COILCOIL_REMOTE_VPS</key><string>$VPS</string>
    <key>COILCOIL_REMOTE_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/coilcoil-tunnel.log</string>
  <key>StandardErrorPath</key><string>/tmp/coilcoil-tunnel.log</string>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "[coilcoil-tunnel] 已注册开机自启：$PLIST"
  echo "[coilcoil-tunnel] 日志：/tmp/coilcoil-tunnel.log"
}

case "${1:-run}" in
  run) run_tunnel ;;
  install) install_agent ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST" "$INSTALLED"
    echo "[coilcoil-tunnel] 已移除"
    ;;
  *) echo "用法：$0 [run|install|uninstall]" >&2; exit 2 ;;
esac
