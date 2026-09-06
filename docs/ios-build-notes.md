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

### 1.5 构建结果

*（进行中）*
