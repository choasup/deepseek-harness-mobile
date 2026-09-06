#!/usr/bin/env bash
# 编 Node 22.19 的 iOS arm64 静态库。带磁盘看门狗；不 make clean（可反复续跑）。
#
# 与 Node 18 那轮的区别见 docs/ios-build-notes.md：
#   - 补丁是移植到 22.19 的，不是 nodejs-mobile 的原样（bitcode、no_pie 已去掉）
#   - 关掉了调试符号（18 那轮 out/ 涨到 20 GB，这台机器放不下）
set -uo pipefail
cd "$(dirname "$0")/node-22"
MIN_FREE_GB=2
LOG=/tmp/node22-ios-build.log
free_gb() { df -g /System/Volumes/Data | tail -1 | awk '{print $4}'; }
echo "== 开工 $(date +%H:%M) 可用 $(free_gb) GB ==" | tee -a "$LOG"

make -j"$(getconf _NPROCESSORS_ONLN)" >>"$LOG" 2>&1 &
BUILD_PID=$!
while kill -0 "$BUILD_PID" 2>/dev/null; do
  FREE=$(free_gb)
  if [ "$FREE" -lt "$MIN_FREE_GB" ]; then
    echo "!! 可用降到 ${FREE}GB，中止" | tee -a "$LOG"
    kill -TERM -"$(ps -o pgid= "$BUILD_PID" | tr -d ' ')" 2>/dev/null || kill -TERM "$BUILD_PID"
    wait "$BUILD_PID" 2>/dev/null; exit 90
  fi
  sleep 30
done
wait "$BUILD_PID"; STATUS=$?
echo "== 退出码 $STATUS，剩余 $(free_gb) GB，out/ $(du -sh out 2>/dev/null | cut -f1) ==" | tee -a "$LOG"
exit $STATUS
