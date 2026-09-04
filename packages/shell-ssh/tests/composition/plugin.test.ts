// 不只测导出面——起一个真的 cordis Context，把 remote-registry 的插件和本
// 包的插件都真的挂上去，跑一条真实（伪造）sshd 上的端到端命令。remote-registry
// 的 tests/mock/harness.ts 就是为这个场景准备的（见它自己的注释），这里直接
// 复用它的 bootRemoteRegistry()，再在同一个 ctx 上叠上 shell-ssh 的插件。
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'
import { bootRemoteRegistry, type RemoteRegistryHarness } from '../../../remote-registry/tests/mock/harness.ts'
import { buildRemoteCommand } from '../../src/exec.ts'
import { isSshError } from '../../src/errors.ts'
import * as shellSshPlugin from '../../src/plugin.ts'
import { createProbeDeps, probeConfiguredMachine } from '../../src/plugin.ts'
import { SshConnectionPool } from '../../src/connection.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'

function machine(overrides: Partial<RemoteMachine> = {}): RemoteMachine {
  return {
    name: 'gpu-h20',
    host: '127.0.0.1',
    port: 0,
    user: 'tester',
    keyRef: 'REMOTE_KEY_GPU_H20',
    tags: [],
    ...overrides,
  }
}

/** 生成一把 fake sshd 认得的私钥（PKCS1）——真实走 ctx.remotes.credentialsFor() 这条通道，不是密码。 */
function freshPrivateKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

/** 计算 resolveSpec 默认 workdir('~') 包裹后，会实际发到伪造 sshd 的命令原文。 */
function wrapped(command: string, workdir = '~'): string {
  return buildRemoteCommand({ command, workdir })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('超时：等待条件成立')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('shell-ssh 的 cordis 适配层', () => {
  let root: string
  let harness: RemoteRegistryHarness
  let sshd: FakeSshd | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shell-ssh-plugin-test-'))
    harness = await bootRemoteRegistry(root)
  })

  afterEach(async () => {
    await harness.disposeAll()
    await sshd?.close()
    sshd = undefined
    await rm(root, { recursive: true, force: true })
  })

  it('注册为 ctx.shell，端到端跑通一条命令', async () => {
    sshd = await startFakeSshd({ commands: { [wrapped('echo hi')]: { stdout: 'hi\n', exitCode: 0 } } })
    const { ctx } = harness
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'gpu-h20' })
    await shellFiber

    expect(ctx.shell).toBeDefined()
    const spec = ctx.shell.resolve({ command: 'echo hi' })
    const result = await ctx.shell.run(spec)

    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('hi\n')
    expect(sshd.received).toContain(wrapped('echo hi'))

    await shellFiber.dispose()
  })

  it('未知机器名：插件正常挂载（不 throw），只是不提供 ctx.shell，并记一条 warn', async () => {
    // 这条测试取代了原来"插件加载失败，抛出 SSH_NO_MACHINE"的断言——见
    // plugin.ts 里 apply() 上方的大段注释：那个旧设计会让
    // dsh-app-boot 的 assertEntriesActivated() 把这一个插件的失败变成
    // *整棵插件树*装载失败，而这个插件在 dsh-mobile 的 mobile-app bundle
    // 里就是一个普通 Loader 条目。新设计下，"没配置机器"必须是这一个条目
    // 自己安静地什么都不做，而不是让它的宿主进程整个崩掉。
    const { ctx } = harness
    // 故意不 add() 任何机器。
    const warnSpy = vi.spyOn(ctx.logger, 'warn')

    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'does-not-exist' })
    // 不应该 reject——apply() 正常返回。
    await expect(shellFiber).resolves.toBeDefined()

    expect(ctx.get('shell')).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledOnce()
    // ctx.logger.warn 是 printf 风格调用（'%s' 格式串 + 单独的参数），机器名
    // 在第二个参数上，不在格式串字面量里。
    expect(warnSpy.mock.calls[0]).toContain('does-not-exist')

    await shellFiber.dispose()
  })

  it('未知机器名时，一个硬依赖 ctx.shell 的消费者（tool-bash 的形状）保持 PENDING，既不激活也不失败', async () => {
    // 直接验证协调者要的那句话："a tool-bash-shaped consumer injecting
    // shell stays dormant"。@deepseek-ai/dsh-tool-bash 的真实 inject 是
    // `["tools", "shell", "systemPrompt", "shellEnv"]`（见该包 lib/index.js），
    // 这里只复现对本测试有意义的那一个键：`shell`。
    //
    // 这条测试同时划出这个新设计的边界：PENDING 本身在这个裸 cordis
    // Context 层面是良性的——不是 FAILED，`apply()` 从未跑过、也没有抛出
    // 任何错误。但把这一行接进真正的 `dsh --profile mobile` 时，
    // `@deepseek-ai/dsh-app-boot` 的 `assertEntriesActivated()` 会把**任何**
    // 已启用条目的 PENDING 状态也算作启动失败（另有独立 repro 验证，见本
    // 任务报告）——所以这条测试只能证明"在 shell-ssh 包自己的层面，消费者
    // 不会崩、不会报错"，不能证明"把 tool-bash 留着 enabled 就能让
    // dsh --profile mobile 正常启动"；后者需要在 mobile-app 那份
    // cordis.patch.yml 里单独决定。
    const { ctx } = harness
    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'does-not-exist' })
    await shellFiber

    const FIBER_PENDING = 0 // 跟 dsh-app-boot 编译产物里的 FIBER_PENDING 常量对齐，const enum 不能直接 import（见 erasableSyntaxOnly 的限制）。
    const FIBER_ACTIVE = 2
    const FIBER_FAILED = 3

    const toolBashShaped = {
      name: 'tool-bash-shaped-probe',
      inject: ['shell'],
      apply: vi.fn(),
    }
    const consumerFiber = ctx.plugin(toolBashShaped) as unknown as { state: number }

    expect(consumerFiber.state).toBe(FIBER_PENDING)
    expect(consumerFiber.state).not.toBe(FIBER_ACTIVE)
    expect(consumerFiber.state).not.toBe(FIBER_FAILED)
    expect(toolBashShaped.apply).not.toHaveBeenCalled()

    await (consumerFiber as unknown as { dispose(): Promise<void> }).dispose()
    await shellFiber.dispose()
  })

  it('机器已注册但从没设置过密钥：run() 拒绝为 SSH_NO_CREDENTIAL，不是 SSH_AUTH_FAILED', async () => {
    sshd = await startFakeSshd()
    const { ctx } = harness
    await ctx.remotes.add(machine({ port: sshd.port }))
    // 故意不调用 setPrivateKey。

    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'gpu-h20' })
    await shellFiber

    const spec = ctx.shell.resolve({ command: 'echo hi' })
    const rejection = ctx.shell.run(spec)
    await expect(rejection).rejects.toThrow()
    await rejection.catch((err: unknown) => {
      expect(isSshError(err)).toBe(true)
      if (isSshError(err)) expect(err.code).toBe('SSH_NO_CREDENTIAL')
    })

    await shellFiber.dispose()
  })

  it('插件的 fiber 被 dispose 时连接池真的释放：一个正在跑的后台命令观察到连接断开', async () => {
    sshd = await startFakeSshd({
      commands: {
        [wrapped('sleep-ish')]: { stdout: 'partial\n', delayMs: 5000, writeBeforeDelay: true },
      },
    })
    const { ctx } = harness
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'gpu-h20' })
    await shellFiber

    const spec = ctx.shell.resolve({ command: 'sleep-ish' })
    const proc = ctx.shell.start(spec)
    await waitUntil(() => sshd!.received.includes(wrapped('sleep-ish')))
    // 给一点时间让 'partial\n' 真的到达客户端，而不是刚好在断开的同一时刻。
    await waitUntil(() => proc.status === 'running')

    // dispose 插件的 fiber——这应该触发 apply() 里注册的
    // `ctx.effect(() => () => pool.disposeAll())`，真的把连接关掉。
    await shellFiber.dispose()

    // disposeAll() 关闭连接对这个仍在运行的后台命令来说，表现为一次连接
    // 中途断开：execRemote() 收到 'close' 却没收到 'exit'，结算成
    // SSH_DISCONNECTED，SshShellProcess 把它映射成 status:'killed' + lossy。
    await waitUntil(() => proc.status !== 'running')
    expect(proc.status).toBe('killed')
    const read = proc.readOutput()
    expect(read.lossy).toBe(true)
  })

  it('探针 probeConfiguredMachine 对真实（伪造）sshd 跑出五阶段报告', async () => {
    sshd = await startFakeSshd({
      commands: {
        'uname -sr && echo $SHELL': { stdout: 'Linux 6.1\n/bin/bash\n', exitCode: 0 },
      },
    })
    const { ctx } = harness
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    const report = await probeConfiguredMachine(ctx, 'gpu-h20')

    expect(report.stages.map((s) => s.stage)).toEqual(['tcp', 'credential', 'handshake', 'os', 'gpu'])
    expect(report.stages.find((s) => s.stage === 'tcp')?.ok).toBe(true)
    expect(report.stages.find((s) => s.stage === 'credential')?.ok).toBe(true)
    expect(report.stages.find((s) => s.stage === 'handshake')?.ok).toBe(true)
    expect(report.fingerprintStatus).toBe('unpinned')
    expect(report.discoveredFingerprint).toMatch(/^sha256:/)
    expect(report.stages.find((s) => s.stage === 'os')?.ok).toBe(true)
    expect(report.stages.find((s) => s.stage === 'os')?.detail).toContain('Linux 6.1')
    // gpu 阶段命令没有配置（fake sshd 默认对未命中命令返回 127），但 gpu
    // 阶段永远 ok:true——见 probe.ts 的文档，没有 GPU 是信息不是错误。
    expect(report.stages.find((s) => s.stage === 'gpu')?.ok).toBe(true)
    expect(report.ok).toBe(true)
  })

  it('探针对未知机器名抛出 SSH_NO_MACHINE', async () => {
    const { ctx } = harness
    const rejection = probeConfiguredMachine(ctx, 'does-not-exist')
    await expect(rejection).rejects.toThrow()
    await rejection.catch((err: unknown) => {
      expect(isSshError(err)).toBe(true)
      if (isSshError(err)) expect(err.code).toBe('SSH_NO_MACHINE')
    })
  })

  // ---------------------------------------------------------------------
  // 协调者复审 I1：这个测试原来只断言 `err.partialStdout` 这个字段本身
  // 存在——证明的是"数据没丢"，不是"数据被看到了"。`dsh-tool-bash` 对
  // `ctx.shell.run(...)` 的调用没有 try/catch，`dsh-tools` 对工具调用抛出
  // 的异常只读 `.message` 渲染给 model——两者叠加意味着只活在字段上的
  // partialStdout 从没有被任何读者看到过。现在额外断言 `err.message`
  // 本身包含这段输出（打了标签），这才是真正会被渲染出去的那个字段。
  // ---------------------------------------------------------------------

  it('partialStdout 经 run() 的拒绝原样传出，并且被烧进 err.message——不只是活在一个 model 永远读不到的字段上', async () => {
    sshd = await startFakeSshd({
      commands: {
        [wrapped('long-running')]: { stdout: 'line1\nline2\n', delayMs: 3000, writeBeforeDelay: true },
      },
    })
    const { ctx } = harness
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'gpu-h20' })
    await shellFiber

    const spec = ctx.shell.resolve({ command: 'long-running' })
    const runPromise = ctx.shell.run(spec)

    await waitUntil(() => sshd!.received.includes(wrapped('long-running')))
    // 给一点时间让 'line1\nline2\n' 真的先到达客户端，再挂断所有连接。
    await new Promise((resolve) => setTimeout(resolve, 200))
    sshd.disconnectAll()

    await expect(runPromise).rejects.toThrow()
    await runPromise.catch((err: unknown) => {
      expect(isSshError(err)).toBe(true)
      if (isSshError(err)) {
        expect(err.code).toBe('SSH_DISCONNECTED')
        expect(err.started).toBe(true)
        // 字段本身仍然在（内部消费者/未来的 UI 可能还想要结构化访问）。
        expect(err.partialStdout).toBe('line1\nline2\n')
        // 但真正要证明的是：message 本身——`dsh-tools` 唯一会渲染的
        // 字段——包含这段输出，而不是只活在 partialStdout 这个字段上。
        expect(err.message).toContain('line1\nline2\n')
        expect(err.message).toContain('[stdout before disconnect]')
        // 断线发生在命令已经开始执行之后（started: true），message 里
        // 应该说清楚这条命令不安全自动重试——不能只靠一个 model 看不见的
        // recoverable 字段来传达这件事。
        expect(err.message).toMatch(/may have partially executed|do not retry/i)
      }
    })

    await shellFiber.dispose()
  })

  // ---------------------------------------------------------------------
  // 协调者复审 M5：这个任务存在的理由就是把 SshShellExecutor 对齐成真正的
  // ShellExecutor——但对齐本身此前完全没有测试。sandboxMode 只在
  // SshShellExecutor（Task 6 的内层类）上测过，没有任何测试断言
  // ctx.shell.sandboxMode（真正暴露给 dsh-tool-bash 的那一层）确实是
  // undefined，也没有断言 ctx.shell.resolve(...) 产出的 spec 真的带着
  // sandboxPolicy 这个字段（哪怕值是 undefined）——这正是这个适配层唯一
  // 的类型对齐工作。
  // ---------------------------------------------------------------------

  it('M5 回归：ctx.shell.sandboxMode 是 undefined——适配层没有悄悄声称一种不存在的沙箱状态', async () => {
    sshd = await startFakeSshd()
    const { ctx } = harness
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'gpu-h20' })
    await shellFiber

    expect(ctx.shell.sandboxMode).toBeUndefined()

    await shellFiber.dispose()
  })

  it('M5 回归：ctx.shell.resolve(...) 产出的 spec 带着 sandboxPolicy 字段，值是 undefined——这是适配层唯一的类型对齐工作', async () => {
    sshd = await startFakeSshd()
    const { ctx } = harness
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'gpu-h20' })
    await shellFiber

    const spec = ctx.shell.resolve({ command: 'echo hi' })
    // 'sandboxPolicy' in spec 而不是 !== undefined——真正要防的回归是
    // "这个字段被整个漏掉了"（inner.resolve() 返回的 ExecSpecLike 本来就
    // 没有这个字段），跟"这个字段存在但恰好是 undefined"是两回事，只有
    // `in` 才能把前者跟后者区分开。
    expect('sandboxPolicy' in spec).toBe(true)
    expect(spec.sandboxPolicy).toBeUndefined()

    await shellFiber.dispose()
  })

  it('M5 回归：探针的 credentialSource 走 describe()，从不调用 resolve()——不该经手密钥原文', async () => {
    const { ctx, creds } = harness
    const m = machine({ port: 1 })
    await ctx.remotes.add(m)
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    const describeSpy = vi.spyOn(creds, 'describe')
    const resolveSpy = vi.spyOn(creds, 'resolve')

    // 直接调用 createProbeDeps(...).credentialSource——不经过完整的
    // probeMachine()：handshake/exec 两个阶段为了真的认证，本来就合法地
    // 需要调用 resolve() 拿密钥原文去连服务器，混在一次完整探针里测，
    // 测不出 credentialSource 这一个函数自己有没有越界去调 resolve()。
    const pool = new SshConnectionPool({ credentials: (mm) => ctx.remotes.credentialsFor(mm) })
    const deps = createProbeDeps(ctx, pool)
    await deps.credentialSource(m)
    await pool.disposeAll()

    expect(describeSpy).toHaveBeenCalled()
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------
  // 协调者复审 M2：pool 的 onDisconnect 钩子存在好几轮 review 才成型，但
  // apply() 此前从没提供它，钩子触发的一次意外断线完全没有任何观察者。
  // 这里验证 apply() 真的把它接到了 ctx.logger 上——用 sshd.disconnectAll()
  // 制造一次真实的（而不是池自己主动摘除的）意外断线。
  // ---------------------------------------------------------------------

  it('M2 回归：连接意外断开时，apply() 接的 onDisconnect 钩子把它记到 ctx.logger.warn 上', async () => {
    sshd = await startFakeSshd()
    const { ctx } = harness
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'gpu-h20' })
    await shellFiber

    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    // 先真的建立一条连接（acquire 发生在 resolve()/run() 里），再意外挂断它。
    await ctx.shell.run(ctx.shell.resolve({ command: 'echo hi' }))
    sshd.disconnectAll()

    await waitUntil(() => warnSpy.mock.calls.some((call) => String(call[0]).includes('意外断开')))

    await shellFiber.dispose()
  })
})
