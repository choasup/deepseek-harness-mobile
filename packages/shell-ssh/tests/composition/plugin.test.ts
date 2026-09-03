// 不只测导出面——起一个真的 cordis Context，把 remote-registry 的插件和本
// 包的插件都真的挂上去，跑一条真实（伪造）sshd 上的端到端命令。remote-registry
// 的 tests/mock/harness.ts 就是为这个场景准备的（见它自己的注释），这里直接
// 复用它的 bootRemoteRegistry()，再在同一个 ctx 上叠上 shell-ssh 的插件。
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'
import { bootRemoteRegistry, type RemoteRegistryHarness } from '../../../remote-registry/tests/mock/harness.ts'
import { buildRemoteCommand } from '../../src/exec.ts'
import { isSshError } from '../../src/errors.ts'
import * as shellSshPlugin from '../../src/plugin.ts'
import { probeConfiguredMachine } from '../../src/plugin.ts'
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

  it('未知机器名：插件加载失败，抛出 SSH_NO_MACHINE', async () => {
    const { ctx } = harness
    // 故意不 add() 任何机器。

    let error: unknown
    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'does-not-exist' })
    try {
      await shellFiber
    } catch (err) {
      error = err
    }

    expect(isSshError(error)).toBe(true)
    if (isSshError(error)) expect(error.code).toBe('SSH_NO_MACHINE')
    expect(ctx.get('shell')).toBeUndefined()
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

  it('partialStdout 经 run() 的拒绝原样传出：连接在命令跑到一半断开时不丢弃已经收到的输出', async () => {
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
        expect(err.partialStdout).toBe('line1\nline2\n')
      }
    })

    await shellFiber.dispose()
  })
})
