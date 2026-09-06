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

xcodegen generate
xcodebuild -project DshMobile.xcodeproj -scheme DshMobile \
  -sdk iphoneos -configuration Debug \
  -derivedDataPath build-device \
  -destination "generic/platform=iOS" \
  -allowProvisioningUpdates build

APP=build-device/Build/Products/Debug-iphoneos/DshMobile.app
xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
xcrun devicectl device process launch --device "$DEVICE_ID" com.dshmobile.shell

cat <<'EOF'

装好了。第一次运行手机上可能要先信任开发者证书：
  设置 → 通用 → VPN与设备管理 → 开发者App → 信任

app 起来后会连不上（默认地址 127.0.0.1 在手机上指的是手机自己），
会自动弹出连接设置，填 Mac 的局域网地址。
Mac 那边要先把 host 起在局域网上——见仓库 README「装到真机上」一节。
EOF
