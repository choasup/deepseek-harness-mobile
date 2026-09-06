#!/usr/bin/env bash
# 只编真机 arm64 的 NodeMobile.framework，带磁盘看门狗，可续跑。
#
#   ./build-node-ios.sh          全新构建（会 make clean）
#   ./build-node-ios.sh resume   续跑（跳过 make clean，保留已编译的中间产物）
#
# 为什么只编 arm64：nodejs-mobile 默认还会编 arm64/x64 两个模拟器架构，
# 三份 V8 的中间产物这台机器放不下。脚本本身接受架构参数，所以这是它支持的
# 模式，不是改造。
#
# resume 怎么实现的：上游 `build_for_arm64_device()` 第一行就是 `make clean`，
# 而这个构建要跑 40–90 分钟，每修一个头文件冲突就全量重来不现实。所以在 PATH
# 前面放一个 `make` 垫片，把 `clean` 目标变成空操作，其余原样 exec 真的 make。
# 这样上游脚本一个字都不用改——改它的话，以后抬 Node 版本时补丁会更难移植。
#
# 为什么要看门狗：把 macOS 的引导盘写满不是"构建失败"，是系统级故障。
# 低于阈值就杀掉整个进程组，宁可白编一小时。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/nodejs-mobile"

MODE="${1:-fresh}"
MIN_FREE_GB=2
LOG=/tmp/node-ios-build.log

free_gb() { df -g /System/Volumes/Data | tail -1 | awk '{print $4}'; }

export PATH="$HERE/make-shim:$PATH"
if [ "$MODE" = "resume" ]; then
  mkdir -p "$HERE/make-shim"
  cat > "$HERE/make-shim/make" <<'SHIM'
#!/usr/bin/env bash
# 只吞掉 `make clean`，其余原样转发给真的 make。见 build-node-ios.sh 的说明。
for arg in "$@"; do
  if [ "$arg" = "clean" ]; then
    echo "[make-shim] 跳过 make clean（resume 模式）"
    exit 0
  fi
done
exec /usr/bin/make "$@"
SHIM
  chmod +x "$HERE/make-shim/make"
  echo "== resume 模式：make clean 已被垫片跳过 ==" | tee -a "$LOG"
else
  rm -rf "$HERE/make-shim"
  : > "$LOG"
fi

echo "开工可用: $(free_gb) GB" | tee -a "$LOG"
./tools/ios_framework_prepare.sh arm64 >>"$LOG" 2>&1 &
BUILD_PID=$!

while kill -0 "$BUILD_PID" 2>/dev/null; do
  FREE=$(free_gb)
  if [ "$FREE" -lt "$MIN_FREE_GB" ]; then
    echo "!! 可用空间降到 ${FREE}GB，低于 ${MIN_FREE_GB}GB 阈值，中止构建" | tee -a "$LOG"
    kill -TERM -"$(ps -o pgid= "$BUILD_PID" | tr -d ' ')" 2>/dev/null || kill -TERM "$BUILD_PID"
    wait "$BUILD_PID" 2>/dev/null
    exit 90
  fi
  sleep 30
done
wait "$BUILD_PID"
STATUS=$?
echo "构建退出码 $STATUS，剩余 $(free_gb) GB" | tee -a "$LOG"
exit $STATUS
