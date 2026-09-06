# dsh-mobile

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 runtime
搬到手机上：**agent 循环、会话状态、技能、子 agent 全部在设备内运行**，而需要真
shell 的重活通过纯 JS 的 SSH 派给用户自己配置的云端机器。

形态是 **手机是大脑和感官，云端是手**。这不是"把桌面 harness 缩小塞进手机"——
缩小版没有存在意义（不如远程连电脑）。这个形态有意义，因为它拥有手机独占的 I/O，
同时不放弃真正的执行能力。

设计与实施记录在 [`docs/superpowers/`](docs/superpowers/)。

## 为什么需要它

iOS 第三方 app **不能 fork/exec**：容器沙箱拒绝 `process-exec`，AMFI 只允许执行
签名链在本 app team 内的二进制。这就是 iOS 上不存在 Termux 的原因，也是这个项目
存在的全部理由。所以 mobile profile 必须禁掉 dsh 里一切依赖本地进程的插件，
并把执行路由到远程机器。

## 三个包

| 包 | 职责 |
| --- | --- |
| `@dsh-mobile/remote-registry` | 远程机器注册表、`dsh-remote://` 剪贴板导入、五阶段连接探针 |
| `@dsh-mobile/shell-ssh` | SSH 连接池（含主机指纹校验）、远程执行、dsh `ShellExecutor` 实现 |
| `@dsh-mobile/tool-fs-search` | 纯 JS 的 `glob` / `grep`，顶替 dsh 那个靠 ripgrep 二进制的实现 |
| `@dsh-mobile/mobile-app` | mobile profile 的 `cordis.patch.yml` |

## 安装

```bash
mkdir -p ~/.dsh/profiles/mobile
cat > ~/.dsh/profiles/mobile/package.json <<'JSON'
{
  "name": "dsh-profile-mobile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "@dsh-mobile/mobile-app"
      ]
    }
  }
}
JSON
cat > ~/.dsh/profiles/mobile/cordis.patch.yml <<'YAML'
# dsh-base + dsh-headless 都不提供 storage，而 @dsh-mobile/remote-registry
# 注入 storageDomain。理由见下面的约束 ③。
- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
YAML
```

然后把四个包都装进 profile：

```bash
cd ~/.dsh/profiles/mobile
pnpm add file:<仓库路径>/packages/mobile-app \
         file:<仓库路径>/packages/remote-registry \
         file:<仓库路径>/packages/shell-ssh \
         file:<仓库路径>/packages/tool-fs-search
```

### 三个必须知道的安装约束

**① 四个包都要列为 profile 的直接依赖，不能只装 `mobile-app`。**

补丁里的插件条目写的是 profile 相对路径（`./node_modules/@dsh-mobile/…/lib/plugin.js`）
而不是包名。原因写在补丁自己的注释里，简述：`cordis-plugin-loader` 对**裸标识符**
的 `import()` 不使用 `baseUrl`，Node 因而相对 loader 自己的位置（全局 dsh 安装目录）
解析，看不见装在 profile 里的包。只有以 `.` 开头的路径才走 `baseUrl`。

这不是本项目特有的问题——装了 `@tencentcloudadp/dsh-adp` 的 profile 同样报
`Cannot find package`，而 `dsh plugin add` 本身只是"在 profile 目录里跑 pnpm"的转发器。

代价就是这条：pnpm 只把**直接依赖**提到 `node_modules` 顶层，所以四个包都得列上。

**② 用 Node 22.19+ 或 24 跑 dsh。**

`/opt/homebrew/bin/dsh` 的 shebang 是 `#!/usr/bin/env node`，会用 PATH 上的 node。
若默认是 Node 20，dsh 会因不满足 `engines` 而失败——报错跟插件无关，很容易误判。

**③ storage 三层写在 profile 的补丁里，不在 bundle 里。**

`remote-registry` 需要 `storageDomain` 才能存机器和密钥，没有它整个"注册机器"
功能会**无声地**不可用（硬 inject 的 fiber 一直 pending，不报错）。而三个官方
bundle 里只有 `dsh-web-app` 挂了 storage，`dsh-base`/`dsh-headless` 都没有。

这三行曾经写在 `mobile-app` 的补丁里，但那是错的：`insert` 列表是**拼接**的，
不是按 id 覆盖，所以 bundle 一旦和 `dsh-web-app` 叠到同一个 profile，就会抛
`duplicate loader entry id: storage`，整棵树起不来。

所以归属是 profile 级——**基于 `dsh-web-app` 的 profile 不要加这一段**，
它自带 storage。

## 注册一台远程机器

目前只支持从 Mac 端导出一段 `dsh-remote://` 到剪贴板再粘贴导入（Apple 生态下
通用剪贴板直接可用），以及手工填写。扫码 enrollment 属于后续工作。

配置保存后会立刻跑一次五阶段探针：`tcp → credential → handshake → os → gpu`，
任一层失败即停止并指出**是哪一层**——手机上排错成本高，笼统的 "connection failed"
没有价值。

## 在 iPhone 上看到它

`ios/` 下是一个 iOS 外壳：`WKWebView` 加载 dsh 的 Web 界面。

```bash
cd ios && xcodegen generate
xcodebuild -project DshMobile.xcodeproj -scheme DshMobile \
  -sdk iphonesimulator -configuration Debug -derivedDataPath build \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/DshMobile.app
xcrun simctl launch booted com.dshmobile.shell
```

外壳连的是 **Mac 上跑着的 host**，所以要另开一个 profile：Web 界面来自
`dsh-web-app`，替换掉上面安装步骤里的 `dsh-headless`。它自带 storage，
所以这个 profile 的 `cordis.patch.yml` 就是空的 `[]`——**不要**加上面那段
storage 补丁，加了会抛 `duplicate loader entry id: storage`。

```bash
mkdir -p ~/.dsh/profiles/mobile-web
sed 's/dsh-headless/dsh-web-app/; s/dsh-profile-mobile/dsh-profile-mobile-web/' \
  ~/.dsh/profiles/mobile/package.json > ~/.dsh/profiles/mobile-web/package.json
printf '[]\n' > ~/.dsh/profiles/mobile-web/cordis.patch.yml
cd ~/.dsh/profiles/mobile-web && pnpm install   # 依赖同上面的四个包

dsh --profile mobile-web web    # 监听 127.0.0.1:7799
```

**这一版的 runtime 还在 Mac 上，不在设备里。** 模拟器与宿主共享网络栈，所以
`127.0.0.1` 直达；真机不行，而 dsh 出于安全拒绝绑 `0.0.0.0`（原话："it would
expose remote code execution to the network"），所以真机不是改个 IP 的事。

最终形态是设备内跑一个 jitless 的 Node、host 监听 app 自己的 loopback 端口——
计划在 [`docs/superpowers/plans/2026-09-04-node-ios-build.md`](docs/superpowers/plans/2026-09-04-node-ios-build.md)。
外壳这一层对此是**可替换**的：无论 host 在 Mac 上还是在 app 内的 Node 线程里，
WebView 面对的都是同一个 loopback HTTP + WebSocket 端点，加载同一份前端。
换过去时改的是 `HarnessEndpoint.current`，不是别的。

界面用的还是桌面版布局（按 slot 换成移动布局插件是后面的事），在手机屏上偏挤。

## 诚实的限制

- **`tool-bash` 出厂禁用。** 没有注册机器时 `shell-ssh` 不注册 `ctx.shell`，而
  `tool-bash` 注入 `shell`；`assertEntriesActivated()` 把 PENDING 当 FAILED，
  留着启用会让整棵插件树起不来。这与 dsh 自己对可选 provider 的做法一致
  （`tool-subagent-codex` 也是出厂禁用）。注册机器后由设置界面打开它。
- ~~注册机器需要重启才能激活 shell~~ **已解决**：插件在机器缺席时订阅
  `domain/changed`，等那条记录被写入再挂载 `ctx.shell`。`tool-bash` 因为注入
  `shell`，会由 cordis 在服务出现时自动激活——不需要我们协调。
- **`kill()` 是尽力而为的通道拆除**，不是杀进程。非 PTY 的 exec channel 下
  OpenSSH 不可靠地回收远程命令——`make -j8` 会继续跑，而本地已报 `killed`。
  界面文案应说"连接已关闭"，不是"进程已终止"。
- **`dshEnv` 不跨 SSH 边界。** dsh 的契约要求执行器在合并新快照前先清掉旧的
  `DSH_*`，而这个执行器每次调用组装一条独立命令、不持有会话，做不到"清掉一个
  自己从未追踪过的键"。发一个只合并不清理的实现会看起来支持、实则长期供应陈旧值。
- **没有本地沙箱。** iOS 的 app 容器本身就是边界。`ShellRunResult.sandbox` 不填、
  `sandboxMode` 返回 `undefined`——宁可什么都不声称，也不声称一个假的约束。
- **`glob` / `grep` 是重新实现的。** 输出格式复用 dsh 自己的导出，工具定义有
  parity 测试逐字段守住；与真实 ripgrep 的差分测试覆盖了 glob 方言、两个工具
  各自不同的忽略语义、排序，以及 `.gitignore`。

  `.gitignore` **支持常用语义**：`#` 注释、`!` 否定（后出现的覆盖先出现的）、
  `foo/` 只匹配目录、`/foo` 锚定、不含 `/` 的模式在任意深度匹配、嵌套
  `.gitignore` 作用于自己的子树。**不支持**：`\` 转义、全局 `~/.gitignore`
  与 `.git/info/exclude`、ripgrep 特有的 `.ignore` / `.rgignore`，以及 git
  的"已跟踪文件不受 ignore 影响"（这里没有 git 索引，无从判断）。

## 开发

```bash
pnpm install
pnpm test          # 全套
pnpm typecheck
pnpm -r build      # 产出 lib/，dsh 加载的是它而不是 .ts
```

jitless 相关的测试**必须走真的 `node --jitless` 子进程**：vitest 跑不了 jitless
（Vite 自己的工具链需要 WebAssembly），Node 的 `--experimental-strip-types` 也一样，
所以那些测试针对构建产物而不是 `.ts`。
