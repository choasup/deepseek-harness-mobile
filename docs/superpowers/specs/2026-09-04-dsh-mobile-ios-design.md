# 纯血手机版 harness（iOS）设计

日期：2026-09-04
状态：设计已确认，待转实施计划
基线：dsh `0.1.1-rc.2`

## 1. 一句话

把 DeepSeek Harness 的 **runtime 本体**跑在 iPhone 上——agent 循环、会话状态、技能、子 agent 全部在设备内——手机同时提供云端 agent 永远拿不到的 I/O（BLE、相机、Files、定位、通知），而需要真 shell 的重活通过纯 JS 的 SSH 派给用户自己配置的云端机器。

**形态：手机是大脑和感官，云端是手。**

这不是"把桌面 harness 缩小塞进手机"。缩小版没有存在意义（不如远程连电脑）。这个形态有意义，因为它拥有手机独占的 I/O，同时不放弃真正的执行能力。

## 2. 目标与非目标

### 目标
- dsh host runtime 在 iOS 设备上原生运行，离线保持会话与 agent 循环
- 数据分析 / 生成 PPT / 生成文档等"出材料"的活，在设备本地完成
- 通过 SSH 连接用户自己配置的云端机器执行重活（编译、测试、Python、GPU 推理）
- 远程机器的配置在手机上足够方便（不需要手打私钥）
- 为后续接入 BLE / 相机等硬件生态留好插件位

### 非目标（v1 明确不做）
- 上架 App Store（自签安装即可，因此不受审核约束）
- 后台长时间自主运行（iOS 后台仅给数分钟即挂起；v1 接受前台运行）
- 在设备本地跑 Python / WASM（jitless V8 关闭了 WebAssembly，见 §3）
- 在设备本地起任何进程（iOS 物理上不允许，见 §3）
- Android

## 3. 可行性实证

设计前在 Mac 上（Node 22.23.2）做了两组实测，用来证伪最大的两个假设。

### 3.1 jitless 不是障碍（实测）

iOS 第三方 app 拿不到 `dynamic-codesigning` entitlement，V8 只能以 jitless 模式运行。实测 `node --jitless` 下的 dsh：

| 负载 | JIT | jitless | 倍数 |
|---|---|---|---|
| dsh 完整插件树启动（headless profile，热缓存） | 0.50s | 0.67s | **1.3x** |
| JSON parse/stringify ×20000 | 11ms | 11ms | **1.0x** |
| 正则扫描（grep 类负载） | 30ms | 84ms | 2.8x |
| 数值热循环 ×3×10⁷ | 142ms | 608ms | 4.3x |

**结论**：常说的"jitless 慢 3–10 倍"只对最后一行成立。agent harness 的负载画像是前两行——模块加载、JSON 编解码、等网络。启动实测中 jitless 甚至稳定快于 JIT 冷启动（JIT 自身的编译开销在短生命周期里是净亏）。

需留意：正则的 2.8x 会让 `tool-fs-search` 在大目录上变慢。手机上不存在 monorepo，可接受。

**副作用（硬约束）**：jitless 模式下 `typeof WebAssembly === "undefined"`。V8 把 WASM 整个关闭。**这排除了在设备上跑 Pyodide / wasm 工具链的一切可能**，Python 只能走云端。

### 3.2 iOS 没有本地进程（架构约束）

两层锁，都无法绕过：

1. **沙箱**：iOS 容器沙箱拒绝 `process-exec`。`fork()` 在 iOS 不工作，`posix_spawn()` 能编译但运行时被拒。（与 macOS 不同——macOS 沙箱 app 可以 spawn 继承沙箱的子进程。）
2. **代码签名（AMFI）**：即使绕过沙箱，也只能执行签名链在本 app team 内的可执行文件。外部下载的二进制会被 AMFI 拒绝执行。

这就是 iOS 上不存在 Termux 的原因。理论上的替代（`dlopen` 已签名 framework 假装 exec，如 ios_system；或 WASM 解释外部二进制，如 a-Shell）均不适用：前者命令集在打包时写死且无进程隔离，后者被 §3.1 的 WASM 禁用直接排除。

**因此 v1 不尝试在设备上提供 shell。shell 在云端。**

### 3.3 插件存活扫描（源码实测）

对 dsh 各插件 grep `node:child_process` / `worker_threads` / `node-pty` / MCP transport：

| 插件 | 依赖 | iOS |
|---|---|---|
| `dsh-tool-fs` / `dsh-tool-fs-search` | 无子进程调用，纯 JS | 活 |
| `dsh-tool-str-replace-editor` | 纯 JS | 活 |
| `dsh-subagent-spawn-in-process` / `-fork-in-process` | 进程内 | 活（多 agent 保得住） |
| `dsh-jobs-local` | 无子进程调用 | 活 |
| `dsh-code-runtime-worker-thread` | `worker_threads` | 活（需在 spike 中验证 iOS 上 worker 可用） |
| `dsh-mcp-client` | `StdioClientTransport` + `StreamableHTTPClientTransport` | 部分：HTTP 活，stdio 死 |
| `dsh-terminal` | `node-pty` | 死 |
| `dsh-subprocess-local` | `node-pty` + `node:child_process` | 死 |

**结论：除"起本地进程"外，dsh 的骨架完整存活。**

### 3.4 必须自己编译 Node（无现成方案）

- [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) 社区 fork 仍在维护（2026-04 有更新），但版本停在 **Node 18.20.4**
- dsh 代码实测使用：`AbortSignal.any`（32 处，需 Node 20.3+）、`loadEnvFile`（3 处，需 20.12+）、**`node:sqlite`（9 处，需 22.5+ 内置模块）**

Node 18 因此被彻底排除。必须把 iOS 构建补丁抬到 Node 22.19+ 或 24。

好消息：[V8 上游官方支持 iOS 交叉编译](https://v8.dev/docs/cross-compile-ios)（`target_os="ios"` + jitless + `v8_monolithic` + `v8_use_external_startup_data=false`），nodejs-mobile 的 gyp 补丁思路公开。这是**照已知路径抬版本**的工程活，不是研究性风险。

**这是全项目唯一的真风险点，因此 spike 优先做它（§7）。**

## 4. 架构

```
┌─ iPhone ──────────────────────────────────────────┐
│  Swift 壳                                          │
│  ├── NodeMobile24.xcframework    ← 需自建 (§5.1)   │
│  │   └── dsh host runtime（cordis 插件树）          │
│  │       ├── agent loop / session / skill / plan   │
│  │       ├── tool-fs / tool-fs-search      纯 JS   │
│  │       ├── subagent（进程内）                     │
│  │       ├── dsh-terminal-ssh    ← 新写 (§5.3)     │
│  │       └── dsh-remote-registry ← 新写 (§5.4)     │
│  ├── WKWebView → http://127.0.0.1:<port>           │
│  │   └── dsh client（33 个 UI 插件，layout 换移动版）│
│  └── 原生桥：loopback HTTP（BLE/相机/Files） (§5.5) │
└────────────────────┬──────────────────────────────┘
                     │ ssh2（纯 JS，TCP）
              ┌──────▼────────┐
              │  用户的云端机器 │ 真 shell / Python / GPU
              └───────────────┘
```

三条通信边界：
- **WKWebView ↔ Node**：loopback HTTP + WebSocket，复用 dsh 现成的 `dsh-client-connection`（HTTP-up / WebSocket-down）协议，零改动
- **Node ↔ Swift 原生能力**：Swift 侧起 loopback HTTP 服务，Node 用 `fetch` 调用。**v1 因此不需要编译任何 Node-API 原生模块**，把交叉编译的痛苦限制在 Node 本身一处
- **Node ↔ 云端**：`ssh2`（纯 JS，仅需 TCP socket 与 crypto，两者 iOS 均提供）

关于前端技术栈的一个事实：**WKWebView 内的 JS 是有 JIT 的**（WebKit 拥有 `dynamic-codesigning` 特权，运行在独立的 Web Content 进程）。前端不受 Node 侧 jitless 影响。因此"用 web 技术渲染 UI"与性能无关。

## 5. 组件

### 5.1 `NodeMobile24.xcframework`（构建产物）

- 目标：Node 24（退路 22.19）交叉编译为 iOS 静态库，arm64-ios + arm64-ios-simulator
- V8 配置：`target_os="ios"`、`target_cpu="arm64"`、jitless、`v8_monolithic=true`、`v8_use_external_startup_data=false`
- 需随行：libuv（Darwin，天然支持）、OpenSSL for iOS、SQLite（`node:sqlite` 所需，纯 C）
- 被排除的原生依赖：`node-pty`、`koffi`、`sharp`、`node-addon-landlock-run`、`node-addon-require-builtin` —— 均只服务于被禁用的插件，或有纯 JS/原生桥替代（图像处理交给 iOS 原生，见 §5.5）

### 5.2 `dsh-mobile-app` bundle（profile 补丁）

一个 `cordis.patch.yml`，按 id 打补丁。这是 dsh 的常规扩展方式，**不改核心**。

**禁用**（依赖本地进程）：
`tool-bash` · `tool-pwsh` · `bash-sandbox` · `pwsh-sandbox` · `subprocess` · `terminal-bash` · `tmux-context` · `sandbox`

`sandbox`（`dsh-sandbox-local`）在 iOS 上无意义（landlock 是 Linux，sandbox-exec 是 macOS），替换为 no-op provider——iOS app 容器本身就是沙箱边界。`fs-sandbox` 与 `sandbox-policy` 保留，workspaceRoot 指向 app 容器内的工作目录。

**保留**：`tool-fs` · `tool-fs-search` · `tool-str-replace-editor` · `subagent-*-in-process` · `skill` 全家 · `tool-web` · `jobs` · `code-runtime-worker-thread` · `compaction-*` · `plan-mode` · `goal` · `tool-todo` · `session-*`

**收窄**：`mcp-client` 仅允许 `StreamableHTTPClientTransport`，禁 stdio

**新增行**：`terminal-ssh`（§5.3）· `remote-registry`（§5.4）

### 5.3 `dsh-terminal-ssh`

`dsh-terminal` 是服务接口，`dsh-terminal-bash` 只是它的一个 provider。新写一个 SSH provider 是这套架构的常规操作。

- 基于 `ssh2`（纯 JS；可选的 `cpu-features` 原生加速不装也能跑）
- 提供与 `dsh-terminal-bash` 相同的接口契约：执行命令、流式输出、超时、取消
- 支持持久会话（复用一条 SSH 连接的多个 channel），对应 `tool-bash-persistent` 的语义
- 连接复用与自动重连；断线时向 agent 返回明确的可恢复错误
- 支持注册多个命名实例（`gpu-h20`、`build-box` …），见 §5.4

**服务器侧零安装**——只需要有 sshd。这对"用户自己配置"是决定性优势。

### 5.4 `dsh-remote-registry`（远程机器配置）

复用 dsh 现成机制，不新造配置系统。先例：ADP 插件的 `client/index.tsx` 用 `slots.inject('settings.plugin.item', ...)` 注册设置卡片，凭据走 `credentials.set` 落到 `$DSH_HOME/.credentials.yaml`。

**录入方式（v1）**：

1. **剪贴板导入（主路径）**：Mac 上 `dsh remote export` 往剪贴板写一段 `dsh-remote://…`，iPhone 靠 Universal Clipboard 直接粘贴导入。零网络、零扫码，对 Mac + iPhone 用户最省事。
2. **手填（兜底）**：host / port / user / 粘贴私钥。

**二维码 enrollment 推迟到 v2**（见 §9），因为它需要相机原生桥 + 服务器侧脚本。届时的握手设计为：二维码携带 `{host, port, user, 一次性 token(5min), 服务器主机公钥指纹}`，**不含私钥**；手机本地生成 ed25519 密钥对存入 iOS Keychain，用 token 换一次上传把公钥写进 `authorized_keys`。二维码被拍到也无用，私钥从不离开设备。

**连接探针（v1 必须有）**：配置保存后立即执行并显示结果——

```
TCP 可达 (82ms) → SSH 握手 + 主机指纹匹配 → uname → nvidia-smi → 环境检查
```

手机上排错成本极高，必须在配置时暴露问题，而不是等 agent 第一次调工具才炸。探针顺带采集机器特有环境（代理设置、venv 路径、GPU 型号与空闲显存）并缓存，供 agent 使用。

**多机器与路由**：注册表支持多台，每台带标签（`gpu` `cuda` `build`）。session 级绑定一台；标签路由（"跑推理"自动选 `gpu`）推迟到 v2。

**可达性**：v1 仅支持公网直连或用户已有的系统级 VPN。NAT 穿透（Tailscale / Cloudflare Tunnel 的 ssh-over-WebSocket，`ssh2` 支持传入自定义 socket）作为可选 transport 推迟。

### 5.5 iOS 原生桥

Swift 侧 loopback HTTP 服务，Node 用 `fetch` 调用。v1 提供：

- **Files 访问**：`UIDocumentPicker` + security-scoped bookmark，让 agent 能读写 app 容器外的用户文档（iCloud Drive 上的笔记、PDF 等）
- **图像光栅化**：替代 `sharp`。JS 侧出 SVG，原生侧用 Core Graphics 光栅化为 PNG——比原生依赖干净
- **通知**：任务完成时推本地通知

BLE（CoreBluetooth）与相机/二维码推迟到 v2（§9）。

### 5.6 `dsh-client-ui-layout-mobile`

dsh client 侧同样是 cordis 插件树：`dsh-client-runtime`（SlotRegistry + SessionRuntime）与 `dsh-client-connection`（传输层）均与 UI 无关；桌面味来自 `dsh-client-ui-layout` 单个包（"three-column AppFrame with drag handles"，提供 `ctx.layout` 服务）。

因此：

- 新写 `dsh-client-ui-layout-mobile` 替换该行——单栏 + 底部导航 + sheet，实现相同的 `ctx.layout` 契约
- 移动化 `sidebar` / `conversation` / `composer` 三处（触摸目标、键盘避让、滚动锚定）
- **其余 29 个 UI 插件通过 slots 原样复用**

这样 UI 是为手机设计的，同时**留在上游轨道上**——dsh 升级不需要追平一份分叉的前端。

## 6. 数据流

一轮典型对话（"看看 GPU 机上模型跑完没有，把结果做成一页 PPT"）：

1. WKWebView composer → loopback HTTP → Node 内 dsh host
2. agent loop 组装上下文（session 状态、skill、system prompt）→ 调 LLM（网络）
3. LLM 返回 tool call `bash(nvidia-smi; tail -n 50 …)`
4. `dsh-terminal-ssh` 从 `remote-registry` 取 `gpu-h20` 的连接，复用现有 SSH channel 执行，流式回传输出
5. 结果进 session（JSONL 落盘到 app 容器）→ 下一轮
6. LLM 调 `code_runtime` 在 worker thread 里用 `pptxgenjs` 生成 .pptx，写入 app 容器
7. 通过原生桥的 Files 导出，或直接系统分享

**离线行为**：步骤 2 的 LLM 调用与步骤 4 的 SSH 需要网络；其余全部本地。断网时 session 完整保留，恢复网络后继续，会话不丢。

## 7. 里程碑与止损点

"地基优先"必须有能证伪的终点。五个递进里程碑，任何一步卡住都是明确止损点：

| # | 里程碑 | 证明了什么 | 卡住时的退路 |
|---|---|---|---|
| 1 | Node 24 编出 `.xcframework`，真机上打印 `process.version` | 构建这关过了 | 退到 Node 22.19；再不行 fork nodejs-mobile 补丁到 22.x |
| 2 | 能 `import` dsh 整棵 ESM 树 | 暴露所有 iOS 不支持的 builtin | 逐个替换或禁用对应插件 |
| 3 | mobile profile 加载成功 | §5.2 的禁用清单是对的 | 补充禁用清单 |
| 4 | 完成一轮 tool call：读一个文件、写一个文件 | agent 循环在设备上活着 | — |
| 5 | **ssh2 连上云端机器跑 `nvidia-smi`，结果回到对话里** | 整个方案成立 | — |

第 5 步完成，"手机是大脑、云端是手"从构想变成既成事实。

### 7.1 实施分期

本设计跨越两个实施周期，各自出一份独立的实施计划：

| 周期 | 范围 | 完成标志 |
|---|---|---|
| **一：地基** | §5.1 Node 构建 · §5.2 mobile profile · §5.3 terminal-ssh · §5.4 remote-registry | 里程碑 1–5 全绿。此时 app 可用但 UI 是桌面布局 |
| **二：手机化** | §5.6 移动 layout · §5.5 原生桥（Files / 光栅化 / 通知） | 日常可用的手机 app |

周期一中，`dsh-terminal-ssh` 与 `dsh-remote-registry` 均不依赖 iOS，可在 Mac 上完整开发测试，与高风险的 Node 构建工作并行。

测试机器：用户已有的 GPU 机器（6×H20，公网直连，手机蜂窝网络可达）。具体地址存于 `.credentials.yaml`，不入库。

## 8. 错误处理与测试

**错误处理原则**：手机上排错成本高，错误必须在最早的时刻以可操作的形式暴露。

- 远程连接失败 → 探针给出分层诊断（TCP / 握手 / 认证 / 指纹不匹配），而非笼统的 "connection failed"
- SSH 断线 → 向 agent 返回可恢复错误并自动重连，不静默失败
- 主机指纹变化 → 硬失败并要求用户确认，绝不自动接受
- 被禁用的工具（bash 等）→ 不出现在工具列表里，而不是调用后报错

**测试策略**：

- **单元**（Mac 上跑，vitest）：`dsh-terminal-ssh` 对本地 sshd 或容器；`dsh-remote-registry` 的解析、探针分层、凭据读写
- **profile 组合测试**：`dsh --profile mobile --dump-config` 断言禁用清单生效、工具列表不含 bash
- **jitless 回归**：CI 中以 `node --jitless` 跑全部测试，防止引入依赖 JIT 或 WASM 的代码
- **设备烟测**：里程碑 1–5 作为手动检查清单

关键设计考虑：**`dsh-terminal-ssh` 和 `dsh-remote-registry` 都不依赖 iOS**，可以先在 Mac 上完整开发和测试，再随 runtime 上设备。这让 §7 的高风险构建工作与插件开发解耦并行。

## 9. 明确推迟（YAGNI）

- 二维码 enrollment + 相机原生桥（§5.4）
- BLE / CoreBluetooth 与硬件生态（EchoEar ESP32-S3 是首个目标）
- 标签路由、NAT 穿透 transport
- 后台自主执行与 Shortcuts / Siri 触发
- 跨设备会话接力（扫码把桌面会话续到手机——dsh 的 session 持久化本就设备无关，成本低但不属于 v1）
- Android

## 10. 未决问题

- `worker_threads` 在 iOS 上的可用性需在里程碑 2 验证。若不可用，`code-runtime-worker-thread` 与 `workflow-worker-thread` 需降级为主线程执行（有阻塞 UI 的风险）
- `node:sqlite` 在 iOS 构建中的可用性。base 配置为 `openAt: never`，若其 import 是惰性的则可暂时绕过
