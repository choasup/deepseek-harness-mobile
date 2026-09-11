#!/usr/bin/env bash
# 构建并装到已连接的 iPhone 上。
#
# 前置条件（只需一次，而且必须你自己来）：Xcode → Settings → Accounts
# 登录 Apple ID。自动签名要靠这个账号去创建 App ID 和描述文件；只有钥匙串里
# 那张开发证书是不够的，会报：
#   No Account for Team "…". Add a new account in Accounts settings
#
# 注意 project.yml 里的 DEVELOPMENT_TEAM 要填**登录账号的 team**，不是钥匙串
# 里证书的 team——这台机器上两者不同。同样报 `No Account for Team`，
# 看着像没登录，实际是登录的账号没有那个 team。查法：
#   plutil -p ~/Library/Preferences/com.apple.dt.Xcode.plist | grep teamID
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd .. && pwd)"

DEVICE_ID="${1:-}"
if [[ -z "$DEVICE_ID" ]]; then
  # 按 UUID 形状抓，不要按列号——`devicectl list devices` 的 Model 列
  # 含空格（"iPhone 17 Pro Max (iPhone18,2)"），数列会抓到 "17"。
  DEVICE_ID=$(xcrun devicectl list devices 2>/dev/null \
    | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' \
    | head -1)
fi
if [[ -z "$DEVICE_ID" ]]; then
  echo "没找到已连接的设备。插上 iPhone 并在手机上点「信任此电脑」。" >&2
  exit 1
fi
echo "目标设备: $DEVICE_ID"

# ── Node 侧必须先重建，再铺进 nodejs-project ──────────────────────────
#
# **这一步以前不在脚本里，代价是今天又吃了一次。** nodejs-project/ 只是
# project.yml 里的一个资源文件夹，Xcode 只负责把它整个拷进 app bundle；
# 它自己不会重新生成。于是改完插件直接 deploy，装上去的是上一次留下的旧
# JS——而日志、自检、界面全都正常，唯独改动不生效。今天为此把"SSH 挂起"
# 排查了半天，最后发现设备上跑的根本不是新代码。
#
# 顺序不能颠倒：prepare 从各包的 lib/ 拷贝，而 lib/ 是 build 的产物。
# 只 prepare 不 build，拷过去的还是旧产物。
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
if [[ "$NODE_MAJOR" -lt 22 || ( "$NODE_MAJOR" -eq 22 && "$NODE_MINOR" -lt 19 ) ]]; then
  # tsdown 要 Promise.withResolvers（Node 22.11+）。版本不够时它报的是
  # "Promise.withResolvers is not a function"，跟版本毫无字面关系。
  echo "Node 版本不够（当前 $(node -v 2>/dev/null || echo 无)），需要 ^22.19 || >=24：" >&2
  echo "  export PATH=\"\$HOME/.nvm/versions/node/v22.19.0/bin:\$PATH\"" >&2
  exit 1
fi

echo "== 重建 Node 侧的包 =="
(cd "$REPO_ROOT" && pnpm -r run build)
echo "== 铺 nodejs-project =="
./prepare-nodejs-project.sh

xcodegen generate
xcodebuild -project DshMobile.xcodeproj -scheme DshMobile \
  -sdk iphoneos -configuration Debug \
  -derivedDataPath build-device \
  -destination "generic/platform=iOS" \
  -allowProvisioningUpdates build

APP=build-device/Build/Products/Debug-iphoneos/DshMobile.app

# 装之前先把在跑的实例结束掉。
#
# 装包本身会替换 bundle 目录，而**紧接着 launch 会和这个替换抢**：实测出现过
# 一次 dsh 正常起来（日志里 `dsh web:` 和全部自检都绿）、外壳却报"无法连接
# 服务器"，进程随后消失。干净地 kill 一次再装，这种状态就不会出现。
PID=$(xcrun devicectl device info processes --device "$DEVICE_ID" 2>/dev/null \
  | grep -i 'DshMobile.app/DshMobile' | head -1 | awk '{print $1}')
if [[ -n "$PID" ]]; then
  echo "先结束正在跑的实例 (pid $PID)"
  xcrun devicectl device process signal --device "$DEVICE_ID" --pid "$PID" --signal SIGKILL >/dev/null 2>&1 || true
  sleep 2
fi

xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
# 装完稍等一下再拉起：容器刚被替换，立刻启动容易撞上。
sleep 3
xcrun devicectl device process launch --device "$DEVICE_ID" com.dshmobile.shell

cat <<'EOF'

装好了。第一次运行手机上可能要先信任开发者证书：
  设置 → 通用 → VPN与设备管理 → 开发者App → 信任

runtime 在手机里：app 会自己起 Node，加载 dsh 的插件树，再连自己的
127.0.0.1:47799。**不需要 Mac 上开 host，也不需要填任何地址。**
首次启动要几十秒（插件树装载），界面上会显示"正在启动 dsh"。

起不来的话，日志在设备的 Documents 里，这样取：
  xcrun devicectl device copy from --device <UDID> \
    --domain-type appDataContainer --domain-identifier com.dshmobile.shell \
    --source Documents/dsh-host.log --destination ./dsh-host.log
EOF
