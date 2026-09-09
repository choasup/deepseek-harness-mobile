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

# 本地包必须**一次装齐**。`npm install --no-save <path>` 逐个装是错的：
# 每次安装都会把不在 package.json 里的包剪掉，结果只剩最后一个。
# 实测踩过——bundle 里只剩 client-ui-layout-mobile，另外四个全没了。
#
# 这个列表要与 packages/mobile-app/cordis.patch.yml 里 insert 的包**逐一对上**。
# 漏一个的表现不是"少个功能"：补丁里的 loader 条目解析不到包，
# `assertEntriesActivated` 把 PENDING 当 FAILED，整棵插件树起不来。
# tool-camera 就漏过一次——它是手动补装进 bundle 的，而 prepare 每次都清空目录，
# 于是"能用"只是因为那之后没人重跑过这个脚本。
npm install --omit=dev --no-audit --no-fund \
  "$REPO/packages/mobile-app" \
  "$REPO/packages/remote-registry" \
  "$REPO/packages/shell-ssh" \
  "$REPO/packages/tool-fs-search" \
  "$REPO/packages/tool-camera" \
  "$REPO/packages/tool-sensors" \
  "$REPO/packages/client-ui-layout-mobile"

# npm 对本地 file: 依赖建的是**符号链接**，指向仓库里的源码目录——即逃出了
# app bundle。iOS 的安装器会直接拒绝：
#     invalid symlink at .../DshMobile.app/nodejs-project/node_modules/@dsh-mobile/mobile-app
#     MIFileManager validateSymlinksInURLDoNotEscapeURL / InvalidSymlink
# 换成实体拷贝。只拷 lib/ 与包元数据，src/tests/node_modules 在 bundle 里用不上。
# 五个本地包的运行时依赖 npm 不会自动带进来（它们是 file: 依赖，解成符号链接
# 之后依赖树里就没有来源了）。实测缺 ssh2 与 tweetnacl，表现是设备上
# "Cannot find package 'ssh2'"——显式装。
npm install --no-audit --no-fund ssh2@^1.17.0 tweetnacl@^1.0.3

# 设备内入口：先装 fetch shim 再进 dsh。iOS 的 jitless V8 没有 WebAssembly，
# 而 Node 内置的 undici 用 WASM 版 llhttp——不换掉，dsh 在加载期就死。
cp "$REPO/tools/fetch-over-node-http.mjs" .
# 启动自检：跑一遍附件服务的真实归一化链路，见 tools/bridge-selftest.mjs。
cp "$REPO/tools/bridge-selftest.mjs" .
cp "$REPO/ios/nodejs-project-bootstrap.mjs" ./bootstrap.mjs 2>/dev/null || true

echo "== 把逃出 bundle 的符号链接换成实体拷贝 =="
for p in mobile-app remote-registry shell-ssh tool-fs-search tool-camera tool-sensors client-ui-layout-mobile; do
  L="node_modules/@dsh-mobile/$p"
  [ -L "$L" ] || continue
  rm "$L" && mkdir -p "$L"
  cp -R "$REPO/packages/$p/lib" "$L/" 2>/dev/null || true
  cp "$REPO/packages/$p/package.json" "$L/"
  [ -f "$REPO/packages/$p/cordis.patch.yml" ] && cp "$REPO/packages/$p/cordis.patch.yml" "$L/"
done
ESCAPING=$(find . -type l -exec sh -c 'T=$(readlink "$1"); case "$T" in /*|*../../../*) echo "$1";; esac' _ {} \; 2>/dev/null)
[ -n "$ESCAPING" ] && { echo "仍有逃出 bundle 的符号链接：" >&2; echo "$ESCAPING" >&2; exit 1; }

# sharp 换成原生桥。**这一步不是优化，是必需的**：真的 sharp 是 libvips 的
# 原生绑定，iOS 上 dlopen 不了；把 @img 剥掉之后它连 require 都过不去，而
# 附件服务在**每一次存图**时都要用它。桥把这些调用转发给 ImageIO/CoreGraphics。
# 见 tools/sharp-bridge/index.cjs。
#
# 这一步也漏过一次：桥当初是手动装进 bundle 的，而 prepare 每次都清空目录，
# 于是"能用"只是因为那之后没人重跑过这个脚本。
rm -rf node_modules/sharp
mkdir -p node_modules/sharp
cp "$REPO/tools/sharp-bridge/index.cjs" "$REPO/tools/sharp-bridge/package.json" node_modules/sharp/
node -e "require('./node_modules/sharp/package.json')" >/dev/null

# 附件落盘时 dsh 会从 DSH_HOME 一路往上 fsync 每一级祖先目录，边界是 `/`。
# iOS 沙盒在容器上面一层就拦下来（EPERM），表现是"拍照失败"而只字不提文件系统。
# 见 tools/patch-ios-attachment-durability.mjs。锚点对不上会直接失败，不静默跳过。
node "$REPO/tools/patch-ios-attachment-durability.mjs" \
  node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js

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
