#!/usr/bin/env bash
# 编 Node 22.19 的 iOS arm64 静态库。带磁盘看门狗；不 make clean（可反复续跑）。
#
# 与 Node 18 那轮的区别见 docs/ios-build-notes.md：
#   - 补丁是移植到 22.19 的，不是 nodejs-mobile 的原样（bitcode、no_pie 已去掉）
#   - 关掉了调试符号（18 那轮 out/ 涨到 20 GB，这台机器放不下）
set -uo pipefail
cd "$(dirname "$0")/node-22"

# configure 也放进来，因为它的参数是构建结果的一部分，散在外面会失传。
# 改了 gyp 生成器或 common.gypi 之后**必须**重跑，否则改动不进 makefile。
configure_ios() {
  GYP_DEFINES="target_arch=arm64 host_os=mac target_os=ios" ./configure \
    --dest-os=ios --dest-cpu=arm64 --cross-compiling --enable-static \
    --openssl-no-asm --v8-options=--jitless \
    --without-node-code-cache --without-node-snapshot \
    --with-intl=small-icu
}
# --with-intl=small-icu **不能**换成 none。none 会关掉 V8_INTL_SUPPORT，
# 而 Unicode 属性转义（\p{XID_Start}、\p{L}、\p{N} 这些）依赖它。
# 实测代价：第一次用 none 编出来装到手机上，83 个 dsh 包里 25 个 import 失败，
# 全报 "Invalid regular expression: ... Invalid property name in character class"。
# 那 25 个包括 agent-loop、tool-fs、subagent、llm-deepseek——都是核心。
# small-icu 只带英文 locale 数据，但 Unicode 属性表是全的，正是我们要的。
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
