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

## 五个包

| 包 | 职责 |
| --- | --- |
| `@dsh-mobile/remote-registry` | 远程机器注册表、`dsh-remote://` 剪贴板导入、五阶段连接探针 |
| `@dsh-mobile/shell-ssh` | SSH 连接池（含主机指纹校验）、远程执行、dsh `ShellExecutor` 实现 |
| `@dsh-mobile/tool-fs-search` | 纯 JS 的 `glob` / `grep`，顶替 dsh 那个靠 ripgrep 二进制的实现 |
| `@dsh-mobile/client-ui-layout-mobile` | 移动版单栏外框，顶替 dsh 的三栏 `ui-layout`（连带接管主题投影） |
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

然后把五个包都装进 profile。**先写 `pnpm-workspace.yaml`**，缺了它
`pnpm install` 会直接失败（理由见下面的约束 ④）：

```bash
REPO=<仓库绝对路径>
cd ~/.dsh/profiles/mobile
cat > pnpm-workspace.yaml <<YAML
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
overrides:
  '@dsh-mobile/remote-registry': link:$REPO/packages/remote-registry
  '@dsh-mobile/shell-ssh': link:$REPO/packages/shell-ssh
  '@dsh-mobile/tool-fs-search': link:$REPO/packages/tool-fs-search
  '@dsh-mobile/client-ui-layout-mobile': link:$REPO/packages/client-ui-layout-mobile
YAML

# 开发期用 link:（软链，改了源码不必重装）；要固定副本就把 link: 换成 file:
pnpm add link:$REPO/packages/mobile-app \
         link:$REPO/packages/remote-registry \
         link:$REPO/packages/shell-ssh \
         link:$REPO/packages/tool-fs-search \
         link:$REPO/packages/client-ui-layout-mobile
```

pnpm 会说 `Ignored build scripts: cpu-features, ssh2`——**这是想要的结果**，
不用去 approve：那两个是 ssh2 的原生加速件，跳过后 ssh2 走纯 JS 实现，
而纯 JS 正是这个项目要的（iOS 上没有原生模块可加载）。

### 四个必须知道的安装约束

**① 五个包都要列为 profile 的直接依赖，不能只装 `mobile-app`。**

pnpm 只把**直接依赖**提到 `node_modules` 顶层，而补丁里的插件条目由 loader
相对 profile 目录解析，找的就是顶层那一份。少列一个，那一行就 404。

> 这里原先写着另一套理由：「补丁必须用 `./node_modules/…` 相对路径，因为
> loader 对裸标识符的 `import()` 不使用 `baseUrl`」。**那是错的**，已实测证伪：
> 全部换成裸包名后照常启动（`file:` 副本装和 `link:` 软链装都试过），而失败
> 时 loader 的报错原文是 `imported from ~/.dsh/profiles/<name>/`——它本来就
> 相对 profile 解析。当初那次 `ERR_MODULE_NOT_FOUND` 的真实原因就是这一条
> 「没装成直接依赖」，被错误归纳成了 loader 的限制。

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

**④ profile 目录里必须有 `pnpm-workspace.yaml`，两个设置都不能少。**

`nodeLinker: hoisted` —— `shell-ssh` 真的 `import` 了 `remote-registry`
（机器与凭据的类型、探针都定义在那边）。pnpm 默认的隔离布局不会让它看到
profile 顶层那一份，只有 hoisted 布局下 Node 才能沿目录向上走到
`~/.dsh/profiles/<name>/node_modules/@dsh-mobile/remote-registry`。
这也是约束 ① 说"四个包都要列为直接依赖"的另一半原因。

`overrides` —— 仓库内部这些包互相写的是 `workspace:*`。profile 目录不是那个
workspace，不覆盖就会报：

```
ERR_PNPM_WORKSPACE_PKG_NOT_FOUND: "@dsh-mobile/remote-registry@workspace:*"
is in the dependencies but no package named ... is present in the workspace
```

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
cp ~/.dsh/profiles/mobile/pnpm-workspace.yaml ~/.dsh/profiles/mobile-web/
printf '[]\n' > ~/.dsh/profiles/mobile-web/cordis.patch.yml
cd ~/.dsh/profiles/mobile-web && pnpm install

dsh --profile mobile-web --port 7799 --no-open
```

**这一版的 runtime 还在 Mac 上，不在设备里。** 模拟器与宿主共享网络栈，所以
`127.0.0.1` 直达；真机上那是手机自己，见下一节。

### 装到真机上

```bash
cd ios && ./deploy-device.sh
```

**前置条件，而且只能你自己做一次**：Xcode → Settings → Accounts 登录 Apple ID。
自动签名要靠这个账号去创建 App ID 和描述文件；钥匙串里有开发证书是不够的。

**`project.yml` 里的 `DEVELOPMENT_TEAM` 要填「登录账号的 team」，不是「钥匙串里
证书的 team」。** 这台机器上两者不同：钥匙串里是机构证书 `3L724S787J`，
而 Xcode 登录的是免费个人 team `4752F9442A`。填错时报的还是
`No Account for Team "…"`——看着像没登录，实际是登录的账号没有那个 team，
很容易在这里反复排查登录状态。查法：

```bash
plutil -p ~/Library/Preferences/com.apple.dt.Xcode.plist | grep -A2 teamID
```

装上之后：

- 手机要**解锁**，否则 `devicectl … process launch` 报 `BSErrorCodeDescription = Locked`。
- 第一次运行要信任证书：设置 → 通用 → VPN与设备管理 → 开发者App → 信任。
- **免费个人 team 签出来的 app 7 天后过期**，到期重跑一次 `./deploy-device.sh`。

**然后要解决地址问题。** 真机上默认的 `127.0.0.1` 指的是手机自己，必然连不上，
app 会自动弹出连接设置让你填 Mac 的局域网地址。Mac 那边要把 host 起在局域网上
（`ipconfig getifaddr en0` 拿到 IP）：

```bash
dsh --profile mobile-web --host 192.168.1.9 --port 7799 --no-open --trusted-host 192.168.1.9:7799
```

`--trusted-host` 是必须的：`/api` 有一道浏览器信任围栏，只认它认可的 authority，
手机过来的 Host 头是 `<Mac IP>:7799`，不加就被挡。

> **这会把 dsh 的接口暴露给同一个局域网，而 dsh 能执行代码。** dsh 拒绝绑
> `0.0.0.0`（原话："it would expose remote code execution to the network"），
> 绑一个具体的局域网 IP 是它允许的口子，但暴露面是一样的——用完就停掉，
> 别在公共 Wi-Fi 或不受控的办公网上开着。真正干净的解法是设备内 runtime。

连上之后想改地址：**摇一摇**，或者点开一条 `dshmobile://settings` 链接
（`?url=` 可以直接把地址填好）。

最终形态是设备内跑一个 jitless 的 Node、host 监听 app 自己的 loopback 端口——
计划在 [`docs/superpowers/plans/2026-09-04-node-ios-build.md`](docs/superpowers/plans/2026-09-04-node-ios-build.md)。
外壳这一层对此是**可替换**的：无论 host 在 Mac 上还是在 app 内的 Node 线程里，
WebView 面对的都是同一个 loopback HTTP + WebSocket 端点，加载同一份前端。
换过去时改的是 `HarnessEndpoint.current`，不是别的。

起来之后如果没配过模型凭据，会先弹"添加一个 API Key 开始使用"，输入框显示
"当前模型不可用，请先选择模型"——那是缺凭据，不是这一层的问题。

### 界面是移动布局，不是缩小的桌面版

`@dsh-mobile/client-ui-layout-mobile` 顶掉了 dsh 的三栏 `ui-layout`：
单栏 + 顶栏菜单键，侧栏改左侧抽屉，详情改底部 sheet，触控目标按 44pt 起。

**其余 32 个客户端 UI 插件一个都没改。** 它们注册的目标是 slot 名
（`sidebar` / `conversation` / `details` / `shell.overlay`），不是某个 layout 包；
新外框把这四个名字一字不差地声明出来，注册就照常落位——抽屉里那个完整的
侧栏就是原样的 `ui-sidebar`。

这一步之所以不用重建 dsh 的前端，是因为客户端 UI 插件是**运行时**从
`/plugins/<包名>/client.js` 拉的（`dsh-client-modules` 的 Node 半边扫描已启用
的 Loader 条目，找带 `dsh.client` 的包）。禁掉一行、插进一行就换掉了。

代价是这个包**必须连主题投影一起接管**：把设计令牌写进 `document.body`
这件事 dsh 是顺手放在 layout 包里做的。不接的话不是"主题不对"，是所有
`--dsw-*` 变量没人写，整个界面全部掉成无样式。

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
- **移动布局插件手抄了 dsh 的 slot 契约，没有类型保证。** 它不 import
  `dsh-client-ui-layout`（装上时那个包是禁用的，且 client bundle 自包含），
  所以 slot 名/kind/scope 与 `ILayout` 方法集都是照 `.d.ts` 抄的。抄错或
  dsh 升级后契约变了，**不会有编译错误**——表现是那一格的注册全部落空、
  界面空白且无报错。`tests/unit/contract.test.ts` 拿真实安装里的 `.d.ts`
  对账就是为了兜住这一点，但它依赖 dsh 装在 Homebrew 的默认路径，
  换路径就会 skip。
- **底部 sheet 只能点把手关闭，不能下拉。** 没做拖拽手势。
- **真机上开了 `NSAllowsArbitraryLoads`。** 用户填的局域网地址是明文 HTTP，
  而 `NSAllowsLocalNetworking` 覆盖不到 `192.168.x.x`（它只放行无限定主机名、
  `.local` 和链路本地地址）。这个 app 只加载用户填的那一个 URL，所以放开的面
  就是那一个地址；设备内 runtime 落地后地址回到自己的 loopback，这条该删。
- **摇一摇叫设置没测过。** 无头环境触发不了摇动手势。可测的那条入口是
  `dshmobile://settings`，已验证；真机上摇一摇如果不灵，用它兜底。
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
