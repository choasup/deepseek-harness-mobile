/**
 * 分层连接探针：在手机上加一台远程机器之后，立刻跑一遍
 * tcp -> credential -> handshake -> os -> gpu 五个阶段，告诉用户具体是
 * 哪一层断了——而不是一句笼统的"连接失败"。手机上没有终端可以
 * `ssh -v` 慢慢排查，探针输出的具体程度就是它存在的全部价值。
 *
 * **依赖方向是刻意的，不要"顺手"改掉**：`ProbeDeps` 完全靠注入，这个
 * 包里没有任何一处实现它。真正的 `sshHandshake`/`exec` 只能来自
 * `shell-ssh` 的连接池，但 `shell-ssh` 已经依赖 `remote-registry`
 * （机器/凭据的类型与注册表都定义在这边）——如果这个包反过来 import
 * `shell-ssh` 去拿实现，就是一个循环依赖。真正的 deps 由组装整个 App
 * 的一方提供：Task 10 这个包自己的 cordis 适配器，或 Task 7 的
 * `shell-ssh` cordis 适配器，在启动时把连接池包一层符合 `ProbeDeps`
 * 形状的函数传进来。下一个读到这个文件、只看见接口没看见实现的人，
 * 大概率会想"贴心地"加一个从 shell-ssh 来的 import 补上空缺——请不要，
 * 那正是这段注释想拦住的循环依赖。
 */
import { normalizeFingerprint } from './url.ts'
import type { RemoteMachine } from './types.ts'

export const PROBE_STAGES = ['tcp', 'credential', 'handshake', 'os', 'gpu'] as const
export type ProbeStage = (typeof PROBE_STAGES)[number]

export interface ProbeStageResult {
  stage: ProbeStage
  ok: boolean
  /** 给人看的一行说明。 */
  detail: string
  /** 前置阶段失败导致本阶段未执行。 */
  skipped?: boolean
}

export interface ProbeReport {
  ok: boolean
  stages: ProbeStageResult[]
  /** 本次握手看到的主机指纹，供调用方决定是否固定。 */
  discoveredFingerprint?: string
}

export interface ProbeDeps {
  tcpReachable(machine: RemoteMachine): Promise<{ ok: boolean; latencyMs?: number; error?: string }>
  /**
   * 报告这台机器的密钥实际是从哪一层解析出来的。之所以要单独一个阶段：
   * dsh 的 `CredentialProvider.resolve` 是分层的——本地 provider 的数据源
   * 依次是进程环境变量（`env`）、`.credentials.yaml`（`file`）、项目/用户
   * 级 `.env` 文件（`project-env`/`user-env`）。一台叫 `gpu-h20` 的机器，
   * 只要运行探针的机器上恰好导出了 `REMOTE_KEY_GPU_H20` 这个环境变量，
   * 就会在从没调用过 setPrivateKey 的情况下"悄悄"拿到一把跟它毫无关系
   * 的密钥（registry.ts 的 add() 只挡得住 add 那一刻已经存在的孤儿密钥，
   * 挡不住之后才出现的环境变量）。探针的职责就是如实告诉用户配置到底
   * 是从哪来的，所以即使这一层"配置成功"，也要在 source 不是存储配置
   * 本身（本地 provider 里是 `file`）时把这件事说破。
   */
  credentialSource(machine: RemoteMachine): Promise<{ configured: boolean; source?: string }>
  sshHandshake(machine: RemoteMachine): Promise<{ ok: boolean; fingerprint?: string; error?: string }>
  exec(machine: RemoteMachine, command: string): Promise<{ ok: boolean; stdout: string; error?: string }>
}

export interface ProbeOptions {
  /**
   * 整个探针（而不是单个阶段）的截止时间。任何一个 dep 都可能一直不
   * resolve——手机从 Wi-Fi 切到蜂窝网络时的黑洞 TCP 连接就是真实场景
   * （见 Task 5 的复盘）。探针挂起比探针报错更糟：用户面对的是设置页
   * 里一个转不停的圈。默认值留了余量，覆盖绝大多数正常的慢网络，
   * 又不至于让用户等太久看不到任何结果。
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

/** 本地 provider 里，代表"确实存在存储配置"的那个 source 值。 */
const STORED_CONFIG_SOURCE = 'file'

function pushSkipped(stages: ProbeStageResult[], detail: string): void {
  for (const stage of PROBE_STAGES.slice(stages.length)) {
    stages.push({ stage, ok: false, detail, skipped: true })
  }
}

async function runTcpStage(machine: RemoteMachine, deps: ProbeDeps): Promise<ProbeStageResult> {
  const res = await deps.tcpReachable(machine)
  if (!res.ok) {
    return { stage: 'tcp', ok: false, detail: res.error ?? `无法连接到 ${machine.host}:${machine.port}` }
  }
  return { stage: 'tcp', ok: true, detail: `${machine.host}:${machine.port} 可达 (${res.latencyMs}ms)` }
}

async function runCredentialStage(machine: RemoteMachine, deps: ProbeDeps): Promise<ProbeStageResult> {
  const res = await deps.credentialSource(machine)
  if (!res.configured) {
    // 这是 SSH_NO_CREDENTIAL 场景（见 registry.ts 的 MissingCredentialError），
    // 不能读起来像认证被拒——"去配一把密钥"和"你的密钥不对"要求用户
    // 做完全不同的事。
    return {
      stage: 'credential',
      ok: false,
      detail: `尚未为机器 '${machine.name}' 存储密钥（keyRef=${machine.keyRef}），请先设置私钥`,
    }
  }
  if (res.source && res.source !== STORED_CONFIG_SOURCE) {
    // 配置"成功"，但这正是危险的那一种成功：密钥不是这台机器自己存的，
    // 是某一层环境变量顺带命中的，随时可能因为运行环境变化而失效或错配。
    return {
      stage: 'credential',
      ok: true,
      detail: `密钥来自环境变量（source=${res.source}），并非存储在这台机器自己的配置里；如果这不是你期望的来源，请为它单独设置密钥`,
    }
  }
  return { stage: 'credential', ok: true, detail: '密钥已存储在这台机器的配置中' }
}

async function runHandshakeStage(
  machine: RemoteMachine,
  deps: ProbeDeps,
): Promise<{ result: ProbeStageResult; discoveredFingerprint?: string }> {
  const res = await deps.sshHandshake(machine)
  if (!res.ok) {
    return { result: { stage: 'handshake', ok: false, detail: res.error ?? 'SSH 握手失败' } }
  }
  if (!res.fingerprint) {
    return { result: { stage: 'handshake', ok: true, detail: 'SSH 握手成功' } }
  }

  // 两边都要过 normalizeFingerprint 再比较：ssh-keygen -lf 打印大写
  // `SHA256:`，而一台手工录入的机器从没走过 parseRemoteUrl 那条归一化
  // 路径。不做这一步，会对一台配置完全正常的机器报"指纹不匹配"——
  // 一次假的主机密钥告警比不告警更糟，会教会用户对着弹窗一路点过去。
  const discovered = normalizeFingerprint(res.fingerprint)

  if (!machine.hostFingerprint) {
    return {
      result: { stage: 'handshake', ok: true, detail: `SSH 握手成功，指纹 ${discovered} 尚未固定` },
      discoveredFingerprint: discovered,
    }
  }

  const pinned = normalizeFingerprint(machine.hostFingerprint)
  if (pinned !== discovered) {
    return {
      result: {
        stage: 'handshake',
        ok: false,
        detail: `指纹不匹配：已固定 ${pinned}，实际 ${discovered}`,
      },
      discoveredFingerprint: discovered,
    }
  }

  return {
    result: { stage: 'handshake', ok: true, detail: `SSH 握手成功，指纹匹配 (${pinned})` },
    discoveredFingerprint: discovered,
  }
}

async function runOsStage(machine: RemoteMachine, deps: ProbeDeps): Promise<ProbeStageResult> {
  const res = await deps.exec(machine, 'uname -sr && echo $SHELL')
  if (!res.ok) {
    return { stage: 'os', ok: false, detail: res.error ?? '获取系统信息失败' }
  }
  const detail = res.stdout.trim()
  return { stage: 'os', ok: true, detail: detail || '(空输出)' }
}

async function runGpuStage(machine: RemoteMachine, deps: ProbeDeps): Promise<ProbeStageResult> {
  const res = await deps.exec(machine, 'nvidia-smi --query-gpu=name --format=csv,noheader | sort -u')
  // 这个阶段永远是 ok:true——没有 GPU 是一条信息（这台机器就是纯 CPU
  // 机器），不是配置错误。跟前面几个阶段"失败就停止探测"的语义不对称，
  // 是刻意的：nvidia-smi 缺失/报错在这里只表示"没有 GPU 可探测"，不该
  // 被当成需要用户去修的问题。
  const stdout = res.ok ? res.stdout.trim() : ''
  if (!stdout) {
    return { stage: 'gpu', ok: true, detail: '未检测到 GPU' }
  }
  return { stage: 'gpu', ok: true, detail: stdout }
}

export async function probeMachine(
  machine: RemoteMachine,
  deps: ProbeDeps,
  options: ProbeOptions = {},
): Promise<ProbeReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stages: ProbeStageResult[] = []
  let discoveredFingerprint: string | undefined

  const run = (async () => {
    try {
      const tcp = await runTcpStage(machine, deps)
      stages.push(tcp)
      if (!tcp.ok) return pushSkipped(stages, '前置阶段失败，已跳过')

      const credential = await runCredentialStage(machine, deps)
      stages.push(credential)
      if (!credential.ok) return pushSkipped(stages, '前置阶段失败，已跳过')

      const handshake = await runHandshakeStage(machine, deps)
      stages.push(handshake.result)
      if (handshake.discoveredFingerprint) discoveredFingerprint = handshake.discoveredFingerprint
      if (!handshake.result.ok) return pushSkipped(stages, '前置阶段失败，已跳过')

      const os = await runOsStage(machine, deps)
      stages.push(os)
      if (!os.ok) return pushSkipped(stages, '前置阶段失败，已跳过')

      const gpu = await runGpuStage(machine, deps)
      stages.push(gpu)
    } catch (err) {
      // 防御性兜底：任何一个 dep 意外抛出（而不是返回 { ok:false }）都不
      // 应该变成一个未处理的 rejection——把它当成当前阶段失败处理，
      // 后续阶段照常标记为 skipped。
      const failedStage = PROBE_STAGES[stages.length]
      if (failedStage) {
        stages.push({
          stage: failedStage,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        })
        pushSkipped(stages, '前置阶段失败，已跳过')
      }
    }
  })()

  const timedOut = await Promise.race([
    run.then(() => false),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), timeoutMs)
    }),
  ])

  if (timedOut && stages.length < PROBE_STAGES.length) {
    // 卡在半路的那一阶段标记为"超时失败"（不是 skipped——它确实被
    // 执行了，只是没等到结果），之后的阶段才是因为它失败被跳过。
    const inFlightStage = PROBE_STAGES[stages.length]
    stages.push({
      stage: inFlightStage,
      ok: false,
      detail: `探测超时（超过 ${timeoutMs}ms 未响应）`,
    })
    pushSkipped(stages, '前置阶段超时，已跳过')
  }

  return {
    ok: stages.length === PROBE_STAGES.length && stages.every((s) => s.ok),
    stages,
    ...(discoveredFingerprint ? { discoveredFingerprint } : {}),
  }
}
