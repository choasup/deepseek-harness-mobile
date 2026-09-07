#!/usr/bin/env bash
# 把 dsh 及其依赖装进 ios/nodejs-project/，供 Xcode 作为 bundle 资源打包。
#
# 这一份是**设备上要跑的那套 Node 代码**。它跟 Mac 上 ~/.dsh/profiles 的关系是：
# 结构相同（profile 目录 + node_modules），但整个搬进 app bundle。
#
# 两条 iOS 特有的约束：
#
# ① **bundle 是只读的**，所以这里只放代码。会话、存储、凭据由 NodeHost.swift
#    把 DSH_HOME 指到 Application Support 去写。
#
# ② **原生模块（.node）在 iOS 上一律加载不了**：不允许 dlopen 不在签名链里的
#    二进制。npm 会按**主机**平台装一堆 darwin-arm64 / linux / win32 的预编译
#    产物，在 app 里全是死重（实测 node-pty 26MB + sharp 18MB + koffi 2MB）。
#    所以装完把 .node 与 prebuilds/ 剥掉，**保留 JS**。
#
#    保留 JS 而不是删整个包，是因为失败模式不同：删包会变成"模块找不到"，
#    可能打断本来能走兜底的代码路径；只删二进制则等同于 iOS 上的真实情况
#    ——dlopen 失败，由调用方的 try/catch 接住。
#
#    实测这些原生依赖都不是硬依赖：
#      node-pty      ← dsh-subprocess-local，该插件在 mobile profile 里已禁用
#      node-addon-require-builtin ← cordis-plugin-loader，但用的是
#                      `try { require(...) } catch {}`，失败即走它自己文档里
#                      写的 no-internals 路径
#    真正的判据是检查点 4.2 的逐包 import 探测，不是文件是否存在。
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
DEST="nodejs-project"

rm -rf "$DEST" && mkdir -p "$DEST"
cd "$DEST"

cat > package.json <<JSON
{
  "name": "dsh-mobile-nodejs-project",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "0.1.1-rc.2"
  }
}
JSON

# profile 与 Mac 上的 mobile-web 同构：dsh-base + dsh-web-app + 我们的 bundle。
mkdir -p profiles/mobile-web
cat > profiles/mobile-web/package.json <<JSON
{
  "name": "dsh-profile-mobile-web",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-mobile/mobile-app"
      ]
    }
  }
}
JSON
printf '[]\n' > profiles/mobile-web/cordis.patch.yml

npm install --omit=dev --no-audit --no-fund
for p in mobile-app remote-registry shell-ssh tool-fs-search client-ui-layout-mobile; do
  npm install --no-save "$REPO/packages/$p"
done

echo "== 剥掉原生二进制（iOS 上一律加载不了，纯死重）=="
BEFORE=$(du -sm . | cut -f1)
find . -name "*.node" -type f -delete 2>/dev/null || true
find . -type d -name "prebuilds" -exec rm -rf {} + 2>/dev/null || true
# npm 按主机平台装的可选原生包，整包都用不上
rm -rf node_modules/@img node_modules/@koromix 2>/dev/null || true
AFTER=$(du -sm . | cut -f1)
echo "剥掉 $((BEFORE - AFTER)) MB"

REMAIN=$(find . -name "*.node" -type f 2>/dev/null | head -5)
[ -n "$REMAIN" ] && { echo "仍有 .node 残留：" >&2; echo "$REMAIN" >&2; exit 1; }
echo "干净：没有 .node"
du -sh . | cut -f1 | xargs echo "nodejs-project 体积:"
