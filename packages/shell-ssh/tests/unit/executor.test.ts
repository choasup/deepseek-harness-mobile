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

  // C1（review 发现的阻塞问题）：resolve() 必须真的"cap"，不能只是
  // "?? 默认值"。3_000_000_000 超出 setTimeout 32 位有符号整数范围，
  // 实测过不加钳制时 Node 会把它当成 1ms 后立刻触发——一条运行 1.5s 的
  // 命令会在 10ms 内被杀掉，还被报告成 timedOut:true，跟一次真实超时
  // 没有任何区别。0 和负数同理：`0 ?? DEFAULTS.timeoutMs` 保留 0，直接
  // 传给 setTimeout(fn, 0) 立刻触发。
  it('resolveSpec 把超出 32 位有符号整数范围的 timeoutMs 钳制到 DEFAULTS.maxTimeoutMs', () => {
    const machine = machineFor(1)
    const spec = resolveSpec({ command: 'echo hi', timeoutMs: 3_000_000_000 }, machine)
    expect(spec.timeoutMs).toBe(DEFAULTS.maxTimeoutMs)
    expect(spec.timeoutMs).toBeLessThanOrEqual(2_147_483_647)
  })

  it('resolveSpec 把 timeoutMs: 0 钳制到 DEFAULTS.minTimeoutMs，而不是原样传给 setTimeout', () => {
    const machine = machineFor(1)
    const spec = resolveSpec({ command: 'echo hi', timeoutMs: 0 }, machine)
    expect(spec.timeoutMs).toBe(DEFAULTS.minTimeoutMs)
  })

  it('resolveSpec 把负的 timeoutMs 钳制到 DEFAULTS.minTimeoutMs', () => {
    const machine = machineFor(1)
    const spec = resolveSpec({ command: 'echo hi', timeoutMs: -5000 }, machine)
    expect(spec.timeoutMs).toBe(DEFAULTS.minTimeoutMs)
  })

  it('resolveSpec 同样钳制 stdoutMaxBytes 的越界值（0/负数落到下限，天文数字落到上限）', () => {
    const machine = machineFor(1)
    expect(resolveSpec({ command: 'x', stdoutMaxBytes: 0 }, machine).stdoutMaxBytes).toBe(DEFAULTS.minStdoutMaxBytes)
    expect(resolveSpec({ command: 'x', stdoutMaxBytes: -1 }, machine).stdoutMaxBytes).toBe(DEFAULTS.minStdoutMaxBytes)
    expect(resolveSpec({ command: 'x', stdoutMaxBytes: 5_000_000_000 }, machine).stdoutMaxBytes).toBe(
      DEFAULTS.maxStdoutMaxBytes,
    )
    // 合法的小预算(比如精确解析一小段 stdout)必须原样保留,不能被"安全"地抬高。
    expect(resolveSpec({ command: 'x', stdoutMaxBytes: 100 }, machine).stdoutMaxBytes).toBe(100)
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
    // stderr 是命令原始输出,不带任何本执行器自己加的标注(见 index.ts
    // SshShellExecutor 类文档注释:目标机器名不通过 stderr 暴露——那样会让
    // 一条本该 stderr 为空的成功命令看起来"有 stderr 输出",误导下游把
    // 空 stderr 当作"干净执行"的判断)。
    expect(result.stderr).toEqual({ text: 'err', truncated: false })
  })

  // C1 集成回归：这是 reviewer 实测复现过的失败模式——一条运行几十毫秒的
  // 命令配上一个天文数字 timeoutMs,不加钳制时会在个位数毫秒内被杀掉并
  // 报告 timedOut:true。这里断言钳制生效后命令能正常跑完,而不是被立刻杀死。
  it('resolve() 钳制过的天文数字 timeoutMs 不会让一条正常命令被瞬间杀死', async () => {
    sshd = await startFakeSshd({ commands: { [wrapped('quick')]: { stdout: 'ok', exitCode: 0, delayMs: 50 } } })
    pool = newPool()
    const executor = new SshShellExecutor({ pool, machine: machineFor(sshd.port) })
    const spec = executor.resolve({ command: 'quick', timeoutMs: 3_000_000_000 })
    expect(spec.timeoutMs).toBeLessThanOrEqual(2_147_483_647)
    const result = await executor.run(spec)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('ok')
  })

  // I3（review 发现）：dsh-shell 的 ShellExecSpec.stdoutMaxBytes 文档原文——
  // "run() uses it for stdout; background jobs and stderr keep the
  // executor's own output cap"——stderr 不该跟着调用方为 stdout 传入的小
  // 预算一起被截断。这里用一个明显超过 5 字节的 stderr,配合 stdoutMaxBytes:5,
  // 断言 stdout 按预算截断、stderr 完整保留。
  it('run() 的 stdoutMaxBytes 只影响 stdout，stderr 用执行器自己的预算', async () => {
    const longStderr = 'this stderr message is deliberately longer than five bytes'
    sshd = await startFakeSshd({
      commands: { [wrapped('noisy')]: { stdout: 'toolong-stdout', stderr: longStderr, exitCode: 0 } },
    })
    pool = newPool()
    const executor = new SshShellExecutor({ pool, machine: machineFor(sshd.port) })
    const spec = executor.resolve({ command: 'noisy', stdoutMaxBytes: 5 })
    const result = await executor.run(spec)
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text).toHaveLength(5)
    expect(result.stderr.truncated).toBe(false)
    expect(result.stderr.text).toBe(longStderr)
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

  // I4（review 发现，之前无法验证）：delta 里 stderr 段的字面标记是
  // dsh-bash-local README 里写明的 `[stderr]`,不是本文件早前发明的占位符。
  // 这里把它钉死成一个精确断言,防止以后又漂移成别的格式而没人发现。
  it('readOutput() 的 delta 用 dsh-bash-local 规定的 [stderr] 标记分隔 stdout/stderr', async () => {
    sshd = await startFakeSshd({
      commands: { [wrapped('both')]: { stdout: 'out-x', stderr: 'err-y', exitCode: 0 } },
    })
    pool = newPool()
    const executor = new SshShellExecutor({ pool, machine: machineFor(sshd.port) })
    const proc = executor.start(executor.resolve({ command: 'both' }))
    await proc.done
    const { delta } = proc.readOutput()
    expect(delta).toBe('out-x\n[stderr]\nerr-y')
  })

  // I1（review 发现的回归）：lossy 是"这次读"的属性,不是"这条流从此以后
  // 永远"的属性。用一个明显小于命令实际输出量的 liveBufferMaxBytes(I5
  // 顺带验证:这个值现在可以从 SshShellExecutorOptions 注入,不用真的
  // 灌 256KB 数据才能测到溢出)制造一次真实溢出,断言第一次读 lossy:true、
  // 内容是被截断后的尾部,第二次读 lossy:false、delta 为空——而不是那次
  // 溢出的 flag 永远粘在后续每一次读上。
  it('LiveWindow 溢出后：第一次读 lossy:true 且只保留尾部，第二次读 lossy:false（不会永久粘住）', async () => {
    sshd = await startFakeSshd({
      // 两块各 10 字节,liveBufferMaxBytes 只有 10,第二块到达时窗口内
      // 20 字节 > 10,触发一次溢出,丢弃第一块,只留第二块。
      commands: { [wrapped('stream2')]: { stdoutChunks: ['1234567890', 'ABCDEFGHIJ'], exitCode: 0 } },
    })
    pool = newPool()
    const executor = new SshShellExecutor({ pool, machine: machineFor(sshd.port), liveBufferMaxBytes: 10 })
    const proc = executor.start(executor.resolve({ command: 'stream2' }))
    await proc.done

    const first = proc.readOutput()
    expect(first.lossy).toBe(true)
    expect(first.delta).toBe('ABCDEFGHIJ')

    const second = proc.readOutput()
    expect(second.lossy).toBe(false)
    expect(second.delta).toBe('')
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

  it('目标机器从一开始就不可达：进程变成 killed，但不谎称丢失了从未产生过的数据', async () => {
    pool = newPool()
    const executor = new SshShellExecutor({ pool, machine: machineFor(1) })
    const spec = executor.resolve({ command: 'echo hi' })
    const proc = executor.start(spec)

    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.exitCode).toBeNull()
    const read = proc.readOutput()
    // 命令从未真正送达过远端（pool.acquire() 直接失败）——没有任何输出可言,
    // 不该被标记 lossy。stderr 里仍然带着连接失败的诊断信息。
    expect(read.lossy).toBe(false)
    expect(read.delta).toContain('connection lost')
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
