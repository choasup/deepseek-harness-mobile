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

---

## 检查点 3 完成：Node 22.19 的 iOS arm64 静态库

```
$ lipo -info libnode.a
Non-fat file: libnode.a is architecture: arm64

$ ar x libnode.a async_resource.o && vtool -show-build async_resource.o
 platform IOS
    minos 17.0
      sdk 26.4
```

**33 个静态库，共 118 MB**（关掉调试符号之后）。关键几个：

| 库 | 体积 |
|---|---|
| `libv8_base_without_compiler.a` | 28 MB |
| `libnode.a` | 21 MB |
| `libv8_initializers.a` | 20 MB |
| `libv8_snapshot.a` | 2.3 MB |

### 最后一个"失败"不是失败

`make` 最终仍以非零码退出，卡在链接 `embedtest`：

```
Undefined symbols for architecture arm64:
  "_CFRelease", referenced from:
      absl::time_internal::cctz::local_time_zone() in libabseil.a
```

`embedtest` / `cctest` / `node` 都是**可执行文件**，而我们要的是静态库。
abseil 的时区查询在 Apple 平台用 CoreFoundation，那些测试可执行文件没链这个
框架——但 **iOS app 本来就会链 CoreFoundation**，所以这对我们不构成问题。

**判断构建是否成功，不能只看 make 的退出码**：这套构建的目标是
`out/Release/*.a`，不是 `out/Release/node`。检查产物，别检查退出码。

### 九个失败的归类

| # | 报错说的 | 真正的原因 | 类别 |
|---|---|---|---|
| 1 | zlib 里 `fdopen` 语法错误 | `TARGET_OS_MAC` 在现代 SDK 恒为 1，经典 Mac OS 分支全量命中 | `__APPLE__` 族 |
| 2 | gtest 不支持低于 C++17 | gyp 生成器只在 `flavor=="mac"` 时翻译 `xcode_settings` | `__APPLE__` 族 |
| 3 | ncrypto `operator<=` 不能作变量名 | `common_node.gypi` 的 C++20 覆盖没带 ios（该文件 Node 18 时代不存在） | 版本漂移 |
| 4 | 找不到 `sys/random.h` | iOS SDK 没有，而 c-ares 让 ios 共用 darwin 配置 | `__APPLE__` 族 |
| 5 | `Killed: 9` | host 工具被编成 iOS 二进制 | host/target 错位 |
| 6 | ncrypto 又炸（自己造的） | C++ 标准放进 `target_conditions`，求值太晚顶掉了覆盖 | gyp 求值顺序 |
| 7 | torque 不能用 `try` | 异常开关同上，盖掉了 torque 自己的设置 | gyp 求值顺序 |
| 8 | `kSecTrustSettings*` 未声明 | iOS 的 Security 框架没有这套 API，守卫写的是 `__APPLE__` | `__APPLE__` 族 |
| 9 | `blr` 不是合法指令 | host 没给 ARCHS，回落 x86_64 去读 arm64 汇编 | host/target 错位 |

**四类，没有一类是"代码有 bug"。** 全部是平台假设错位，而且**九个里有八个的
报错信息指向使用点、不指向假设**。这类工作的难点不在改代码，在于把症状翻译
回原因。

---

## 里程碑：Node 22.19.0 在真机上跑起来了（2026-09-07）

iPhone 17 Pro Max，app 内探针写到 Documents，`devicectl copy from` 取回：

```json
{
  "node": "v22.19.0",
  "platform": "ios/arm64",
  "jitless": true,
  "hasSqlite": true,
  "hasZstd": true,
  "hasWithResolvers": true,
  "hasStripTypes": true,
  "cpus": 6
}
```

**决定版本下限的那三个 API 在设备上全部可用**（zstd 22.15 / `Promise.withResolvers`
22.0 / `stripTypeScriptTypes` 22.13），`node:sqlite` 也能用。`jitless: true`
确认 V8 跑在无 JIT 模式——这是 iOS 的硬要求，也是整个方案成立的前提。

### 取设备上输出的办法

app 里 Node 的 stdout **不指向任何地方**，`console.log` 直接消失。做法：

```swift
freopen(documentsURL.path, "w", stdout)   // 先重定向
dsh_node_start(argc, argv)                // 再启动
```

然后 `xcrun devicectl device copy from --domain-type appDataContainer
--domain-identifier <bundle id> --source Documents/node-probe.json`。

### 链接：一次通过

30 个静态库（排除 gtest 与 torque_base）零未定义符号。需要额外链的框架只有
三个：CoreFoundation（abseil 时区查询，就是 embedtest 当初缺的那个）、
Security、SystemConfiguration。

**一次误判记下来**：`.app/DshMobile` 只有 90K，我据此以为库没链进去。
错了——Xcode 16+ 默认走 debug dylib，真代码在 `DshMobile.debug.dylib`
（74 MB，113305 个 node/v8 符号）。桩里的符号 `___debug_blank_executor_main`
是判据。**在 Xcode 16+ 上看 .app 体积判断链接结果不成立。**

### 模拟器跑不了

静态库只编了 iphoneos 架构：
`ld: building for 'iOS-simulator', but linking in object file built for 'iOS'`。
要模拟器得再编一轮 arm64-simulator。真机是目标，暂不做。

---

## 检查点 4.2：设备上的逐包 import 探测

第一次结果（`--with-intl=none` 编出来的 Node）：**55/83**

| 失败类型 | 个数 |
|---|---|
| Unicode 属性转义 `\p{...}` | **25** |
| 原生模块（已禁用的插件：sandbox / subprocess） | 2 |
| sharp（已禁用的 attachment-local） | 1 |

### 失败 #10：`--with-intl=none` 把 `\p{...}` 一起关掉了

```
Invalid regular expression: /^[\p{XID_Start}_]\p{XID_Continue}*$/u:
  Invalid property name in character class
```

25 个包全栽在这一条，而且都是核心：`agent-loop`、`tool-fs`、`subagent`、
`llm-deepseek`、`plan-mode`……

Unicode 属性转义（`\p{XID_Start}`、`\p{L}`、`\p{N}`）依赖 V8 的
`V8_INTL_SUPPORT`，而 `--with-intl=none` 会把它关掉。nodejs-mobile 的脚本用的
就是 `none`（Node 18 时代、目标只是跑通示例），照抄过来就踩中了。

改成 `--with-intl=small-icu`：只带英文 locale 数据，但 **Unicode 属性表是全的**，
正是需要的那部分。`config.gypi` 里 `v8_enable_i18n_support` 从 0 变 1。

**这条只有在真机上跑 dsh 才会暴露**：Mac 基线用的是官方 Node（自带 full-icu），
83 个包全过；设备内那份是自己编的，参数不同。**跨平台移植里，"同一份代码在
两边跑"不等于"两边的 runtime 一样"。**

### 其余 3 个失败符合预期

它们对应的插件在 mobile profile 里都是禁用的，import 失败不影响运行：

- `attachment-local` ← sharp（原生，见 F' 段）
- `sandbox-local` ← koffi（原生）
- `subprocess-local` ← node-pty（原生）

顺带一提，node-pty 在设备上找的是 `prebuilds/ios-arm64/pty.node`——
说明 Node 正确地把自己认成了 `ios` 平台。

### small-icu 重编的结果

37 个静态库（比 none 那版多 4 个），共 131 MB：

```
libicui18n.a   4.8M
libicudata.a   3.7M
libicuucx.a    2.6M
libicustubdata.a
```

`make` 仍以非零退出，仍然只卡在链接 `embedtest`（CoreFoundation）——
与上一版相同，不影响静态库。**再次印证：判断这套构建成功与否要看
`out/Release/*.a`，不是 make 的退出码。**

app 重新链接一次通过（34 个库）。

### 检查点 4.2 通过：设备上 80/83

换成 small-icu 之后重测：

```json
{ "platform": "ios/arm64", "node": "v22.19.0", "jitless": true,
  "total": 83, "ok": 80,
  "failed": [ "dsh-attachment-local", "dsh-sandbox-local", "dsh-subprocess-local" ] }
```

**25 个 `\p{...}` 失败全部消失**，与 Mac 基线（同样 80/83）逐项一致。
剩下 3 个对应的插件在 mobile profile 里都是禁用的。

**副作用一则**：探测输出末尾会多出两行 `0.5`——某个包在 import 时往 stdout
打了东西，把 JSON 弄成了非法。不影响判断，但解析时要容错。设备上没有别的
输出通道，stdout 是共享的，这类污染以后还会有。

---

## 检查点 5：dsh 在设备内起服务

日志（`Documents/dsh-host.log`，`devicectl copy from` 取回）：

```
[bootstrap] execArgv=["--expose-internals"]
[bootstrap] require internals: yes
[bootstrap] WebAssembly=object(stub=true) fetch-swapped=true
dsh web: http://127.0.0.1:47799
```

无错误。**runtime 完全在设备内**：不需要 Mac、不需要局域网、不需要填地址。

到这一步又踩了五个坑，全部与 iOS/嵌入式 Node 有关：

### 失败 #11：undici 的 WebAssembly（**整个项目最硬的一关**）

```
dsh: fatal load failure: ReferenceError: WebAssembly is not defined
    at lazyllhttp (node:internal/deps/undici/undici:5827:9)
```

Node 内置的 undici（`fetch` 的实现）用 WASM 版 llhttp 解析 HTTP，而 jitless
没有 WebAssembly。**这不是 dsh 的依赖，是 Node 自己的**，躲不开。

先查过一条可能一劳永逸的路：V8 的 WASM 解释器 DrumBrake 正是为 jitless 环境
做的——但它在 V8 13+ 才有，Node 22 的 V8 是 **12.4**。此路不通。

解法分两半：

**① `WebAssembly` 桩，永不 settle。** undici 那段是

```js
var llhttpPromise = lazyllhttp();   // 内部 await WebAssembly.compile(...)
llhttpPromise.catch();              // ← 不传处理函数，等于没接住
```

`.catch()` 不带参数并不消化 rejection → unhandled rejection → 进程崩。
所以**不能让 compile 抛错或 reject**，只能让它永远悬着。

**② 把 `fetch` 换成走 `node:http`**——那用的是编译进 libnode 的 **C++ 版**
llhttp，不需要 WASM。121 行，`--jitless` 下实测 GET/POST/SSE 流式/AbortSignal
全通过。

**顺序是死的，而且比想象中苛刻**：实测 Node 22 上 **`import 'node:http'` 本身
就会拉起 undici**（Node 24 不会）。ESM 的静态 import 在模块代码之前求值，
所以入口文件**不能有任何静态 import**——桩内联在最顶部，其余一律顶层 await +
动态 import。

> 这里我先在 Node 24 上做了"哪些 Web API 在 jitless 下可用"的实验，结论是
> `Headers`/`Response`/`Request` 都安全。**那个结论在 Node 22 上不成立**——
> 碰任意一个都会拉起 undici。又一次印证：拿别的版本的结论套自己编的 runtime，
> 会得到看似合理、实则错误的判断。

### 失败 #12：本地包的运行时依赖没进 bundle

`Cannot find package 'ssh2'`。npm 对 `file:` 依赖建符号链接，解链接换成实体
拷贝后，依赖树里就没有它们的来源了。显式装 `ssh2` 与 `tweetnacl`。
**注意任何 `npm install` 都会把符号链接重建回来**——解链接必须是最后一步。

### 失败 #13：禁用 attachment-local 让整棵树起不来

```
@deepseek-ai/dsh-host-apiproxy: pending (waiting for service: attachments)
```

`dsh-host-apiproxy`（API 网关，Web 界面的命脉）对 `attachments` 是**硬依赖**。
当初判断"禁用是安全的"只查了 `dsh-tool-fs`（确实是软依赖），
**对 apiproxy 的 grep 返回空就当成没有依赖——匹配模式不对**。
教训：证明"没有消费者"要逐个确认，一次没匹配上不等于不存在。

改为让 attachment-local 正常加载、把 `sharp` 换成桩：import 与属性访问都正常，
只有真正处理图像时才抛错。

### 失败 #14：profile 只建一次，指向了旧 bundle

app bundle 的路径里带一个**每次安装都变**的 UUID，而 profile 里那个指向
`node_modules` 的符号链接是首次运行时建的。于是重装之后 dsh 一直读**上一个
版本的 cordis.patch.yml**——改了补丁毫无效果，且看不出原因。改成每次启动重建。

### 失败 #15：HMR —— 错误信息指向 flag，真因是 loader 分类

```
failed to apply loader entry <hash> (@deepseek-ai/cordis-plugin-hmr):
  --expose-internals is required for HMR service
```

条目 id 是**动态哈希**，用补丁按 id 关不掉。源头在 dsh 自己的 profile-boot：

```js
if (ctx.get("hmr") === undefined) {
  await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } })
}
await watchUserPatches(ctx, ...)   // 用途：监听用户 patch 文件
```

**是"禁用 hmr 行"这个动作本身导致它去动态建一个。**

而它的检查是 `if (!this.ctx.loader.internal)`——**不是查 flag，是查 loader 有没有
分类出 Node 的内部模块加载器**，错误信息有误导性。loader 拿内部访问有两条路：
`--expose-internals`，或原生模块 `node-addon-require-builtin`（iOS 上已被剥掉）。
给 argv 加 `--expose-internals` 后两处一起解决。

### 失败 #16：相机存不进图 —— 报错在讲图像，真因是**元数据契约**

症状是拍照连续五次失败，每次都是同一句：

```
Error: Unsupported or malformed image data
```

这句话有很强的误导性：它听起来在说"这张图有问题"，于是前四轮的排查方向都是
"桥少实现了哪个 sharp 方法"——`.raw()`、`.toColourspace()`、`.trim()`，
补一个、部署一次、再拍一张、再报同一句。每轮一次真机往返。

真因不在方法上，在**上游会校验我们的输出**。`dsh-attachment-local` 归一化的
最后一步是：

```js
async function verifyNormalizedImage(image, expectedAlpha) {
  const detected = await detectImage(image.data)
  if (detected.mediaType !== image.mediaType || detected.width !== image.width
      || detected.height !== image.height || detected.animated
      || detected.carriesMetadata || detected.depth !== "uchar"
      || detected.space !== "srgb" || !encodedAlphaIsCompatible(expectedAlpha, detected))
    throw new AttachmentError(...)
}
```

它把刚编码出来的字节**重新解码**，逐项比对八件事。桥当时的 `metadata()` 只报
`format / width / height / hasAlpha`——于是 `undefined !== "uchar"` 恒成立，
**每一张图**都在最后一步被判负。跟图像本身、跟拍照，一点关系都没有。

三个必须如实满足的点：

1. **`depth` 与 `space` 是硬字段**，不报等于报错。
2. **不能报 `orientation`。** `carriesRetainedMetadata()` 把"有 orientation"
   直接算作"携带元数据"；而且 `imageMetadata()` 见到 `orientation >= 5` 还会
   再对调一次宽高——原生侧已经在 `WithTransform` 里把方向烘进像素了，
   报出去就是转两遍。
3. **`carriesMetadata` 不能按"有没有 `{Exif}` 字典"来判。** ImageIO 写出的
   **每一张** JPEG/PNG 都自带一个只含 `ColorSpace`/`PixelXDimension` 的 Exif
   字典和一个 `ProfileName = sRGB`。照"有字典就算携带"来报，我们自己的编码
   结果永远通不过。判据得是"有没有实质标签"（GPS/IPTC/相机型号/时间）——
   反过来一律报 false 也不行，那会让相机原图连 GPS 一起原样落盘。

还有一处同类问题：`normalize` 必须把缩略图**再画进一个 sRGB 上下文**再编码。
iPhone 的照片多是 Display P3，直接编码出来 `space` 就不是 `srgb`。

#### 教训：错误信息说的是"哪一类"，不是"哪一个"

上游把八项检查合并成一句话抛出，真因塞在 `cause` 里且从不显示。
在这种上游面前，"按症状猜"必然是逐个方法试错。**该做的是去读上游那段代码，
把契约列出来一次对齐**——这次真正解决问题的动作，是把
`encodingAttemptsAtSize` / `verifyNormalizedImage` 完整读了一遍。

自检也跟着换了做法：不再挨个测桥的方法（那只能覆盖"我想到的"），
而是直接调 `prepareImageFile`——相机和上传走的同一个入口，四张合成图分别
命中 JPEG / PNG / 只有 WebP 三条编码分支。见 `tools/bridge-selftest.mjs`。
自检先在 Mac 上用**真的 sharp** 跑通，确认"自检本身是对的"，再上设备。

**真机确认（2026-09-09，iPhone 17 Pro Max）**，设备日志逐条：

```
[bridge-selftest] metadata ok: {"format":"png","width":1,"height":1,"hasAlpha":true,
                  "channels":4,"depth":"uchar","space":"srgb","pages":1,"hasProfile":false}
[bridge-selftest] 原生可写格式：webp=true
[bridge-selftest] 照片式 RGB（→ JPEG） ok → image/jpeg 2048×195 443338 字节
[bridge-selftest] 少色 RGB（→ PNG） ok → image/png 2048×195 6026 字节
[bridge-selftest] 少色带透明（→ PNG） ok → image/png 2048×195 10766 字节
[bridge-selftest] 照片式带透明（→ WebP） ok → image/webp 2048×195 288950 字节
[bridge-selftest] 附件归一化自检全部通过
```

四条分支的分类与 Mac 上用真 sharp 跑出来的**逐项一致**，最后那条走的是编进
app 的 libwebp。整份日志 20 行、零错误。

### iOS 的 ImageIO 能读 WebP，但写不了

`encodingAttemptsAtSize` 对**带透明通道**的图只给一条路：

```js
if (hasAlpha) return webp   // 没有 png/jpeg 的退路
```

而 `CGImageDestinationCopyTypeIdentifiers()` 里没有 WebP（macOS 上实测只有
jpeg / png / jpeg-2000 等）。退回 JPEG 是不行的——上游比对
`detected.mediaType !== image.mediaType`，标着 webp 的 JPEG 必然判负，
而报出来的还是那句和真因无关的 "Unsupported or malformed image data"。

所以把 **libwebp 1.5.0 编进 app**（`ios/WebP/`，~120 个 C 文件，
`xcrun clang -arch arm64` 直接过，无需改动）。Swift 侧只暴露一个函数，
见 `ios/WebP/dsh_webp.h`。注意 `CGBitmapContext` 只能给**预乘**的 RGBA
（8 位非预乘建不出上下文），交给 WebP 前要还原回非预乘，否则半透明区域整片发暗。

### 顺带发现：prepare 脚本漏装了两样东西

`ios/prepare-nodejs-project.sh` 每次都会 `rm -rf nodejs-project`，而
`@dsh-mobile/tool-camera` 和 sharp 桥当初是**手动补装**进去的——脚本里没有。
之所以一直"能用"，只是因为那之后没人重跑过这个脚本。

这类问题的表现不是"少个功能"：补丁里的 loader 条目解析不到包，
`assertEntriesActivated` 把 PENDING 当 FAILED，**整棵插件树起不来**。
现在两样都在脚本里，且注释里写明了"这个列表要与 cordis.patch.yml 的 insert 逐一对上"。

## 传感器：把"感官"补齐

起因是用户在手机上问 agent「能感知到手机上有哪些传感器？」，它答：

> 说实话：**感知不到。** 我连"手机上有没有传感器"都探不出来……
> 我运行在**文件沙盒**里，没有任何硬件接口

**这句话本身没说错**——Node 侧确实没有硬件接口，传感器只能由原生侧读。
缺的不是模型的能力，是一座桥。而「手机是大脑和感官」这个形态里，
在此之前"感官"只有相机。

### 两个工具，不是一个

- `list_device_sensors`：列清单。**不采样、不弹权限框、不耗电。**
- `read_device_sensors`：读数。

分开是因为"有哪些传感器"应该能**便宜地**回答。合成一个工具的话，模型为了
回答前一个问题就得付出后一个的全部代价——包括一个本来不必弹的定位授权框。

### 一次快照，不是订阅

每个读数都是"开采样 → 拿第一帧 → 立刻停"。理由有三个：工具调用本身就是
一问一答的形状；持续采样在后台会被系统掐掉，留下的是一个**悄悄停更的假数据源**；
传感器常开很费电。要看趋势就让模型隔一会儿再调一次——比给它一个会骗人的
数据流诚实。

### 拿不到的要说清楚为什么

不可用的传感器返回 `available: false` 加一句原因，**不省略字段、也不给 0**。
模型分不清"没有这个传感器"、"没权限"和"值就是 0"，但这三者对它下一步该做
什么的影响完全不同。清单里因此**特意保留了两个明确不可用的条目**：

- `ambientLight` —— iOS 没有公开的环境光 API。间接的替代是
  `device.screenBrightness`：开了自动亮度时它跟着环境光走。
- `microphoneLevel` —— 读音量等于开录音，属于采集而非读数。

### 几个会静默出错的点

- **电池要先 `isBatteryMonitoringEnabled = true`**，否则 `batteryLevel` 恒为 `-1`、
  `batteryState` 恒为 unknown —— 一个看起来像"读到了"的假读数。
- **UIKit 的属性是主线程专属的**（`UIDevice.current`、`UIScreen.main`），而桥的
  路由跑在后台队列上。在后台读轻则触发 main thread checker，重则拿到过期值，
  而过期值和正常读数长得一模一样。
- **`CLLocationManager` 必须在主线程建**，它的回调靠 run loop。在后台队列直接
  new 出来的 manager 不会回调，表现是"永远超时"，看不出是线程问题。
  同理它要被持有到回调结束——提前释放同样表现为超时。
- **磁力计要一并报校准状态**。`uncalibrated` 时那三个数基本没有意义，
  而它们看上去和校准好的读数完全一样。
- **`NSMotionUsageDescription` 不是可选的**：加速度计/陀螺仪/磁力计不需要它，
  但 `CMAltimeter` / `CMPedometer` / `CMMotionActivityManager` 需要，缺了直接崩
  ——不是"读到 0"。

### 定位不在默认集合里

`read_device_sensors` 不点名时读的是 device / battery / motion / barometer /
activity：都不弹框、也不涉及位置。精确坐标要模型**显式**写进 `sensors`，
那一步会弹系统授权框，由用户决定。
