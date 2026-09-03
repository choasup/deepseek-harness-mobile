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
import { probeMachine } from '@dsh-mobile/remote-registry'
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
}

// `z<Config>` 这个写法（`z` 既是值又是类型）是 dsh 自己包里的既有约定，见
// dsh-storage-domain/dsh-storage-json 的 `export declare const Config: z<Config>`。
// `liveBufferMaxBytes` 不调用 `.required()`——同 dsh-bash-local 自己 Config
// 里 `cwd: z.string()` 的写法一致（该字段在其接口里也是 `cwd?: string`）：
// schemastery 的字段默认就是"可以整个不给"，不需要（也没有）一个显式
// `.optional()` 方法。
export const Config: z<Config> = z.object({
  machine: z.string(),
  liveBufferMaxBytes: z.number(),
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
 * ## `dshEnv` 缺口——刻意不在这里补上
 *
 * `ShellExecRequest.dshEnv` 的文档要求："Executors discard ambient `DSH_*`
 * entries before merging this snapshot last"——正确实现需要这个执行器记住
 * 上一次调用往远端 export 过哪些 `DSH_*` key，下一次调用前先把不在最新快照
 * 里的那些 key 显式 `unset` 掉，再 export 当前快照。`SshShellExecutor`
 * （Task 6）已经论证过它自己做不到这件事：它按每次调用组装一条命令字符串，
 * 不持有跨调用的会话状态。这个适配层的实例确实是跨调用持久的（同一个
 * `CordisSshShellExecutor` 实例服务这个插件生命周期内的所有调用），理论上
 * 可以在这一层加一份"上次 export 过哪些 key"的记录——但要真正生效，还需要
 * 一种"unset 一批 key"的命令拼装方式，而 `exec.ts` 的 `buildRemoteCommand()`
 * 只支持 `export KEY=value`，没有对应的 unset 通道；补一个只在这个适配层
 * 里独立拼接 unset 语句、绕开 `buildRemoteCommand()` 已经验证过的引用转义
 * 逻辑，是重新发明一套不受测试覆盖的拼接代码，风险比不做更大。
 *
 * 因此这里的决定沿用 Task 6：**不读取、不转发 `request.dshEnv`**——既不做
 * "只导出、从不清理"的半吊子合并（那会悄悄违反契约的后一半，且看起来像
 * 已经支持），也不假装这个字段被处理了。`request` 传给 `this.inner.resolve()`
 * 时是按 `ExecRequestLike`（没有 `dshEnv` 字段）的结构类型消费的，多出来的
 * `dshEnv` 字段被结构类型规则原样忽略，编译期不会报错——这正是 index.ts
 * 顶部注释点名的"结构类型换来的沉默丢失"。model 端能感知的效果是：通过
 * `DSH_*` 变量传递的、只在本机进程里可见的运行时事实（比如会话 id）对经
 * SSH 执行的命令不可见。这条限制记在这里，供 Task 11/12 组装真实 profile
 * 时判断是否可接受，也是 Before You Begin 里明确要求"deliberately decide"
 * 的那个决定。
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

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    // 连接丢失时 inner.run() reject——这正是 ShellExecutor 的文档契约
    // ("rejects only for infrastructure failures")，原样向上传播，不在
    // 这一层吞掉或者改写成一个编造的 ShellRunResult。见 index.ts 里
    // `SshShellExecutor.run()` 的文档注释。
    return this.inner.run(spec)
  }

  start(spec: ShellExecSpec): ShellProcess {
    return this.inner.start(spec)
  }
}

/**
 * cordis 插件入口。`config.machine` 必须已经在 `ctx.remotes` 里注册过，
 * 否则整个插件的加载失败并抛出 `SSH_NO_MACHINE`——一个指向不存在机器的
 * shell-ssh 配置没有任何可以退化运行的方式，快速失败好过悄悄挂着一个永远
 * 报错的 `ctx.shell`。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const machine = await ctx.remotes.get(config.machine)
  if (!machine) {
    throw new SshError(`未知机器 '${config.machine}'，请先在 ctx.remotes 里注册这台机器`, 'SSH_NO_MACHINE', false)
  }

  const pool = new SshConnectionPool({
    credentials: (m) => ctx.remotes.credentialsFor(m),
  })
  // 插件的 fiber 被 dispose（重载/组合拆卸）时释放连接池——disposeAll() 会
  // 等到每条连接真的触发 'close' 才 resolve（见 connection.ts 的注释），
  // cordis 的 dispose 链会等这个 Promise。
  ctx.effect(() => () => pool.disposeAll())

  // Service 的构造函数会自己调用 ctx.reflect.provide('shell', ...)——不需要
  // （也不应该）像 remote-registry/plugin.ts 那样手动 ctx.provide()，那是
  // 给不继承 Service 的类用的写法。
  new CordisSshShellExecutor(ctx, pool, machine, config.liveBufferMaxBytes)

  // 机器名这件事必须让 model 知道，但不能通过 stderr（见 index.ts 里
  // `SshShellExecutor` 类文档："这是 Task 7 的工作：...通过
  // ctx.systemPrompt.section(...) ...贡献"）。systemPrompt 是可选依赖——
  // 没有它这个插件仍然能提供一个能跑的 ctx.shell，只是 model 不知道机器名；
  // 不把它放进 `inject`，否则没挂 dsh-system-prompt 的组合（比如这个包自己
  // 的单元测试）会让这个插件永远卡在等待，而不是正常加载。
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
  if (systemPrompt) {
    systemPrompt.section({
      name: 'shell-ssh:machine',
      order: 100,
      text:
        `Bash commands run over SSH on the remote machine '${machine.name}' `
        + `(${machine.user}@${machine.host}:${machine.port}). A lost connection surfaces as a `
        + 'tool-call error, not a command result — retry only when the error says it is safe to. '
        + 'When a background job\'s status becomes "killed" due to connection loss, that means the '
        + 'SSH connection was closed, not that the remote process was necessarily terminated: a '
        + 'plain (non-PTY) exec channel does not reliably let the remote host reap the process, so '
        + 'a command that forked children (e.g. a background build) may still be running there.',
    })
  }
}
