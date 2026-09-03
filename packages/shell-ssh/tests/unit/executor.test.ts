import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'
import { SshConnectionPool } from '../../src/connection.ts'
import { buildRemoteCommand } from '../../src/exec.ts'
import { isSshError } from '../../src/errors.ts'
import { DEFAULTS, resolveSpec, SshShellExecutor } from '../../src/index.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'

let sshd: FakeSshd | undefined
let pool: SshConnectionPool | undefined

afterEach(async () => {
  pool?.disposeAll()
  pool = undefined
  await sshd?.close()
  sshd = undefined
})

function machineFor(port: number, extra: Partial<RemoteMachine> = {}): RemoteMachine {
  return { name: 'gpu-h20', host: '127.0.0.1', port, user: 'tester', keyRef: 'REMOTE_KEY_TEST', tags: [], ...extra }
}

function newPool(): SshConnectionPool {
  return new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
}

/** 计算 resolveSpec 默认 workdir('~') 包裹后，会实际发到伪造 sshd 的命令原文。 */
function wrapped(command: string, workdir = '~'): string {
  return buildRemoteCommand({ command, workdir })
}

/** 轮询直到条件为真或超时——用于等待后台进程的异步状态转换（如断线后变成 killed）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('超时：等待条件成立')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('resolveSpec', () => {
  it('request 未指定 workdir 时，落回 machine.defaultWorkdir', () => {
    const machine = machineFor(1, { defaultWorkdir: '/srv/app' })
    const spec = resolveSpec({ command: 'echo hi' }, machine)
    expect(spec.workdir).toBe('/srv/app')
    expect(spec.timeoutMs).toBe(DEFAULTS.timeoutMs)
    expect(spec.stdoutMaxBytes).toBe(DEFAULTS.stdoutMaxBytes)
  })

  it('machine 也没有 defaultWorkdir 时，落回 DEFAULTS.workdir', () => {
    const machine = machineFor(1)
    const spec = resolveSpec({ command: 'echo hi' }, machine)
    expect(spec.workdir).toBe(DEFAULTS.workdir)
  })

  it('request 显式指定的字段优先于 machine 默认值', () => {
    const machine = machineFor(1, { defaultWorkdir: '/srv/app' })
    const spec = resolveSpec({ command: 'echo hi', workdir: '/tmp', timeoutMs: 5000, stdoutMaxBytes: 100 }, machine)
    expect(spec.workdir).toBe('/tmp')
    expect(spec.timeoutMs).toBe(5000)
    expect(spec.stdoutMaxBytes).toBe(100)
  })

  it('SshShellExecutor#resolve 是同步的，且委托给 resolveSpec', () => {
    const machine = machineFor(1, { defaultWorkdir: '/srv/app' })
    const executor = new SshShellExecutor({ pool: newPool(), machine })
    const spec = executor.resolve({ command: 'pwd' })
    expect(spec).toEqual(resolveSpec({ command: 'pwd' }, machine))
  })
})

describe('SshShellExecutor#run', () => {
  it('产出正确的 RunResultLike 形状', async () => {
    sshd = await startFakeSshd({ commands: { [wrapped('run it')]: { stdout: 'out', stderr: 'err', exitCode: 3 } } })
    pool = newPool()
    const machine = machineFor(sshd.port)
    const executor = new SshShellExecutor({ pool, machine })
    const spec = executor.resolve({ command: 'run it' })
    const result = await executor.run(spec)

    expect(result.exitCode).toBe(3)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.timeoutMs).toBe(DEFAULTS.timeoutMs)
    expect(result.stdout).toEqual({ text: 'out', truncated: false })
    // stderr 带机器标注前缀（见 index.ts 的设计说明），原始内容仍完整保留。
    expect(result.stderr.truncated).toBe(false)
    expect(result.stderr.text).toContain('err')
    expect(result.stderr.text).toContain('gpu-h20')
  })

  it('run() 不声称任何 sandbox 约束：结果里完全没有 sandbox 字段', async () => {
    sshd = await startFakeSshd({ commands: { [wrapped('echo hi')]: { stdout: 'hi', exitCode: 0 } } })
    pool = newPool()
    const executor = new SshShellExecutor({ pool, machine: machineFor(sshd.port) })
    const result = await executor.run(executor.resolve({ command: 'echo hi' }))
    expect('sandbox' in result).toBe(false)
  })

  it('sandboxMode 是 undefined，不是某个具体的本地沙箱值', () => {
    const executor = new SshShellExecutor({ pool: newPool(), machine: machineFor(1) })
    expect(executor.sandboxMode).toBeUndefined()
  })

  it('目标机器不可达时，run() 拒绝（基础设施失败），而不是伪造一个 timedOut 结果', async () => {
    pool = newPool()
    // 端口 1 上没有任何服务在监听，acquire() 应该以 SSH_UNREACHABLE 失败。
    const executor = new SshShellExecutor({ pool, machine: machineFor(1) })
    const spec = executor.resolve({ command: 'echo hi' })
    await expect(executor.run(spec)).rejects.toSatisfy((err: unknown) => isSshError(err) && err.code === 'SSH_UNREACHABLE')
  })

  it('连接在命令执行期间断开时，run() 拒绝并带上 SSH_DISCONNECTED，而不是编造 exitCode', async () => {
    sshd = await startFakeSshd({
      commands: { [wrapped('slow')]: { stdout: 'partial output', delayMs: 3000, writeBeforeDelay: true } },
    })
    pool = newPool()
    const executor = new SshShellExecutor({ pool, machine: machineFor(sshd.port) })
    const spec = executor.resolve({ command: 'slow', timeoutMs: 10_000 })
    const runPromise = executor.run(spec)
    await waitUntil(() => sshd!.received.includes(wrapped('slow')))
    // 给服务器一点时间把 writeBeforeDelay 的输出发出去,再挂断。
    await new Promise((resolve) => setTimeout(resolve, 100))
    sshd.disconnectAll()
    await expect(runPromise).rejects.toSatisfy((err: unknown) => {
      return isSshError(err) && err.code === 'SSH_DISCONNECTED' && err.started === true
    })
  })
})

describe('SshShellExecutor#start', () => {
  it('增量 readOutput()：第一次读到 delta，第二次读为空', async () => {
    sshd = await startFakeSshd({
      commands: { [wrapped('stream')]: { stdoutChunks: ['chunk-A', 'chunk-B'], exitCode: 0 } },
    })
    pool = newPool()
    const executor = new SshShellExecutor({ pool, machine: machineFor(sshd.port) })
    const spec = executor.resolve({ command: 'stream' })
    const proc = executor.start(spec)

    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.exitCode).toBe(0)

    const first = proc.readOutput()
    expect(first.delta).toContain('chunk-A')
    expect(first.delta).toContain('chunk-B')
    expect(first.lossy).toBe(false)

    const second = proc.readOutput()
    expect(second.delta).toBe('')
    expect(second.lossy).toBe(false)
  })

  it('kill() 终止运行中的进程，重复调用是 no-op', async () => {
    sshd = await startFakeSshd({ commands: { [wrapped('slow')]: { stdout: 'late', delayMs: 5000 } } })
    pool = newPool()
    const executor = new SshShellExecutor({ pool, machine: machineFor(sshd.port) })
    const spec = executor.resolve({ command: 'slow' })
    const proc = executor.start(spec)

    await waitUntil(() => sshd!.received.includes(wrapped('slow')))
    expect(proc.kill()).toBe(true)
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.kill()).toBe(false)
  })

  it('命令执行期间断线：进程变成 killed，读取结果标记 lossy', async () => {
    sshd = await startFakeSshd({
      commands: { [wrapped('slow')]: { stdout: 'partial', delayMs: 5000, writeBeforeDelay: true } },
    })
    pool = newPool()
    const executor = new SshShellExecutor({ pool, machine: machineFor(sshd.port) })
    const spec = executor.resolve({ command: 'slow', timeoutMs: 20_000 })
    const proc = executor.start(spec)

    await waitUntil(() => sshd!.received.includes(wrapped('slow')))
    await new Promise((resolve) => setTimeout(resolve, 100))
    sshd.disconnectAll()

    await proc.done
    expect(proc.status).toBe('killed')
    const read = proc.readOutput()
    expect(read.lossy).toBe(true)
  })
})
