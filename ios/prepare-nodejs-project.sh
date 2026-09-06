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
# ② **不能有原生模块**（.node 文件）：iOS 不允许 dlopen 未签名的二进制，
#    而 app 内的 .node 也不在签名链里。装完会检查一遍，发现就报错——
#    留到运行时才发现的话，报错会是一句无关的 import 失败。
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

echo "== 检查有没有原生模块 =="
NATIVE=$(find . -name "*.node" -not -path "*/test/*" 2>/dev/null || true)
if [ -n "$NATIVE" ]; then
  echo "发现 .node 原生模块，iOS 上加载不了：" >&2
  echo "$NATIVE" >&2
  exit 1
fi
echo "干净：没有 .node"
du -sh . | cut -f1 | xargs echo "nodejs-project 体积:"
