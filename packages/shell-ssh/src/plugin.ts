/**
 * cordis 接线（Task 7）。两件事都在这个文件里，理由见下：
 *
 * 1. 把 Task 6 的 `SshShellExecutor`（结构类型、零 dsh 运行时依赖）包成一个
 *    真正 `extends ShellExecutor` 的子类，注册进 `ctx.shell`。
 * 2. 组装 `remote-registry` 的分层探针（Task 9）真正需要的 `ProbeDeps`——见
 *    `remote-registry/src/probe.ts` 顶部注释：`sshHandshake`/`exec` 只能来自
 *    这个包的连接池，但这个包已经依赖 `remote-registry`（机器/凭据类型与
 *    注册表都定义在那边），`remote-registry` 反过来 import 这个包会成环。
 *    两件事在同一时刻都齐活的地方只有这里。
 *
 * 走独立的 `@dsh-mobile/shell-ssh/plugin` 子路径导出（跟
 * `remote-registry/src/plugin.ts` 同一个理由，见 index.ts 顶部注释）：
 * `src/index.ts` 只该给 `SshShellExecutor` 的纯逻辑消费者提供零运行时依赖的
 * 类型/类，不该强迫它们连带装进 cordis、schemastery、dsh-shell、
 * dsh-credentials 这些运行时依赖。
 */
import { Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'
import { probeMachine, MACHINES_TABLE, REMOTE_DOMAIN_NAME } from '@dsh-mobile/remote-registry'
import type { ProbeDeps, ProbeOptions, ProbeReport } from '@dsh-mobile/remote-registry'
import { SshConnectionPool } from './connection.ts'
import { execRemote } from './exec.ts'
import { SshError, isSshError } from './errors.ts'
import { SshShellExecutor } from './index.ts'

export const name = 'shell-ssh'
// 只声明这个插件自己直接用到的服务——`ctx.remotes` 用来查机器/取凭据，
// `ctx.credentials` 单独声明是因为探针的 credentialSource 直接调用
// `ctx.credentials.describe()`，绕过了 ctx.remotes 这一层（同 remote-registry
// 自己的 plugin.ts 对 storageDomain/credentials 的处理方式）。
export const inject = ['remotes', 'credentials']

/** 插件配置：`ctx.remotes` 里已注册机器的 name。 */
export interface Config {
  machine: string
  /**
   * 覆盖 `start()` 后台读缓冲区的字节上限（见 index.ts 里
   * `SshShellExecutorOptions.liveBufferMaxBytes` 的文档：Task 6 特意把它做成
   * 可注入，因为"内存受限、跑在电池上的手机 profile 会想要一个比默认更小的
   * 值"）。留空则使用 `DEFAULTS.liveBufferMaxBytes`。
   */
  liveBufferMaxBytes?: number
  /**
   * 覆盖连接池的 TCP+握手总超时（见 connection.ts 里
   * `SshConnectionPoolOptions.connectTimeoutMs` 的文档，池自己的默认值是
   * 15 秒）。留空则使用连接池的默认值。
   *
   * 复审 M1：跟 `liveBufferMaxBytes` 同一类需求——手机在蜂窝网络上，延迟
   * 更高也更容易抖动，15 秒这个桌面场景下的默认值不一定适合 Task 12 的
   * mobile profile（可能想调大避免正常的高延迟被误判成连不上，也可能想
   * 调小让用户在设置页更快看到反馈）。具体数值属于 Task 12 的判断范围，
   * 这里只负责让它可配置，不替 Task 12 预先选一个值。
   */
  connectTimeoutMs?: number
}

// `z<Config>` 这个写法（`z` 既是值又是类型）是 dsh 自己包里的既有约定，见
// dsh-storage-domain/dsh-storage-json 的 `export declare const Config: z<Config>`。
// 两个字段都不调用 `.required()`——同 dsh-bash-local 自己 Config 里
// `cwd: z.string()` 的写法一致（该字段在其接口里也是 `cwd?: string`）：
// schemastery 的字段默认就是"可以整个不给"，不需要（也没有）一个显式
// `.optional()` 方法。
export const Config: z<Config> = z.object({
  machine: z.string(),
  liveBufferMaxBytes: z.number(),
  connectTimeoutMs: z.number(),
})

function describeError(err: unknown): string {
  if (isSshError(err)) return err.message
  return err instanceof Error ? err.message : String(err)
}

/** 探针诊断命令（os/gpu 两个阶段）的超时与输出上限——这两条命令的输出天然很小，不需要跟正常 exec 一样的预算。 */
const PROBE_EXEC_TIMEOUT_MS = 15_000
const PROBE_EXEC_MAX_BYTES = 64 * 1024
const DEFAULT_TCP_TIMEOUT_MS = 10_000

/**
 * `ProbeDeps.tcpReachable` 的实现：纯 `node:net`，不复用连接池——探针这一步
 * 测的就是"裸 TCP 通不通"，复用池反而会绕过真正的连接尝试（池命中缓存直接
 * 返回，测不出网络层的问题）。
 *
 * 见 ProbeOptions.signal 的文档：探针自己的超时只保证"不再等待"，不保证
 * "取消底层 socket"——这里的 `timeoutMs` 是这个函数自己独立的超时，`signal`
 * 触发时也主动 destroy 掉 socket，两条路径都要收尾，不指望调用方帮忙清理。
 */
function tcpReachable(
  machine: RemoteMachine,
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_TCP_TIMEOUT_MS,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = new Socket()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const onAbort = () => finish({ ok: false, error: 'TCP 探测已取消' })

    function finish(result: { ok: boolean; latencyMs?: number; error?: string }): void {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }

    if (signal?.aborted) {
      finish({ ok: false, error: 'TCP 探测已取消' })
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    timer = setTimeout(() => finish({ ok: false, error: `TCP 连接超时（超过 ${timeoutMs}ms 未响应）` }), timeoutMs)

    socket.once('error', (err: Error) => finish({ ok: false, error: err.message }))
    socket.once('connect', () => finish({ ok: true, latencyMs: Date.now() - start }))
    socket.connect(machine.port, machine.host)
  })
}

/**
 * `ProbeDeps.credentialSource` 的实现：`ctx.credentials.describe()`，**不是**
 * `resolve()`——探针只需要"配置与否/来源/能不能写"三个事实，不该经手密钥原文。
 * 见 probe.ts 里 `ProbeDeps.credentialSource` 的文档注释。
 *
 * `isCredentialRefName` 防的是手工改过磁盘 json 文件、`keyRef` 不合法的机器
 * 记录——`credentialRef()` 对不合法的名字抛裸 TypeError，不该让这种输入直接
 * 冒泡出探针；对齐 remote-registry/plugin.ts 的 `readSecret` 同一处理。
 */
async function credentialSourceOf(
  ctx: Context,
  machine: RemoteMachine,
): Promise<{ configured: boolean; source?: string; writable: boolean }> {
  if (!isCredentialRefName(machine.keyRef)) return { configured: false, writable: true }
  const info = await ctx.credentials.describe(credentialRef(machine.keyRef))
  return { configured: info.configured, source: info.source, writable: info.writable }
}

/**
 * 组装 `remote-registry` 探针真正需要的 `ProbeDeps`。见 probe.ts 顶部注释：
 * 依赖方向决定了这只能在这个包（同时依赖 remote-registry 类型与 ssh2 连接池
 * 的地方）组装，不能反过来从 remote-registry import 这个包。
 *
 * `sshHandshake`/`exec` 复用传入的连接池，而不是每次探针另起一条连接——池
 * 按 `user@host:port` 复用连接，探针跟正常 exec 走同一条已经建立、已经验证
 * 过指纹的连接是期望行为，也避免每次探针都重新走一遍凭据解析、握手。
 */
export function createProbeDeps(ctx: Context, pool: SshConnectionPool): ProbeDeps {
  return {
    tcpReachable: (machine, signal) => tcpReachable(machine, signal),

    credentialSource: (machine) => credentialSourceOf(ctx, machine),

    // `pool.acquire()` 不接受 signal——连接池不支持取消一次进行中的握手，
    // 见 ProbeOptions.signal 的文档："probeMachine 内部会把它...一起传给
    // 每个 dep 调用——deps 是否真的响应这个信号去释放底层资源是它们自己的
    // 事"。这里如实反映：探针放弃这次握手的等待，但握手本身可能还在后台跑。
    sshHandshake: async (machine) => {
      try {
        await pool.acquire(machine)
        // acquire() 成功之后，池里一定记录了这次握手实际观测到的指纹——
        // observedFingerprintFor() 就是为这个探针场景存在的（见 connection.ts
        // 的文档注释）。
        return { ok: true, fingerprint: pool.observedFingerprintFor(machine) }
      } catch (err) {
        return { ok: false, error: describeError(err) }
      }
    },

    exec: async (machine, command, signal) => {
      try {
        const client = await pool.acquire(machine)
        const result = await execRemote(client, {
          command,
          timeoutMs: PROBE_EXEC_TIMEOUT_MS,
          stdoutMaxBytes: PROBE_EXEC_MAX_BYTES,
          stderrMaxBytes: PROBE_EXEC_MAX_BYTES,
          signal,
        })
        if (result.exitCode === 0) return { ok: true, stdout: result.stdout }
        // 非零退出：把 stderr（或者一个兜底说明）当成 error 带回去，而不是
        // 直接吞成一句笼统的"失败"——probe.ts 的 runGpuStage 依赖这条信息
        // 来区分"没装 nvidia-smi"和"驱动坏了"这两种截然不同的情况。
        const detail = result.stderr.trim() || (result.timedOut ? '命令超时' : `退出码 ${result.exitCode ?? '(信号终止)'}`)
        return { ok: false, stdout: result.stdout, error: detail }
      } catch (err) {
        return { ok: false, stdout: '', error: describeError(err) }
      }
    },
  }
}

/**
 * 供设置 UI 调用：对 `ctx.remotes` 里已注册的某台机器跑一遍分层探针。
 * 未知机器名映射成 `SSH_NO_MACHINE`——跟这个包连接池对"注册表里没有这台
 * 机器"这件事使用同一个错误分类，虽然探针不经过 `pool.acquire()` 那条查找
 * 路径，但"机器不存在"这件事本身理应是同一个错误码。
 *
 * 每次调用起一个只为这次探针存在的连接池，用完在 `finally` 里释放——UI 只
 * 需要传一个机器名，不需要知道连接池这个实现细节，也不用操心它的生命周期。
 * 独立于 `ctx.shell` 背后可能已有的那个池：探针要测的是"现在这份配置到底
 * 通不通"，复用一条可能早就建立好的缓存连接会掩盖凭据/主机指纹自上次连接
 * 以来发生的变化。
 */
export async function probeConfiguredMachine(
  ctx: Context,
  machineName: string,
  options?: ProbeOptions,
): Promise<ProbeReport> {
  const machine = await ctx.remotes.get(machineName)
  if (!machine) throw new SshError(`未知机器 '${machineName}'`, 'SSH_NO_MACHINE', false)
  const pool = new SshConnectionPool({
    credentials: (m) => ctx.remotes.credentialsFor(m),
  })
  try {
    return await probeMachine(machine, createProbeDeps(ctx, pool), options)
  } finally {
    await pool.disposeAll()
  }
}

/** 探针可能挂载的最小 systemPrompt 结构类型——见 apply() 里的用法与其注释。 */
interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): () => void
}

/**
 * Task 7 复审 I1 的渲染逻辑：把一个带 partial 输出的 `SshError` 变成一段
 * 人类/model 都能读的文本——见 `run()` 上的文档注释，这是那个缺口的落地
 * 实现，不是新增信息源。
 *
 * 重试建议基于 `started` 而不是 `recoverable`：`recoverable` 对 model 不
 * 可见（同样只有 `.message` 会被渲染），而且 `SSH_DISCONNECTED` 的
 * `recoverable` 恒为 `true`（"连接本身"这一层值得重试）——但那不等于"这条
 * 具体命令"安全重试：一条非幂等命令可能已经在断线前半途生效。`started`
 * 才是回答"这条命令能不能安全重试"的字段（见 errors.ts 的文档）。
 */
function renderDisconnectMessage(err: SshError): string {
  const parts = [err.message]
  if (err.started === true) {
    parts.push(
      'This command had already reached the remote host and may have partially executed'
      + ' — do not retry it automatically.',
    )
  } else if (err.started === false) {
    parts.push('This command never reached the remote host — retrying is safe.')
  }
  if (err.partialStdout) parts.push(`[stdout before disconnect]\n${err.partialStdout}`)
  if (err.partialStderr) parts.push(`[stderr before disconnect]\n${err.partialStderr}`)
  return parts.join('\n\n')
}

/**
 * cordis 适配层：把 Task 6 的 `SshShellExecutor` 包成真正 `extends
 * ShellExecutor` 的子类，在这一层做类型对齐——`SshShellExecutor` 自己故意
 * 不 extends ShellExecutor（见 index.ts 顶部注释：真的继承需要一个真
 * Context，会强迫那个包的每个单测都启动整个 dsh/cordis 运行时）。
 *
 * `resolve()`/`run()`/`start()` 全部转发给 `this.inner`；这里唯一做的
 * 类型层面的事是把 `ExecSpecLike`（没有 `sandboxPolicy`/`dshEnv` 字段）
 * 对齐成真正的 `ShellExecSpec`（`sandboxPolicy` 是必填字段，即使值允许是
 * undefined）。
 *
 * `dshEnv` 缺口：`request.dshEnv` 既不读也不转发——`ExecRequestLike` 结构
 * 类型上没有这个字段，多出来的字段被原样忽略，编译期不报错。这是刻意的
 * 决定，不是疏漏：正确实现需要在这一层记住上一次调用往远端 export 过哪些
 * `DSH_*` key、下一次调用前先 `unset` 掉不在最新快照里的那些，但
 * `exec.ts` 的 `buildRemoteCommand()` 没有 unset 通道，补一个只在这里
 * 独立拼接、绕开已验证过的引用转义逻辑的 unset 语句风险比不做更大。完整
 * 推理和 model 端能感知的效果见本包 README 的 "Known Limitations" 一节，
 * 不在这里重复。
 */
class CordisSshShellExecutor extends ShellExecutor {
  private readonly inner: SshShellExecutor

  constructor(ctx: Context, pool: SshConnectionPool, machine: RemoteMachine, liveBufferMaxBytes?: number) {
    super(ctx)
    this.inner = new SshShellExecutor({ pool, machine, liveBufferMaxBytes })
  }

  get sandboxMode(): undefined {
    return this.inner.sandboxMode
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    const spec = this.inner.resolve(request)
    // sandboxPolicy 是 ShellExecSpec 上的必填字段（值本身允许 undefined）——
    // SSH 执行不做任何本地沙箱，`undefined` 是唯一诚实的值，见 index.ts 里
    // `SshShellExecutor.sandboxMode` 的文档：dsh-tool-bash 在 sandboxMode
    // 为 undefined 时压根不会往请求上放 sandboxPolicy，这里显式补一个
    // undefined 值，跟"什么都没放"完全等价，不会被下游误读成一种沙箱状态。
    return { ...spec, sandboxPolicy: undefined }
  }

  /**
   * Task 7 复审 I1：连接丢失时 `inner.run()` reject——这正是 `ShellExecutor`
   * 的文档契约（"rejects only for infrastructure failures"），继续原样向上
   * 传播，不在这一层吞掉或者改写成一个编造的 `ShellRunResult`（见 index.ts
   * 里 `SshShellExecutor.run()` 的文档注释）。
   *
   * 但"原样传播"曾经是字面意义上的"什么都不做"——`SshError` 上真实携带的
   * `partialStdout`/`partialStderr`（execRemote() 断线前已经收集到的输出，
   * Task 5 特意花力气保留下来的那份"构建打印了 200 行然后掉线"的数据）
   * 从来没有被任何读者看到过：`dsh-tool-bash` 对 `ctx.shell.run(...)` 的
   * 调用没有 try/catch（`dsh-tool-bash/lib/index.js` 里那次 `await` 是
   * 裸的），`dsh-tools` 对工具调用抛出的异常只读 `.message` 去渲染给
   * model（`dsh-tools/lib/index.js` 的文档原话："Error instances use
   * `.message`"）——两者叠加意味着这两个字段以前只活在错误对象上，从未
   * 被渲染过、从未被 model 看到过。测试当时断言 `err.partialStdout` 这个
   * 字段本身存在，证明了"数据没丢"，但没证明"数据被看到了"，这正是这个
   * 缺口曾经看起来像已经做完的原因。
   *
   * 现在改成：`isSshError` 且真的带了非空的 partial 输出时，把原始
   * message、一句根据 `started` 得出的重试建议、以及打了标签的 partial
   * 输出，一起烧进新抛出的 `SshError` 的 `message` 里——message 是这条
   * 链路里唯一真正会被渲染的字段。`code`/`recoverable` 原样保留；
   * `started`/`partialStdout`/`partialStderr` 也原样保留在新错误对象上
   * （不是新信息，只是不再是唯一的载体）。
   */
  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    try {
      return await this.inner.run(spec)
    } catch (err) {
      if (isSshError(err) && (err.partialStdout || err.partialStderr)) {
        throw new SshError(renderDisconnectMessage(err), err.code, err.recoverable, {
          started: err.started,
          partialStdout: err.partialStdout,
          partialStderr: err.partialStderr,
        })
      }
      throw err
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    return this.inner.start(spec)
  }
}

/**
 * 连接池自身完全不带存活探测的默认值（ssh2 的 `keepaliveInterval` 默认
 * 是 0——关闭）。这个包存在的理由就是手机在 Wi-Fi/蜂窝网络之间切换时的
 * 黑洞连接——对端不再响应任何东西，但本地 socket 表面上还"活着"。关掉
 * keepalive 意味着唯一能发现连接已经死了的时机是"下一次真的往这条连接上
 * 发数据"，而两次调用之间连接可以无限期地假装健康。这里给出一组固定的
 * 默认值（不通过 Config 暴露）：让 ssh2 自己按周期发 keepalive 包，连续
 * `keepaliveCountMax` 次没有回应就主动判定连接已死、触发 'error'/'close'，
 * 池照常摘除、下次 acquire() 重新连接——不需要等到用户真的发起一次命令
 * 才发现连接早就断了。
 *
 * 不通过 Config 暴露（跟 connectTimeoutMs/liveBufferMaxBytes 不同）：那两个
 * 字段的"手机场景要一个不同的值"是具体、双向的（可能想调大也可能想调小，
 * 取决于网络/UX 取舍）；keepalive 存不存在这件事本身没有类似的"某个方向
 * 更适合手机"的论证，一组固定的、比 ssh2 默认值（完全关闭）更安全的默认
 * 组合已经解决了这里要解决的问题。
 */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000
const DEFAULT_KEEPALIVE_COUNT_MAX = 3

/**
 * cordis 插件入口。
 *
 * **这条注释取代了 Task 7 原来的设计**（原文是"`config.machine` 必须已经在
 * `ctx.remotes` 里注册过，否则整个插件的加载失败并抛出 `SSH_NO_MACHINE`——
 * 快速失败好过悄悄挂着一个永远报错的 `ctx.shell`"）——那个设计有一个 Task 7
 * 没有验证过的后果：这个插件是作为 dsh-mobile 的 `mobile-app` bundle 里的一
 * 个普通 Loader 条目挂载的，`@deepseek-ai/dsh-app-boot` 的 `boot()` 在整棵
 * 插件树装完之后会跑 `assertEntriesActivated()`——**任何一个已启用条目没有
 * 变成 ACTIVE（哪怕只是因为它自己 `apply()` 同步 throw），整个 `dsh` 进程
 * 都会 `exit(1)`**，不只是这一个条目失效。全新 profile 的 `remote-registry`
 * 必然是空的，所以这里一 throw，`dsh --profile mobile` 会在任何调用
 * （包括 `--help`）上崩溃退出，直到用户配置好一台机器——参见
 * `packages/mobile-app/cordis.patch.yml` 里原本因此把这一行整体
 * `disabled: true` 的注释。
 *
 * 新设计把"没有退化模式"这条约束落回到**只对这一个插件条目**成立，而不是
 * 让它连累整棵树：`config.machine` 查不到时，`apply()` 正常返回（不 throw、
 * 不挂 `ctx.shell`），只记一条 `ctx.logger.warn`。这个条目本身的 fiber 照常
 * 变成 ACTIVE——它就是"什么都没提供"的一个安静插件，跟"没装某个可选
 * provider"没有本质区别。Task 7 那句话真正要保的东西——"永远不要让
 * `ctx.shell` 存在、但每次调用都报错"——这个新设计满足得更彻底：没有机器时
 * `ctx.shell` 根本不存在，而不是存在一个必错的实现。下面的 systemPrompt 段
 * 落注册（原来就在这之后）现在天然地跟 `ctx.shell` 的注册"同生共死"：机器
 * 查不到时两者都不注册，模型不会被告知一套跟它实际能力对不上的远程 bash
 * 语义。
 *
 * 反过来，`ctx.shell` 缺失时下游会怎样，取决于消费者自己的 inject 声明：
 * `@deepseek-ai/dsh-tool-bash` 对 `shell` 是硬 inject（`["tools", "shell",
 * "systemPrompt", "shellEnv"]`），缺了它整个 tool-bash 条目的 fiber 会停在
 * PENDING——**这本身也会被 `assertEntriesActivated` 当成启动失败**（同一份
 * repro：一个只声明 `inject: ['neverProvided']`、永远等不到那个服务的插件，
 * `boot()` 照样 throw "N entries did not activate: ...: pending (waiting for
 * services: ...)"）。所以 tool-bash 这一行**不能**跟这个插件一样简单地
 * "留着但永远不激活"——是否把 tool-bash 保持 enabled，是 mobile-app 那份
 * `cordis.patch.yml` 需要单独决定的事，取决于当时的组合里还有没有别的东西
 * 会一直注入 `shell`；这个包本身只保证"没配置机器时不崩、不误导模型"。
 */
/**
 * 真正把执行器挂上去：建连接池、注册 `ctx.shell`、贡献 system prompt。
 *
 * 抽成函数是因为它有**两个调用时机**：`apply()` 里机器已存在时立刻调用；
 * 或者机器当时还没注册，等 `domain/changed` 报告它被写入后再调用（见 `apply()`）。
 * 两条路径必须做完全相同的事，所以只能有一份实现。
 */
function mountExecutor(ctx: Context, config: Config, machine: RemoteMachine): void {
  const pool = new SshConnectionPool({
    credentials: (m) => ctx.remotes.credentialsFor(m),
    connectTimeoutMs: config.connectTimeoutMs,
    keepaliveInterval: DEFAULT_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: DEFAULT_KEEPALIVE_COUNT_MAX,
    // Task 7 复审 M2：这个钩子存在好几轮 review 才成型（见 connection.ts
    // 的文档），但在这之前从没有任何调用方真正提供它——池检测到的每一次
    // 意外断线都被无声吞掉了。这里至少把它接到日志上：一次断线本身不是
    // 这个插件能自动处理的事（重连是下一次 acquire() 自然发生的），但
    // "发生过"这件事值得被看到，尤其是在排查"model 说连不上但我看着服务器
    // 好好的"这类问题时。
    onDisconnect: (m, error) => {
      ctx.logger.warn(
        'shell-ssh: 到 %s (%s@%s:%s) 的连接意外断开%s',
        m.name,
        m.user,
        m.host,
        m.port,
        error ? `：${error.message}` : '',
      )
    },
  })
  // 插件的 fiber 被 dispose（重载/组合拆卸）时释放连接池——disposeAll() 会
  // 等到每条连接真的触发 'close' 才 resolve（见 connection.ts 的注释），
  // cordis 的 dispose 链会等这个 Promise。
  ctx.effect(() => () => pool.disposeAll())

  // Service 的构造函数会自己调用 ctx.reflect.provide('shell', ...)——不需要
  // （也不应该）像 remote-registry/plugin.ts 那样手动 ctx.provide()，那是
  // 给不继承 Service 的类用的写法。
  new CordisSshShellExecutor(ctx, pool, machine, config.liveBufferMaxBytes)

  // Task 7 复审 I2：机器名这件事必须让 model 知道，但不能通过 stderr（见
  // index.ts 里 `SshShellExecutor` 类文档）。这里原来用 `ctx.get('systemPrompt')`
  // ——被证明是错的：`ctx.get()` 是一次性快照，只在 systemPrompt 恰好已经
  // 先于这个插件挂载时才拿得到东西。在真实的（并发初始化的）Loader 组合
  // 里，这个插件的 fiber 只要 `remotes`+`credentials` 一齐活就会解除阻塞，
  // 没有任何东西保证 dsh-system-prompt 排在它前面——`systemPrompt` 后挂载
  // 时，`ctx.get()` 拿到的是 `undefined`，且**永久**如此：`apply()` 只跑
  // 一次，不会因为 systemPrompt 后来才出现而重新执行。第二种失败模式：
  // `section()` 的注册"随调用它的 fiber 一起被 dispose"，一次 systemPrompt
  // 重载会清空它自己的注册表，这个插件贡献过的 section 不会被重放——
  // 一次性的 `ctx.get()` 调用完全没有机会补上这一次。
  //
  // 正确的原语是 `ctx.inject()`（cordis/lib/types/registry.d.ts 的原话：
  // "Run a callback once the requested services are available… the callback
  // is unloaded and re-run whenever a required service changes"）——它是
  // 当前 fiber 之下的一个**子 fiber**，既会在 systemPrompt 稍后才出现时
  // 才触发，也会在 systemPrompt 重载时重新跑一遍（重新贡献这个 section），
  // 而且不阻塞父 fiber（`apply()` 不 await 它）：没有挂 dsh-system-prompt
  // 的组合（比如这个包自己的大部分单测）里，这个 inject 永远不会触发，但
  // `apply()` 早就正常跑完了，`ctx.shell` 照常可用。`.catch()` 只是不让一次
  // 意外的注册失败（比如撞上重复的 section 名）变成一个没人处理的 rejection
  // ——记一条日志，不吞掉信息也不让它拖垮别的东西。
  // `ctx.inject()` 返回 `Fiber & PromiseLike<Fiber>`——一个 duck-typed
  // thenable，只有 `.then()`，没有真正 Promise 的 `.catch()`；用
  // `Promise.resolve(...)` 转成一个真 Promise 再挂 `.catch()`。
  void Promise.resolve(
    ctx.inject(['systemPrompt'], (child) => {
      const systemPrompt = (child as unknown as { systemPrompt: SystemPromptLike }).systemPrompt
      systemPrompt.section({
        name: 'shell-ssh:machine',
        // Task 7 复审 M3：不是 100——100 是 dsh-tool-fs 的 'tool:read'，
        // 用 100 会跟它正面撞上。dsh-tool-bash 自己的标准指导用的是 105
        // （`dsh-tool-bash/lib/index.js`），这段文字是在补充/限定 bash 指导
        // 而不是独立的一条，排在它之后才对，所以选 106。
        order: 106,
        text:
          `Bash commands run over SSH on the remote machine '${machine.name}' `
          + `(${machine.user}@${machine.host}:${machine.port}) — a DIFFERENT filesystem and process `
          + 'space than the one running this harness: local paths, installed tools, and running '
          + 'processes here do not exist there, and vice versa. A lost connection surfaces as a '
          + 'tool-call error, not a command result; the error message states whether retrying is safe. '
          + 'When a background job\'s status becomes "killed" due to connection loss, that means the '
          + 'SSH connection was closed, not that the remote process was necessarily terminated: a '
          + 'plain (non-PTY) exec channel does not reliably let the remote host reap the process, so '
          + 'a command that forked children (e.g. a background build) may still be running there.',
      })
    }),
  ).catch((err: unknown) => {
    ctx.logger.error(
      'shell-ssh: 向 systemPrompt 贡献机器名说明失败：%s',
      err instanceof Error ? err.message : String(err),
    )
  })
}

/**
 * 插件入口。
 *
 * **未注册机器时不会失败，也不会注册 `ctx.shell`。** 这是 Task 12 定下的形态，
 * 经两轮实测：`dsh-app-boot` 的 `assertEntriesActivated()` 把 PENDING 的 fiber
 * 当 FAILED，所以"挂载但抛错"和"让 tool-bash 挂着等一个永不出现的 shell"
 * 两种做法都会让**整棵插件树**起不来（连 `dsh --profile mobile --help` 都
 * exit(1)）。不提供服务则相反：`tool-bash` 注入 `shell`，拿不到就安静地不激活，
 * 模型也就不会看到一个必然失败的工具。
 *
 * 机器稍后才被注册时，不需要重启：本函数订阅 `domain/changed`，
 * 等到那条记录被写入再挂载执行器。`tool-bash` 因为注入 `shell`，
 * 会在 `ctx.shell` 出现时由 cordis 自动激活——不需要我们协调。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const machine = await ctx.remotes.get(config.machine)
  if (machine) {
    mountExecutor(ctx, config, machine)
    return
  }

  ctx.logger.warn(
    "shell-ssh: 机器 '%s' 还没有在 remote-registry 里注册，暂时不提供 ctx.shell。"
    + '注册之后会自动挂上，不需要重启。',
    config.machine,
  )

  // 只挂一次：`domain/changed` 对同一条记录可能来多次（比如先 add 再
  // setPrivateKey/pinFingerprint 都会写这张表），而 `mountExecutor` 会
  // 注册服务与 effect，重复调用等于重复注册。
  let mounted = false
  ctx.effect(() =>
    ctx.on('domain/changed', (change) => {
      if (mounted) return
      if (change.domain !== REMOTE_DOMAIN_NAME) return
      if (change.table !== MACHINES_TABLE) return
      if (change.key !== config.machine) return
      if (change.operation !== 'put') return

      mounted = true
      // 事件回调是同步的，而取机器要 await；用 void + catch 而不是让一次
      // 失败变成没人处理的 rejection。取回来的记录可能与事件里的 value
      // 不同（归一化、或者紧接着又被改过），所以重新读一次注册表而不是
      // 直接信任 change.value。
      void (async () => {
        const registered = await ctx.remotes.get(config.machine)
        if (!registered) {
          mounted = false // 竞态：刚写完又被删了，继续等
          return
        }
        ctx.logger.info("shell-ssh: 机器 '%s' 已注册，正在挂载 ctx.shell", config.machine)
        mountExecutor(ctx, config, registered)
      })().catch((error: unknown) => {
        mounted = false
        ctx.logger.warn('shell-ssh: 机器注册后挂载失败：%s', String(error))
      })
    }),
  )
}
