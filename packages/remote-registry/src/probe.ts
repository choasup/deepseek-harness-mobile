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

/**
 * 主机指纹与 `machine.hostFingerprint` 的关系，供 UI 决定该弹哪种提示——
 * 不能只把 `discoveredFingerprint` 这个裸字符串扔给调用方：'unpinned'
 * （从没固定过，这是安全的"要不要固定"提示）和 'mismatched'（固定过但
 * 对不上，可能是中间人攻击也可能是真的换了机器/重装）如果被同一个 UI
 * 分支处理，就是这整套指纹归一化工作想避免的那种一键点过的假警报。
 */
export type FingerprintStatus = 'unpinned' | 'matched' | 'mismatched'

export interface ProbeReport {
  ok: boolean
  stages: ProbeStageResult[]
  /** 本次握手看到的主机指纹，供调用方决定是否固定。 */
  discoveredFingerprint?: string
  /** 见 FingerprintStatus 的文档；只在 handshake 阶段真的解析出指纹时才有值。 */
  fingerprintStatus?: FingerprintStatus
}

export interface ProbeDeps {
  tcpReachable(
    machine: RemoteMachine,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; latencyMs?: number; error?: string }>
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
   * 本身时把这件事说破。
   *
   * 实现方（Task 10）应该调用 `ctx.credentials.describe(ref)`，
   * **不是** `resolve(ref)`——探针只需要"配置与否/来源/能不能写"这三个
   * 事实（正是 dsh-credentials 的 `CredentialInfo` 形状），resolve() 会把
   * 密钥原文交回来，探针这一层完全不需要、也不应该经手真正的密钥内容。
   * `writable` 直接决定了 credential 阶段该给哪种补救建议：dsh-credentials
   * 的本地 provider 对一个被进程环境变量占据的引用会拒绝 `set()`
   * （"is supplied read-only by the launching environment"），这时候让
   * 用户"去设置密钥"是一句保证会失败的建议——`project-env`/`user-env`
   * 这两层则是可写的，"设置密钥"在那两种来源下是真的能生效的补救。
   */
  credentialSource(
    machine: RemoteMachine,
    signal?: AbortSignal,
  ): Promise<{ configured: boolean; source?: string; writable: boolean }>
  /**
   * `fingerprint` 必须是 `sha256:<base64>` 形式（与 `RemoteMachine.hostFingerprint`
   * 和 `ssh-keygen -lf` 的输出同一种形状；大小写前缀、padding 均可，
   * `normalizeFingerprint` 会处理）。一个不合这个形状的值（比如原样转发
   * `ssh-keygen -lf` 的整行输出，或者带了没 trim 掉的换行符）会被当成
   * 独立的"无法解析主机指纹"失败，而不是被 `normalizeFingerprint` 悄悄
   * 吞掉、当成跟已固定值比对失败的"指纹不匹配"——后者是一次假的主机
   * 密钥告警，比不告警更糟：会教会用户对着这类弹窗一路点过去。
   */
  sshHandshake(
    machine: RemoteMachine,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; fingerprint?: string; error?: string }>
  exec(
    machine: RemoteMachine,
    command: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; stdout: string; error?: string }>
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
  /**
   * 外部可选的取消信号（调用方自己想提前中止，比如用户关掉了设置页）。
   * probeMachine 内部会把它跟自己的超时合并成一个信号，一起传给每个
   * dep 调用——deps 是否真的响应这个信号去释放底层资源（关掉 socket、
   * kill 掉子进程）是它们自己的事，probeMachine 不强制、也无法验证，
   * 只保证"我不再等它了"这一半（真正的资源回收职责边界见下面
   * probeMachine 的实现注释）。现在就加这个参数，是因为 ProbeDeps 的
   * 形状一旦被 Task 10 实现出来，之后再加就是一次破坏性变更。
   */
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 15_000

/** 本地 provider 里，代表"确实存在存储配置"的那个 source 值。 */
const STORED_CONFIG_SOURCE = 'file'

/**
 * 主机指纹的合法形状：`sha256:<base64>`，前缀大小写不敏感。故意跟
 * url.ts 里的 FINGERPRINT_RE 保持同一条正则，但没有从那边 import——
 * 那个常量没有导出，而这个包里其它文件（url.ts/registry.ts）在这一轮
 * 修复范围之外，不改它们的导出表面。两边靠各自的测试分别兜底，不是
 * 一个共享的强约束点；如果以后 url.ts 的指纹格式变了，这里要跟着改。
 */
const FINGERPRINT_FORMAT_RE = /^sha256:[A-Za-z0-9+/]+=*$/i

function pushSkipped(stages: ProbeStageResult[], detail: string): void {
  for (const stage of PROBE_STAGES.slice(stages.length)) {
    stages.push({ stage, ok: false, detail, skipped: true })
  }
}

/** `res.error` 可能是 undefined，也可能是空字符串——两者都要落到 fallback，不能露出一行空 detail。 */
function errorOr(error: string | undefined, fallback: string): string {
  return error && error.trim() ? error : fallback
}

async function runTcpStage(
  machine: RemoteMachine,
  deps: ProbeDeps,
  signal: AbortSignal,
): Promise<ProbeStageResult> {
  const res = await deps.tcpReachable(machine, signal)
  if (!res.ok) {
    return { stage: 'tcp', ok: false, detail: errorOr(res.error, `无法连接到 ${machine.host}:${machine.port}`) }
  }
  // I3/minor 修复：latencyMs 是可选字段，直接拼进模板字面量在它缺失时
  // 会露出字面量 "undefinedms"。
  const latencySuffix = res.latencyMs !== undefined ? ` (${res.latencyMs}ms)` : ''
  return { stage: 'tcp', ok: true, detail: `${machine.host}:${machine.port} 可达${latencySuffix}` }
}

async function runCredentialStage(
  machine: RemoteMachine,
  deps: ProbeDeps,
  signal: AbortSignal,
): Promise<ProbeStageResult> {
  const res = await deps.credentialSource(machine, signal)

  if (!res.configured) {
    // 这是 SSH_NO_CREDENTIAL 场景（见 registry.ts 的 MissingCredentialError），
    // 不能读起来像认证被拒——"去配一把密钥"和"你的密钥不对"要求用户
    // 做完全不同的事。
    if (res.writable === false) {
      // 罕见但可能：引用当前被一个只读来源占据，且那个来源提供的是空值
      // （dsh-credentials 的"空值视为未配置"规则）。这种情况下"请设置
      // 私钥"是一句保证失败的建议——先让用户去清掉那个只读来源。
      return {
        stage: 'credential',
        ok: false,
        detail: `机器 '${machine.name}' 尚未配置密钥，且当前引用被一个只读来源占用，无法直接写入；请先在启动 dsh 的 shell 里检查并清掉对应的环境变量，再设置私钥`,
      }
    }
    return {
      stage: 'credential',
      ok: false,
      detail: `尚未为机器 '${machine.name}' 存储密钥（keyRef=${machine.keyRef}），请先设置私钥`,
    }
  }

  if (res.source && res.source !== STORED_CONFIG_SOURCE) {
    // 配置"成功"，但这正是危险的那一种成功：密钥不是这台机器自己存的
    // 配置提供的，是别的某一层顺带命中的，随时可能因为运行环境变化而
    // 失效或错配。措辞只说"不是本机存储的配置"而不是具体点名"环境
    // 变量"——source 是 provider 自定义的字符串，不只有本地 provider
    // 这四个值；一个 keychain 后端的 provider 完全可能报 source=keychain，
    // 那时候说"来自环境变量"就是一句假话。
    const remedy = res.writable
      // project-env/user-env 是可写的，"设置自己的密钥"这条建议在这里
      // 是真的能生效的。
      ? '；如果这不是你期望的来源，可以为这台机器单独设置密钥来覆盖'
      // 本地 provider 对被进程环境变量占据的引用会拒绝写入
      // （"is supplied read-only by the launching environment"）——这里
      // 不能给一条保证失败的建议。
      : '；这个来源当前是只读的，无法通过设置密钥覆盖，请在启动 dsh 的 shell 里 unset 对应的环境变量后重试'
    return {
      stage: 'credential',
      ok: true,
      detail: `密钥来源不是本机存储的配置（source=${res.source}）${remedy}`,
    }
  }

  return { stage: 'credential', ok: true, detail: '密钥已存储在这台机器的配置中' }
}

async function runHandshakeStage(
  machine: RemoteMachine,
  deps: ProbeDeps,
  signal: AbortSignal,
): Promise<{ result: ProbeStageResult; discoveredFingerprint?: string; fingerprintStatus?: FingerprintStatus }> {
  const res = await deps.sshHandshake(machine, signal)
  if (!res.ok) {
    return { result: { stage: 'handshake', ok: false, detail: errorOr(res.error, 'SSH 握手失败') } }
  }
  if (!res.fingerprint) {
    return { result: { stage: 'handshake', ok: true, detail: 'SSH 握手成功' } }
  }

  // I7 修复：先校验形状，再归一化比较。一个不合 sha256:<base64> 形状的
  // 值（原始 `ssh-keygen -lf` 整行输出、带尾随换行符……）如果直接送进
  // normalizeFingerprint 去和已固定值比较，会稳定地报"指纹不匹配"——
  // 一次假的主机密钥告警，用户没法把它跟真的换了机器/中间人攻击区分开，
  // 长期后果是学会对着这类弹窗一路点过去，抵消掉整个归一化机制的意义。
  // 这里必须是一个独立的、说法不同的失败。
  if (!FINGERPRINT_FORMAT_RE.test(res.fingerprint)) {
    return {
      result: {
        stage: 'handshake',
        ok: false,
        detail: `无法解析主机指纹：${JSON.stringify(res.fingerprint)}（期望 sha256:<base64> 形式；这通常是探针适配器的实现问题，不代表这台机器真的换了主机密钥）`,
      },
    }
  }

  // 两边都要过 normalizeFingerprint 再比较：ssh-keygen -lf 打印大写
  // `SHA256:`，而一台手工录入的机器从没走过 parseRemoteUrl 那条归一化
  // 路径。不做这一步，会对一台配置完全正常的机器报"指纹不匹配"。
  const discovered = normalizeFingerprint(res.fingerprint)

  if (!machine.hostFingerprint) {
    return {
      result: { stage: 'handshake', ok: true, detail: `SSH 握手成功，指纹 ${discovered} 尚未固定` },
      discoveredFingerprint: discovered,
      fingerprintStatus: 'unpinned',
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
      fingerprintStatus: 'mismatched',
    }
  }

  return {
    result: { stage: 'handshake', ok: true, detail: `SSH 握手成功，指纹匹配 (${pinned})` },
    discoveredFingerprint: discovered,
    fingerprintStatus: 'matched',
  }
}

async function runOsStage(
  machine: RemoteMachine,
  deps: ProbeDeps,
  signal: AbortSignal,
): Promise<ProbeStageResult> {
  const res = await deps.exec(machine, 'uname -sr && echo $SHELL', signal)
  if (!res.ok) {
    return { stage: 'os', ok: false, detail: errorOr(res.error, '获取系统信息失败') }
  }
  // minor 修复：`uname -sr && echo $SHELL` 的输出天然是两行，直接拿去做
  // detail 违反了 ProbeStageResult.detail 自己的文档承诺（"给人看的
  // 一行说明"）。拼成一行，用 · 分隔。
  const detail = res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' · ')
  return { stage: 'os', ok: true, detail: detail || '(空输出)' }
}

async function runGpuStage(
  machine: RemoteMachine,
  deps: ProbeDeps,
  signal: AbortSignal,
): Promise<ProbeStageResult> {
  const res = await deps.exec(machine, 'nvidia-smi --query-gpu=name --format=csv,noheader | sort -u', signal)
  // 这个阶段永远是 ok:true——没有 GPU 是一条信息（这台机器就是纯 CPU
  // 机器），不是配置错误。跟前面几个阶段"失败就停止探测"的语义不对称，
  // 是刻意的：nvidia-smi 缺失/报错在绝大多数情况下只表示"没有 GPU 可
  // 探测"，不该被当成需要用户去修的问题。
  if (res.ok) {
    const stdout = res.stdout.trim()
    return stdout
      ? { stage: 'gpu', ok: true, detail: stdout }
      : { stage: 'gpu', ok: true, detail: '未检测到 GPU' }
  }
  // minor 修复：exec 失败不能被无条件吞成一句"未检测到 GPU"——那句话在
  // "这台机器压根没装 nvidia-smi"（纯 CPU 机器，最常见）之外，还会同样
  // 吞掉"这台机器确实插着 H20，但驱动坏了/nvidia-smi 报错"这种其实需要
  // 维修的情况，探针在它唯一有信息的时候反而把信息藏了起来。保留原因，
  // 让用户/后续排查能分清这两种"未检测到"。
  return { stage: 'gpu', ok: true, detail: `未检测到 GPU（探测命令执行失败：${errorOr(res.error, '未知错误')}）` }
}

export async function probeMachine(
  machine: RemoteMachine,
  deps: ProbeDeps,
  options: ProbeOptions = {},
): Promise<ProbeReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stages: ProbeStageResult[] = []
  let discoveredFingerprint: string | undefined
  let fingerprintStatus: FingerprintStatus | undefined

  // I8：内部的 AbortController 是超时和调用方 signal 共同的落点，一起
  // 转发给每个 dep 调用。probeMachine 自己只保证"不再等待"，是否真的
  // 释放底层资源（socket、子进程）取决于 dep 的实现有没有理会这个信号
  // ——这条职责边界见 ProbeOptions.signal 的文档。
  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', forwardAbort, { once: true })
  }
  const { signal } = controller

  // C1 修复：`run` 在超时之后被"放弃"而不是被取消——JS 没有办法强行打断
  // 一个还没 resolve 的 Promise。放弃并不等于停止：如果不设一个 settled
  // 标志位、在每次拿到某个 dep 的结果后先检查它，一旦那个被放弃的 dep
  // 迟迟才 resolve（真实场景：Wi-Fi/蜂窝切换期间黑洞掉的 TCP 连接，
  // 40 秒后终于超时），`run` 会继续往 `stages`（已经被 probeMachine
  // 返回给调用方、可能已经渲染在屏幕上的同一个数组）里 push 新的阶段
  // 结果——调用方能观察到一份"已经返回"的报告在自己手上继续变化，
  // 而 `report.ok` 这个顶层布尔值早已定格在超时那一刻的 false，跟这些
  // 迟到的新行自相矛盾。
  let settled = false

  const run = (async () => {
    try {
      const tcp = await runTcpStage(machine, deps, signal)
      if (settled) return
      stages.push(tcp)
      if (!tcp.ok) return pushSkipped(stages, '前置阶段失败，已跳过')

      const credential = await runCredentialStage(machine, deps, signal)
      if (settled) return
      stages.push(credential)
      if (!credential.ok) return pushSkipped(stages, '前置阶段失败，已跳过')

      const handshake = await runHandshakeStage(machine, deps, signal)
      if (settled) return
      stages.push(handshake.result)
      if (handshake.discoveredFingerprint) discoveredFingerprint = handshake.discoveredFingerprint
      if (handshake.fingerprintStatus) fingerprintStatus = handshake.fingerprintStatus
      if (!handshake.result.ok) return pushSkipped(stages, '前置阶段失败，已跳过')

      const os = await runOsStage(machine, deps, signal)
      if (settled) return
      stages.push(os)
      if (!os.ok) return pushSkipped(stages, '前置阶段失败，已跳过')

      const gpu = await runGpuStage(machine, deps, signal)
      if (settled) return
      stages.push(gpu)
    } catch (err) {
      // 防御性兜底：任何一个 dep 意外抛出（而不是返回 { ok:false }）都不
      // 应该变成一个未处理的 rejection——把它当成当前阶段失败处理，
      // 后续阶段照常标记为 skipped。detail 前缀"探针内部错误"，跟真正的
      // 网络/配置失败区分开——后者是用户需要去修的东西，前者是这份代码
      // 自己的 bug，报出来的行为应该是"去提 issue"而不是"去检查网络"。
      if (settled) return
      const failedStage = PROBE_STAGES[stages.length]
      if (failedStage) {
        const message = err instanceof Error && err.message ? err.message : String(err)
        stages.push({ stage: failedStage, ok: false, detail: `探针内部错误：${message}` })
        pushSkipped(stages, '前置阶段失败，已跳过')
      }
    }
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timedOut = await Promise.race([
      run.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve(true)
        }, timeoutMs)
      }),
    ])
    // 无论走哪条分支都要立刻置位：`run` 正常跑完之后已经没有更多 await
    // 点会再检查这个标志，但一旦 timedOut 为 true，`run` 大概率仍卡在
    // 某个 dep 调用上，必须让它下一次被唤醒时（哪怕是几十秒后）发现自己
    // 已经"迟到"，不再继续 push。
    settled = true

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
  } finally {
    // I3 修复：之前没清这个定时器——一次几十毫秒就跑完的探针，进程/测试
    // 仍然会因为这个挂起的 setTimeout 被迫多活 timeoutMs（默认 15 秒）
    // 才退出。用 clearTimeout 而不是给 timer 调 `.unref()`：这个包最终
    // 要跑在 React Native 里，它的定时器 polyfill 没有 unref 这个方法，
    // 调用会直接抛错；clearTimeout 是两边都有的标准 API。
    if (timer !== undefined) clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', forwardAbort)
  }

  return {
    ok: stages.length === PROBE_STAGES.length && stages.every((s) => s.ok),
    // C1 修复：返回一份拷贝，不是 probeMachine 内部还握着引用的那个
    // 数组——即使上面的 settled 检查已经堵住了"放弃后继续 push"的主
    // 路径，多一层拷贝可以确保调用方拿到的报告在任何情况下都不会被
    // 这个函数返回之后的任何代码路径改变。
    stages: stages.slice(),
    ...(discoveredFingerprint ? { discoveredFingerprint } : {}),
    ...(fingerprintStatus ? { fingerprintStatus } : {}),
  }
}
