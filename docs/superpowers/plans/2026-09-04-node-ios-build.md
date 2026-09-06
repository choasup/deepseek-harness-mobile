# Node for iOS 构建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to work through this plan checkpoint-by-checkpoint. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产出一个 `NodeMobile.xcframework`，能在 iPhone 上以 jitless 模式运行 Node 24（退路 22.19），并成功加载 dsh 的插件树完成一轮带工具调用的对话。

**Architecture:** 照 nodejs-mobile 的既有路径把补丁抬到新版本：V8 用上游官方支持的 iOS 交叉编译（`target_os="ios"` + jitless + `v8_monolithic`），Node core 加 `dest-os=ios` 的 gyp 配置，产物合并成静态库并封装为 xcframework。

**Tech Stack:** Node 24 源码 · V8 / GN / ninja · gyp · Xcode 命令行工具 · depot_tools

**Spec:** `docs/superpowers/specs/2026-09-04-dsh-mobile-ios-design.md`（§3.4 §5.1 §7）

---

## 为什么这份计划不是 TDD

前 11 个任务的插件计划是 TDD 的，因为那里每一步的结果都可预测。这份不是：交叉编译一个 30 万行的 C++ 项目到一个官方不支持的平台，失败模式是未知的，且大部分步骤要跑 20–90 分钟。

所以这份计划的结构是**检查点 + 每个检查点的证据 + 卡住时的退路**。每个检查点是一个可独立验证的事实，不是一次代码提交。

**这是全项目唯一的真风险点。** 插件那份计划完全不依赖它，可以并行推进——所以这里卡住不等于全线停摆。

---

## 前置事实（动手前必读）

**1. 没有现成方案。** [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) 社区 fork 仍在维护（2026-04 有更新），但停在 **Node 18.20.4**。

**2. Node 18 不可用，无法降级绕过。**

> **2026-09-07 订正**：这一节原来的依据是错的。真正的下限不是 `node:sqlite`。
> 用 Node 20.20.2 实跑 mobile profile，拿到的是三个**静态 import / 直接调用**
> 的硬失败：
>
> | 症状 | 所在包 | 最低 Node |
> |---|---|---|
> | `node:zlib` 不导出 `createZstdDecompress` | `dsh-session-persistence-jsonl` | **22.15** |
> | `Promise.withResolvers is not a function` | `dsh-agent-loop` | 22.0 |
> | `node:module` 不导出 `stripTypeScriptTypes` | `dsh-code-runtime-worker-thread` | 22.13 |
>
> 而原来列的三项**都不是**阻塞项：
> - `node:sqlite` —— 只有 `dsh-session-query-sqlite` 用，且是函数体里的
>   `await import("node:sqlite")`（惰性）。`dsh-base` 出厂就配
>   `openAt: never`，其源码注释原话："a disabled deployment never imports"。
>   所以它**根本不会被 import**。
> - `loadEnvFile` —— 只有一个调用点，且包在 try/catch 里；Node 18 上它是
>   `undefined`，抛的 TypeError 的 `.code` 不是 ENOENT，只打一行警告然后继续。
> - `AbortSignal.any` —— 19 处，但是个小静态方法，polyfill 约 15 行。
>
> **对本计划的直接影响**：检查点 3「卡住时的退路」里那条"退到 Node 22.5"
> **不可行**——zstd 要 22.15。可退的最低点是 **22.15**，而 dsh 自己的
> `engines` 写的是 `^22.19 || >=24`，所以直接奔 22.19 就是最省事的。

结论不变：目标是 22.19+ 或 24。但理由是 zstd / `Promise.withResolvers` /
`stripTypeScriptTypes`，不是 `node:sqlite`。

**3. jitless 是硬要求，且它关闭 WebAssembly。** 已在 Mac 上实测确认：

```
node --jitless -e 'console.log(typeof WebAssembly)'   # → undefined
```

这不是 bug，是 V8 在 jitless 下的既定行为。任何依赖 WASM 的传递依赖都会在设备上失败。

**4. jitless 的性能代价已实测，可以接受**（Mac，Node 22.23.2）：dsh 完整插件树启动 0.50s → 0.67s（1.3x）；JSON 负载 1.0x；正则 2.8x；数值热循环 4.3x。agent harness 的负载画像是前两项。

**5. 官方参考文档**：[V8 Cross-compile for iOS](https://v8.dev/docs/cross-compile-ios)。

---

## 检查点 1：复现 nodejs-mobile 的已知good状态

**先证明工具链本身是通的，再去动版本。** 直接上 Node 24 会让"编译失败"有两种可能原因（工具链问题 / 版本问题），无法区分。

- [ ] **1.1 装齐工具链**

```bash
xcode-select --install
xcodebuild -version          # 需要 Xcode 与 iOS SDK
```

Run: `xcrun --sdk iphoneos --show-sdk-path`
Expected: 打印出一个存在的 SDK 路径。若报错，说明 Xcode 装的是 Command Line Tools 而非完整 Xcode——补装完整 Xcode。

- [ ] **1.2 克隆并编译 nodejs-mobile 的既有版本**

```bash
cd /Users/choas/Solution/dsh-mobile
git clone --depth 1 https://github.com/nodejs-mobile/nodejs-mobile.git vendor/nodejs-mobile
cd vendor/nodejs-mobile
./tools/ios_framework_prepare.sh
```

预计 40–90 分钟。

- [ ] **1.3 验证产物**

Run: `ls -la out_ios/Release-iphoneos/NodeMobile.framework/NodeMobile`
Expected: 存在，且 `file` 显示为 arm64 的 Mach-O

Run: `lipo -info out_ios/Release-iphoneos/NodeMobile.framework/NodeMobile`
Expected: 含 `arm64`

**卡住时**：如果这一步就失败，问题在工具链或 nodejs-mobile 与当前 Xcode 版本的兼容性，不在 Node 版本。先查它的 issues。这一步过不去，不要往下走。

---

## 检查点 2：真机上跑起 Node 18

- [ ] **2.1 用官方示例建 Xcode 工程**

```bash
git clone --depth 1 https://github.com/nodejs-mobile/nodejs-mobile-samples.git vendor/nodejs-mobile-samples
```

按 `ios/native-xcode` 的说明，把检查点 1 产出的 `NodeMobile.framework` 拖进 Embedded Binaries。

- [ ] **2.2 在设备上运行**

把示例 app 装到 iPhone 上（自签即可，不需要上架）。

Expected: app 内显示 Node 版本字符串，形如 `v18.20.4`

**这一步证明了三件事**：iOS 上 Node 能跑、jitless V8 能启动、自签安装路径通畅。**在这三件事被证明前，不要投入时间去抬版本。**

**卡住时**：签名问题查 Xcode 的 Signing & Capabilities；启动即崩查设备日志（Console.app 筛选设备），常见原因是 framework 没被正确嵌入。

---

## 检查点 3：抬到 Node 22.19

先抬到 22.19 而不是 24——它是满足 dsh 全部要求（`node:sqlite` 需 22.5）的**最小**版本，因此与 18 的差距最小，补丁最容易移植。

- [ ] **3.1 摸清 nodejs-mobile 改了什么**

```bash
cd vendor/nodejs-mobile
git log --oneline v18.20.4...HEAD -- . | head -50
git diff --stat $(git merge-base HEAD upstream/main) HEAD 2>/dev/null || \
  echo "需先 git remote add upstream https://github.com/nodejs/node.git && git fetch upstream"
```

把改动清单写进 `docs/ios-build-notes.md`，按类别归档：

| 类别 | 典型文件 | 说明 |
|---|---|---|
| gyp 平台配置 | `common.gypi`、`node.gyp` | 加 `dest-os=ios` 分支 |
| configure | `configure.py` | 认识 iOS 目标 |
| V8 构建 | `tools/v8_gypfiles/` | jitless + iOS 目标 |
| 打包脚本 | `tools/ios_framework_prepare.sh` | 合并静态库、生成 framework |
| 运行时裁剪 | `src/node.cc` 等 | 去掉 iOS 上不可用的启动路径 |

**这份清单是本检查点最重要的产出**，后面每一步都靠它。

- [ ] **3.2 在 Node 22.19 上重放补丁**

```bash
cd /Users/choas/Solution/dsh-mobile/vendor
git clone --branch v22.19.0 --depth 1 https://github.com/nodejs/node.git node-ios
```

逐类移植 3.1 的改动。**按 3.1 的类别顺序做，先 configure 与 gyp，再 V8，最后打包脚本**——前者失败会让后者的错误信息毫无意义。

- [ ] **3.3 编译**

Run: `./configure --dest-os=ios --dest-cpu=arm64 --without-intl --with-intl=none --openssl-no-asm` 后 `make -j$(sysctl -n hw.ncpu)`

Expected: 产出静态库。预计多轮失败——每次失败把错误与解法追加进 `docs/ios-build-notes.md`。

- [ ] **3.4 验证版本与关键模块**

在检查点 2 的示例 app 里换上新 framework，运行：

```js
console.log(process.version)                    // 期望 v22.19.0
console.log(typeof require('node:sqlite'))      // 期望 'object'
console.log(typeof AbortSignal.any)             // 期望 'function'
console.log(typeof process.loadEnvFile)         // 期望 'function'
console.log(typeof WebAssembly)                 // 期望 'undefined'（jitless 的预期行为）
```

Expected: 前四行如注释所示。**这四个 API 正是 §前置事实-2 里 dsh 实际用到的**——它们通过，才说明这个构建对 dsh 可用。

**卡住时的退路，按代价排序**：
1. `node:sqlite` 编不过 → 先确认它是不是惰性 import。dsh-base 的 `session-query-sqlite` 配了 `openAt: never`，若 import 是惰性的，可暂时接受这个模块不可用，在 mobile profile 里禁掉该行
2. V8 补丁移植不动 → 退到 Node 22.5（`node:sqlite` 的首个版本），与 18 差距更小
3. 整体移植不动 → 去 nodejs-mobile 仓库开 issue，同时评估把 dsh 的 `node:sqlite` 用量替换为纯 JS 实现的成本（这会变成上游 PR，不再是本地构建问题）

---

## 检查点 4：dsh 的插件树能在设备上加载

**这是里程碑 2，也是最可能暴露意外的一步。** 前面验证的是 Node 本身，这一步验证 dsh 的几十个包在 iOS 上都能 import。

- [ ] **4.1 把 dsh 打包进 app**

Node 侧代码要随 app bundle 分发。把 dsh 及其依赖装进一个目录，整个拖进 Xcode 的 Copy Bundle Resources。

```bash
mkdir -p ios-app/nodejs-project && cd ios-app/nodejs-project
npm init -y
npm install @deepseek-ai/dsh@0.1.1-rc.2
```

- [ ] **4.2 逐层 import 探测**

不要一上来就启动整个 dsh——那样一个失败会淹没在几十个包里。写一个探测脚本，逐包 import 并记录结果：

```js
// probe-imports.mjs：逐个 import dsh 的包，把失败的挑出来
const packages = [
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-code-runtime-worker-thread', '@deepseek-ai/dsh-mcp-client',
]
const failed = []
for (const name of packages) {
  try { await import(name) }
  catch (err) { failed.push({ name, message: err.message }) }
}
console.log(JSON.stringify({ ok: packages.length - failed.length, failed }, null, 2))
```

Expected: `failed` 为空数组。任何失败项记进 `docs/ios-build-notes.md`，它决定 mobile profile 还要多禁哪些行。

- [ ] **4.3 验证 worker_threads**

spec §10 把这个列为未决问题。现在验证：

```js
import { Worker } from 'node:worker_threads'
const worker = new Worker('import{parentPort}from"node:worker_threads";parentPort.postMessage("alive")', { eval: true })
worker.on('message', (m) => console.log('worker:', m))
```

Expected: 打印 `worker: alive`

**若不可用**：`code-runtime-worker-thread` 与 `workflow-worker-thread` 要降级为主线程执行。在 mobile profile 里换实现，并接受它会阻塞——把这个结论回写进 spec §10。

---

## 检查点 5：一轮带工具调用的对话（里程碑 3+4）

- [ ] **5.1 装上 mobile profile**

用插件计划（`2026-09-04-dsh-mobile-plugins.md`）产出的三个包。此时它们应该已在 Mac 上全部测过。

- [ ] **5.2 headless 跑一轮**

在设备上以 mobile profile 启动 dsh headless，给一个必然触发文件工具的任务：

```
把当前目录下所有 .md 文件的标题列出来，写进 titles.txt
```

Expected: 设备上出现 `titles.txt`，内容正确。

**这证明了**：agent 循环、LLM 调用、工具分发、文件读写、会话持久化在 iOS 上全部工作。

- [ ] **5.3 确认被禁用的工具没有出现**

检查这一轮的工具列表，`bash` 不应在其中。若模型试图调用 bash，说明 mobile profile 的禁用清单没生效——回到插件计划的 Task 11。

---

## 检查点 6：远程执行打通（里程碑 5）

**这一步完成，整个方案成立。**

- [ ] **6.1 配置远程机器**

在设备上导入一条 `dsh-remote://` 配置（用户已有的 GPU 机器；具体地址与密钥不入库，从 `.credentials.yaml` 或剪贴板导入）。

- [ ] **6.2 跑通探针**

Expected: 四个阶段全绿，且 GPU 阶段报出实际型号。

- [ ] **6.3 一轮远程对话**

给一个必须在远程执行的任务：

```
看看 GPU 机器上现在几张卡是空闲的
```

Expected: 模型调用 bash 工具 → `dsh-shell-ssh` 转到远程 → `nvidia-smi` 的输出回到对话里 → 模型给出答案。

**这一步通过，"手机是大脑、云端是手"从构想变成既成事实。**

- [ ] **6.4 回写结论**

把实测数据补进 spec：设备上的启动耗时、一轮对话的端到端延迟、检查点 4.2/4.3 发现的不可用模块。**spec §10 的两个未决问题应在此时被结论替换。**

---

## 完成标准

- 检查点 1–6 全部通过
- `docs/ios-build-notes.md` 记录了完整的补丁移植过程与每个失败的解法——**这份笔记的价值不低于 framework 本身**，因为下次抬 Node 版本还要用
- spec §10 的未决问题已被实测结论替换

## 本计划**不**包含

- `dsh-shell-ssh` / `dsh-remote-registry` / `mobile-app`（见 `2026-09-04-dsh-mobile-plugins.md`）
- 移动版 UI 与原生桥（周期二）
- 后台执行、通知、Shortcuts
