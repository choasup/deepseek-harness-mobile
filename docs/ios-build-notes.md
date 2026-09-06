# Node for iOS 构建笔记

> 这份笔记记录**每一次失败与它的解法**。下次抬 Node 版本时要用的是它，
> 不是产物——产物会过期，踩过的坑不会。
>
> 计划见 [`superpowers/plans/2026-09-04-node-ios-build.md`](superpowers/plans/2026-09-04-node-ios-build.md)。

## 环境（2026-09-07）

| | |
|---|---|
| Xcode | 26.4.1 (17E202) |
| iOS SDK | iPhoneOS26.4.sdk |
| clang | Xcode 自带 21 |
| 主机 | Apple Silicon，8 核 |
| nodejs-mobile | `d9552e0e01ed`（Node 18，`v8_embedder_string` = `-node.37`）|

`vendor/nodejs-mobile` 是 700 MB 的第三方源码，**不入库**（见 `.gitignore`）。
要复现就按上表的 commit 重新 clone，再打 `patches/` 下的补丁。

---

## 检查点 1：复现 nodejs-mobile 的已知good状态

### 1.0 磁盘是先决条件，不是细节

开工时可用空间 **11 GB / 460 GB（98% 满）**。

- 装了**两份** iOS 26.4 模拟器运行时（26.4 与 26.4.1），11 台模拟器设备全挂在
  同一个 `iOS-26-4` 标识下，其中一份纯冗余。设备的 `runtimePolicy` 是 `System`
  （取最新），所以删旧的那份是安全的：`xcrun simctl runtime delete 23E244`。
- **`du` 对它们的读数会重复计算**：两份各显示 16 GB，删掉一份实际只回收约 3 GB
  （镜像是稀疏的、共享存储）。别按 `du` 的数字做容量规划。
- 剩下的大头是用户数据（企业微信 54 GB、微信 47 GB 的聊天缓存），
  只能从各自 app 的存储管理里清，不该由构建流程去动。

**结论：只编真机架构。** `tools/ios_framework_prepare.sh` 本身接受架构参数
（`arm64` / `arm64-simulator` / `x64-simulator` / `combine_frameworks`），
不带参数才编全部三个。所以"只编 arm64"是它支持的模式，不是改造。
代价是产出 framework 而非 xcframework，模拟器上跑不了——但设备内 runtime
本来就只在真机上有意义。

### 1.1 工具链

`xcrun --sdk iphoneos --show-sdk-path` 正常。**`ninja` / `gn` 没装也不需要**——
nodejs-mobile 走的是 gyp + make 那条老路，不是 V8 官方文档里的 GN 路径。
计划里引的那篇 v8.dev 交叉编译文档对这条路线不适用。

### 1.2 构建包装：[`vendor/build-node-ios.sh`](../vendor/build-node-ios.sh)

两件事上游脚本没有，但这个构建离不开：

**磁盘看门狗。** 低于 2 GB 就杀掉整个进程组。把 macOS 引导盘写满不是
"构建失败"，是系统级故障，宁可白编一小时。

**可续跑（`resume`）。** 上游 `build_for_arm64_device()` 第一行就是 `make clean`，
而这个构建要跑 40–90 分钟；每修一个头文件冲突就全量重来不现实。做法是在 PATH
前面放一个 `make` 垫片，把 `clean` 目标变成空操作，其余原样 `exec` 真的 make。
**刻意不改上游脚本**——改了的话，以后抬 Node 版本时补丁移植会更难。

### 1.3 失败 #1：zlib 的经典 Mac OS 分支在今天全量命中

```
_stdio.h:322:7: error: expected identifier or '('
  FILE *fdopen(int, const char *) __DARWIN_ALIAS_STARTING(...);
note: expanded from macro 'fdopen'
  #define fdopen(fd,mode) NULL /* No fdopen() */
```

`deps/v8/third_party/zlib/zutil.h:144` 的守卫是：

```c
#if defined(MACOS) || defined(TARGET_OS_MAC)
```

这个分支是给**经典 Mac OS（OS X 之前）**的——那上面没有 `fdopen`，所以它
`#define fdopen(fd,mode) NULL`。但现代 macOS SDK 的 `TargetConditionals.h`
**就是把 `TARGET_OS_MAC` 定义成 1 的**，于是这个 1999 年的分支今天全量命中，
把随后 `<stdio.h>` 里 `fdopen` 的声明打烂。

**旁证**：同一份编译输出里有 `OS_CODE macro redefined` 警告——`__APPLE__` 分支
（`OS_CODE 19`）与这个分支（`OS_CODE 7`）同时命中，本来就不该同时成立。
这条警告出现在错误之前，是比错误本身更早的信号。

**解法**（[`patches/0001-v8-zlib-classic-macos-guard.patch`](../patches/0001-v8-zlib-classic-macos-guard.patch)）：

```c
#if (defined(MACOS) || defined(TARGET_OS_MAC)) && !defined(__APPLE__)
```

现代 Apple 平台跳过整个经典 Mac 分支，`OS_CODE` 由后面的 `__APPLE__` 分支给出
（19），与不打补丁时的最终结果一致。

**移植提示**：Node 22/24 自带的 zlib 与 V8 里 `third_party/zlib` 是两份不同的
副本，抬版本时要分别确认。这条是"新 SDK × 老第三方代码"的典型形态——
同类问题还会有，看到 `macro redefined` 警告就该停下来看。

### 1.4 操作事故：sparse-checkout 打到了外层仓库

在 `vendor/` 目录下跑 `git sparse-checkout init --cone` + `set tools android ios`，
本意是只取 nodejs-mobile 的构建脚本，实际作用到了**外层 dsh-mobile 仓库**，
把工作区裁成只剩 `vendor/tools`——`docs/`、`packages/`、`ios/` 从工作区消失。

**没有丢任何东西**：sparse-checkout 只影响工作区里出现哪些文件，HEAD 完好。
`git sparse-checkout disable` 即可全部恢复。

会误导的地方是 `git status` **一片干净**（不报 deleted），因为 sparse 的文件被
标记为 skip-worktree。看到"文件不见了但 git 说没改动"，先查
`git sparse-checkout list`，别去找删除操作。

教训：对着 clone 出来的子仓库跑 git 命令前，先确认落在哪个仓库
（`git rev-parse --show-toplevel`）。

### 1.5 结论：拿到工具链信号后停止

编到 **25 个静态库**（含 `libnode.a`、`libopenssl.a`、`libuv.a`）时停掉了。
检查点 1 要证明的事——"这套工具链能给 iOS arm64 编出 Node"——到这里已经成立，
而按下一节的实测，Node 18 装上设备也跑不了 dsh，继续编只是烧磁盘。

**`out/` 实测 20 GB**（不是构建早期 `du` 看到的 414 MB）。这是后面所有容量
判断的依据：单架构 Node+V8 构建约 20 GB。删掉它才够接着做 22.19。

---

## 检查点 3 的前置发现：真实的 Node 版本下限（不用等编译）

在等 V8 编译时用 **Node 20.20.2 实跑 mobile profile**，把"到底哪些 API 挡路"
测了出来。结论与计划里写的**不一样**：

| 症状 | 所在包 | 最低 Node |
|---|---|---|
| `node:zlib` 不导出 `createZstdDecompress` | `dsh-session-persistence-jsonl` | **22.15** |
| `Promise.withResolvers is not a function` | `dsh-agent-loop` | 22.0 |
| `node:module` 不导出 `stripTypeScriptTypes` | `dsh-code-runtime-worker-thread` | 22.13 |

三个都是**静态 import / 直接调用**，躲不掉。

而计划里列的三项**都不是**阻塞项：

- **`node:sqlite`** —— 只有 `dsh-session-query-sqlite` 用，且是函数体里的
  `await import("node:sqlite")`（惰性）。`dsh-base` 出厂就配 `openAt: never`，
  该包源码注释原话："a disabled deployment never imports"。所以它根本不会被
  import。计划把它当成 22.5 下限的依据，是**只看了 grep 命中次数、没看引用形式**。
- **`process.loadEnvFile`** —— 只有一个调用点，且包在 try/catch 里。Node 18 上
  它是 `undefined`，抛的 TypeError 的 `.code` 不是 `ENOENT`，只打一行警告继续。
- **`AbortSignal.any`** —— 19 处，但是个小静态方法，polyfill 约 15 行。

**对计划的直接影响**：检查点 3 的退路里那条"退到 Node 22.5"**不可行**
（zstd 要 22.15）。可退的最低点是 22.15，而 dsh 的 `engines` 是
`^22.19 || >=24`，所以直接奔 22.19 最省事，没有更便宜的中间站。

**方法上值得记一笔**：这个结论不用等交叉编译，在 Mac 上换个 Node 版本跑一次
就出来了——`grep` 命中次数不能代替"实际跑一次"，惰性 import 和 try/catch
包裹的调用在 grep 里跟硬依赖长得一模一样。

## 附带发现：裸包名解析取决于 Node 版本

同一个 dsh 安装、同一份 profile：

```
node v24.19.0  裸包名解析成功
node v20.20.2  Cannot find package '@dsh-mobile/…' imported from
               .../cordis-plugin-loader/lib/index.js
```

不影响正常使用（Node 20 本来就不满足 dsh 的 engines），但**排查时会误导**：
同一份补丁 `nvm use 20` 报"包找不到"、切到 24 就好，很容易归因到装包上。


---

## 检查点 3：移植到 Node 22.19

### 3.1 补丁清单

做法：给 `vendor/nodejs-mobile` 加 upstream remote，浅取 `v18.20.4` 的 tag，
再 `git diff upstream-v18.20.4 HEAD`。229 个文件，但筛掉示例 app
（`tools/mobile-test/`）、`node_modules`、测试和 CRLF 噪音
（`.cmd` / `.msvc` / `.bat` / ChangeLog 那些整文件行尾改动）之后，
**真正要移植的只有十几个**。提在 `patches/nodejs-mobile/` 下，按移植顺序分四类。

### 3.2 移植到 22.19：412 行，6 个文件

产物是 [`patches/node-22.19-ios.patch`](../patches/node-22.19-ios.patch)。
比原始补丁小得多，三个原因：

**① 上游自己收了一部分。** 22.19 的 `configure.py` 已经把 `ios` 列进合法
`--dest-os`，`msign-return-address` 和 dtrace 排除那两处也已被上游重构掉。
但 `common.gypi` 里 `ios` 出现 **0 次**，平台配置仍需自己加。

**② 去掉了 Android 相关的部分**（原补丁是 Android + iOS 合在一起的）。

**③ 三处不能照抄——它们是 2020 年的写法，在 Xcode 26 上是错的：**

| 原补丁 | 为什么去掉 |
|---|---|
| `-fembed-bitcode` / `ENABLE_BITCODE: YES` | bitcode 自 Xcode 14 起废弃并移除 |
| `-Wl,-no_pie` | 现代 iOS 强制 PIE |
| `IPHONEOS_DEPLOYMENT_TARGET: 13.0` | 抬到 17.0，与外壳 app 对齐 |

### 3.3 失败 #2：gyp 的 make 生成器只认 mac，不认 ios

第一次 `make` 在 gtest 上炸：

```
gtest-port.h:260:2: error: C++ versions less than C++17 are not supported.
gtest-printers.h:922:29: error: no member named 'any' in namespace 'std'
```

看着像 gtest 的问题，其实不是。查编译行发现**只有 `-std=gnu11`，一个 C++ 标准
都没有**——而 `config.gypi` 里 `clang: 1` 明明设了，`common.gypi` 的 iOS 块里
`CLANG_CXX_LANGUAGE_STANDARD: 'gnu++17'` 也写了。

原因：`xcode_settings` 要靠 `gyp/generator/make.py` 调用
`xcode_emulation.py` 翻译成命令行 flag，而那套翻译**只在 `flavor == "mac"`
时启用**。`flavor` 是 `ios` 时整条路径被跳过，所有 `xcode_settings` 静默失效
——不报错，只是 flag 不见了。

这正是 nodejs-mobile 要改 `make.py`（17 处）和 `xcode_emulation.py`（3 处）的
原因。我一开始按"gyp 平台配置"归类时把这两个文件当成次要的跳过了，是判断失误：
**它们不是配置，是让配置生效的那一层。**

`xcode_emulation.py` 的三处里，有一处特别反直觉：

```python
if not gyp.common.CrossCompileRequested():   # 上游
if True:                                      # 改成
```

上游在交叉编译时**跳过**发 `-arch` / `-isysroot`，理由是"这些应由
`CC_target` / `CXX_target` 提供"。但我们没有那样一套 wrapper 脚本，
不发就没有 `-arch arm64`，编出来是主机架构的目标文件。

### 3.4 移植后的验证（改了生成器必须重跑 configure）

```
-miphoneos-version-min=17.0   38 处
-std=gnu++17                  22 处
iPhoneOS26.4.sdk              44 处
```

`config.gypi`：`OS: 'ios'`、`iossim: 'false'`、`node_target_type:
'static_library'`、`target_arch: 'arm64'`。

### 3.5 磁盘：关掉调试符号

Node 18 那轮 `out/` 实测 20 GB，而这台机器当时只剩 15 GB。在 iOS 块里加
`GCC_GENERATE_DEBUGGING_SYMBOLS: 'NO'`，生成的 makefile 里 `-gdwarf` 归零。
要的是能在设备上跑的静态库，不是能在 lldb 里单步的静态库。

### 3.6 失败 #3：ncrypto 的 `operator<=>` —— 一个 Node 18 时代不存在的移植点

```
ncrypto.h:367: error: 'operator<=' cannot be the name of a variable or data member
  int operator<=>(const BignumPointer& other) const noexcept;
```

`operator<=>` 是 C++20 的飞船运算符，在 `-std=gnu++17` 下被拆成 `<=` 和 `>`。
**错误信息完全不提 C++ 标准**，看着像 ncrypto 自己有语法错误。

真因在 `common_node.gypi`——Node **核心**单独覆盖成 C++20（`common.gypi` 全局
仍是 gnu++17），而它的条件写的是 `OS=="mac" and clang==1`，没有 ios。

**这个文件在 Node 18 时代不存在**（核心改用 C++20 是之后的事），所以
nodejs-mobile 的补丁里没有任何对应项。这是版本抬升不能机械 replay 的典型：
新增的条件分支只能靠"编一次、看它在哪炸"找出来。

### 3.7 失败 #4：iOS SDK 没有 `sys/random.h`

```
ares_rand.c: fatal error: 'sys/random.h' file not found
```

`deps/cares/cares.gyp` 里上游**已经写了** `OS=="mac" or OS=="ios"`，但把两者都
指向 `config/darwin`——而那份配置 `#define HAVE_SYS_RANDOM_H 1`。
实测：macOS SDK 有这个头，**iOS SDK 没有**。

解法是在那个 define 外面加 `TARGET_OS_IPHONE` 守卫。关掉它是安全的：这个头只
为 `getrandom()` 服务，而 `ares_rand.c` 的主路径是 `arc4random_buf()`
（`HAVE_ARC4RANDOM_BUF 1` 已开、`HAVE_GETRANDOM` 本来就是 undef）。

**模式识别**：这是本次构建里第三个"新 SDK / 新平台 × 老第三方配置"的问题
（前两个是 zlib 的经典 Mac 分支、gyp 生成器只认 mac）。共同形态是
**某个平台假设被写死在一个第三方目录里**，而错误信息指向使用点、不指向假设。

### 3.9 失败 #6（自己造的）：修 #5 时把 #3 的修复顶掉了

按 toolset 拆开之后，ncrypto 的 `operator<=>` 又编不过了。原因是我顺手把
`CLANG_CXX_LANGUAGE_STANDARD` 一起挪进了 `target_conditions`——而
**`target_conditions` 的求值晚于 `common_node.gypi` 给 Node 核心设的 gnu++20**，
放在那里等于把它顶回 gnu++17。

规律记下来：

| 放哪 | 什么时候用 |
|---|---|
| `conditions` | 要和别处的设置**叠加**（如 C++ 标准，会被 common_node.gypi 再覆盖） |
| `target_conditions` | 要按 `_toolset` / `_type` 分流（如 SDKROOT、部署目标） |

把 SDK / 部署目标留在 `target_conditions`、把 C++ 标准放回 `conditions`，
两个修复才同时成立：

```
out/deps/ncrypto/ncrypto.target.mk  → -std=gnu++20
out/node_js2c.host.mk               → MacOSX26.4.sdk
```

### 3.10 关于 `vendor/node-22` 的提交

移植过程有一次 `git commit` 打进了 `vendor/node-22` 自己的仓库（当时 shell 的
cwd 还在里面）。**没有纠正它**——这个 scratch clone 本来就不入库，而这样一来
移植成果被固定成了两个 commit，`git diff HEAD~2 HEAD` 就是完整补丁，
比维护一份手工导出的 diff 更可靠。

### 3.11 失败 #7：torque 需要异常 —— 同一个求值顺序问题，第二次

```
torque-compiler.cc:150:3: error: cannot use 'try' with exceptions disabled
```

`v8.gyp` 里 `torque_base` **自己就设了** `GCC_ENABLE_CPP_EXCEPTIONS: 'YES'`
（torque 是代码生成器，用异常处理解析错误）。但我的全局 `'NO'` 放在
`target_conditions` 里，**求值晚于各 target 自身的设置**，把它盖掉了。

跟 #6 是同一个机制，第二次踩。这次总结成规则写进了 `common.gypi` 的注释：

| 放哪 | 求值时机 | 放什么 |
|---|---|---|
| `conditions` | **早于** target 自身设置 | target 有权覆盖的**编译器行为**（C++ 标准、异常、RTTI、警告） |
| `target_conditions` | **晚于** target 自身设置，会盖掉它们 | 谁都不该覆盖的**平台选择**（SDKROOT、部署目标、ARCHS、按 `_toolset` 分流） |

重排后四条不变量同时成立（改完必须重跑 configure 才能验证）：

```
torque_base.target.mk   两个 flag 都没有  ← 自身的 YES 抵消了全局 NO
libnode.target.mk       -fno-exceptions   ← 全局设置仍生效
ncrypto.target.mk       -std=gnu++20      ← common_node.gypi 的覆盖没被顶掉
node_js2c.host.mk       MacOSX26.4.sdk    ← 主机工具编成 macOS 二进制
libnode.target.mk       iPhoneOS26.4.sdk  ← 目标库编成 iOS 二进制
```

**这条规则大概是整份笔记里最值钱的一句**：gyp 的两层条件不是"作用域大小"的
区别，是**求值先后**的区别，而错误信息永远不会提到这一点。

### 3.12 失败 #8：iOS 的 Security 框架没有 SecTrustSettings

```
crypto_context.cc:352: error: use of undeclared identifier 'kSecTrustSettingsResult'
crypto_context.cc:452: error: use of undeclared identifier 'kSecTrustSettingsDomainUser'
```

Node 22 的 `--use-system-ca` 会去读系统信任库，用的是 `SecTrustSettings*` 系列
API——**只有 macOS 有**，iOS 的 Security 框架不提供。上游的守卫是 `#ifdef
__APPLE__`，而 iOS 也满足。

解法：引入 `DSH_HAS_MACOS_KEYCHAIN`，用 `TargetConditionals.h` 的
`TARGET_OS_IPHONE` 把它挡在 iOS 之外，替换三处守卫（include、实现块、调用点）。

**功能上的代价是明确且可接受的**：iOS 上 `--use-system-ca` 拿不到系统证书，
回落到 Node 自带的根证书——那本来就是默认行为，我们也没打算用系统信任库。

这是本次构建第四个"平台假设写死在 `__APPLE__` 里"的问题
（前三个：zlib 的 `TARGET_OS_MAC`、c-ares 的 darwin 配置、gyp 生成器只认 mac）。
**`__APPLE__` 在 iOS 上为真，是这整类问题的共同来源。**

### 3.13 失败 #9：host 没给 ARCHS，回落到 x86_64 去读 arm64 汇编

```
<inline asm>:12:3: error: unknown use of instruction mnemonic without a size suffix
   12 |   mov x7, x2
<inline asm>:14:3: error: invalid instruction mnemonic 'blr'
```

`blr` 是 ARM64 指令，报错却是 **x86 汇编器**的口吻（"without a size suffix"
是 x86 要 `movq`/`movl` 那种后缀时说的话）。

按 toolset 拆开之后，host 分支没有 `ARCHS`，`xcode_emulation` 就回落到它的历史
默认值 **x86_64**；而 V8 的汇编文件是按 `target_arch`（arm64）选的。于是
`obj.host/.../asm/arm64/push_registers_asm.cc` 被 `-arch x86_64` 编译。

诊断关键：**同一个源文件在 target 和 host 各编一次**，只有 host 那次失败。
把两条编译行拉出来对比，差别一眼可见：

```
obj.target/... push_registers_asm.o   -arch arm64     ✓
obj.host/...   push_registers_asm.o   -arch x86_64    ✗
```

解法是在 host 分支按 `host_arch`（`config.gypi` 里有，这台机器是 `arm64`）
显式指定 `ARCHS`。

**这条与 #5 是一对**：#5 是 host 拿了 target 的 SDK，#9 是 host 没拿到自己的
架构。交叉编译里 host/target 的每一项设置都要单独确认，"没设置"不等于
"用合理默认值"——gyp 的默认值是 2010 年的。

nodejs-mobile 在 `push_registers_asm.cc` 里加 `#ifndef V8_TARGET_ARCH_ARM`
守卫，处理的是同一类错位（他们的注释原话："we compile both host and target
code but with flags that reflect only the target platform"）。我们这边用给
host 补 `ARCHS` 解决，不改 V8 源码——**修配置比修源码更容易随版本移植**。
