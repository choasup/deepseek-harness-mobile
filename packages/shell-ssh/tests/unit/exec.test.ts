import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import ssh2 from 'ssh2'
import type { Client, ClientChannel } from 'ssh2'
import { buildRemoteCommand, execRemote } from '../../src/exec.ts'
import { isSshError } from '../../src/errors.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'

const { Client: SshClient } = ssh2

let sshd: FakeSshd | undefined
let client: InstanceType<typeof Client> | undefined

afterEach(async () => {
  client?.end(); client = undefined
  await sshd?.close(); sshd = undefined
})

async function connect(port: number) {
  const c = new SshClient()
  await new Promise<void>((resolve, reject) => {
    c.on('ready', () => resolve()).on('error', reject)
     .connect({ host: '127.0.0.1', port, username: 'tester', password: 'x' })
  })
  return c
}

/** 用真实 /bin/sh 跑一段脚本，返回 stdout 与退出码——不通过伪造 sshd，直接验证 shell 语义。 */
function runShShell(script: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], (err, stdout) => {
      const exitCode = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (err as unknown as { code: number }).code
        : 0
      resolve({ stdout, exitCode })
    })
  })
}

describe('execRemote', () => {
  it('收集 stdout/stderr 与退出码', async () => {
    sshd = await startFakeSshd({
      commands: { 'run it': { stdout: 'out', stderr: 'err', exitCode: 3 } },
    })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'run it', timeoutMs: 5000, stdoutMaxBytes: 1024 })
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stderrTruncated).toBe(false)
    expect(result.stdoutBytesSeen).toBe(3)
  })

  // C3：超出 stdoutMaxBytes 时保留的是尾部，不是头部——跟 dsh 本地执行
  // CollectedOutput 的约定一致（失败命令有价值的通常是最后几行）。用头尾
  // 内容不同的字符串才能真正证明"保留的是尾部"，而不是巧合地长度对了。
  it('超过 stdoutMaxBytes 时保留尾部并标记截断', async () => {
    const text = 'A'.repeat(90) + 'B'.repeat(10)
    sshd = await startFakeSshd({ commands: { big: { stdout: text, exitCode: 0 } } })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'big', timeoutMs: 5000, stdoutMaxBytes: 10 })
    expect(result.stdout).toBe('B'.repeat(10))
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stdoutBytesSeen).toBe(100)
    expect(result.exitCode).toBe(0) // 截断不改变退出码
  })

  it('超时返回 timedOut 而不是抛异常', async () => {
    sshd = await startFakeSshd({ commands: { slow: { stdout: 'late', delayMs: 3000 } } })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'slow', timeoutMs: 150, stdoutMaxBytes: 1024 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('AbortSignal 触发时返回 aborted', async () => {
    sshd = await startFakeSshd({ commands: { slow: { stdout: 'late', delayMs: 3000 } } })
    client = await connect(sshd.port)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const result = await execRemote(client, {
      command: 'slow', timeoutMs: 5000, stdoutMaxBytes: 1024, signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  })

  it('被信号杀死时记录 signal', async () => {
    sshd = await startFakeSshd({ commands: { doomed: { killedBy: 'TERM' } } })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'doomed', timeoutMs: 5000, stdoutMaxBytes: 1024 })
    expect(result.signal).toBe('SIGTERM')
    expect(result.exitCode).toBeNull()
  })

  // Addition C 验证：workdir/env 会给命令前面挂一段 `cd ... && export ... &&`。
  // 命令本体被包进 `(\n...\n)` 这对括号里，而不是直接原样拼在最后——见
  // buildRemoteCommand 里的详细注释和下面几个专门测这一点的用例。
  it('把 workdir 与 env 前置到命令里', async () => {
    sshd = await startFakeSshd({ commands: {} })
    client = await connect(sshd.port)
    await execRemote(client, {
      command: 'echo hi', timeoutMs: 5000, stdoutMaxBytes: 1024,
      workdir: '/root/work', env: { FOO: 'bar baz' },
    })
    expect(sshd.received[0]).toBe(`cd '/root/work' && export FOO='bar baz' && (\necho hi\n)`)
  })

  it('转义 workdir 与 env 里的单引号', async () => {
    sshd = await startFakeSshd({ commands: {} })
    client = await connect(sshd.port)
    await execRemote(client, {
      command: 'x', timeoutMs: 5000, stdoutMaxBytes: 1024, env: { Q: "it's" },
    })
    expect(sshd.received[0]).toBe(`export Q='it'\\''s' && (\nx\n)`)
  })

  // ---- C1：没有绝对结算截止时间的两条永不结算路径 ----
  // 这两个场景（channel-open 请求被黑洞、close() 发出去后同样被黑洞）在
  // 真实网络里意味着"TCP 连接表面还在、但再也没有任何字节双向流动"——伪造
  // sshd 是一个真实、健康的本地 TCP 连接，没办法拿它可靠地模拟"报文再也
  // 送不达对端"。这里改用手搭的 stub Client/ClientChannel（只实现
  // execRemote 真正用到的那几个方法：exec()、on()、close()、end()，不经过
  // 真实 ssh2）——测的是 execRemote 自己的 watchdog 定时器逻辑，跟"ssh2
  // 在正常网络下的行为"是两件已经分别验证过的事，不重复验证后者。

  it('channel-open 请求被黑洞时，timeoutMs 到点后返回 timedOut 而不是永远 pending', async () => {
    const neverAnsweringClient = {
      exec: () => {
        // 故意永远不调用回调——模拟对端黑洞掉 channel-open 请求。
      },
    } as unknown as Client
    const start = Date.now()
    const result = await execRemote(neverAnsweringClient, {
      command: 'x', timeoutMs: 150, stdoutMaxBytes: 1024,
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(Date.now() - start).toBeLessThan(2000) // 远小于宽限期，证明没有等额外的 3 秒
  })

  it('stream.close() 发出去后对端也黑洞掉时，宽限期结束后强制结算', async () => {
    const chan = new EventEmitter() as unknown as ClientChannel
    ;(chan as unknown as { stderr: EventEmitter }).stderr = new EventEmitter()
    // close() 故意什么都不做——不触发 'close'，模拟黑洞连接下永远等不到
    // 对端的关闭回音（ssh2 1.17.0 源码：onCHANNEL_CLOSE 依赖本地先收到
    // 'end'，黑洞连接下这个 'end' 不会来）。
    chan.close = () => {}
    chan.end = () => chan
    const client_: Client = {
      exec: (_cmd: string, cb: (err: Error | undefined, stream: ClientChannel) => void) => {
        cb(undefined, chan)
      },
    } as unknown as Client

    const start = Date.now()
    const result = await execRemote(client_, { command: 'x', timeoutMs: 50, stdoutMaxBytes: 1024 })
    const elapsed = Date.now() - start
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    // 一定经历过宽限期（不是 timeoutMs 一到就立刻返回），但没有无限期挂着。
    expect(elapsed).toBeGreaterThanOrEqual(2900)
    expect(elapsed).toBeLessThan(15_000)
  }, 20_000)

  // ---- C2：已经 abort 的 signal 会被忽略、命令照样执行 ----

  it('已经处于 aborted 状态的 signal 会被立即接受，命令根本不会被送到服务器', async () => {
    sshd = await startFakeSshd({ commands: { late: { stdout: 'late', exitCode: 0 } } })
    client = await connect(sshd.port)
    const controller = new AbortController()
    controller.abort()
    const result = await execRemote(client, {
      command: 'late', timeoutMs: 5000, stdoutMaxBytes: 1024, signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.stdout).toBe('')
    expect(sshd.received).toEqual([])
  })

  it('abort 落在 exec() 调用和它的回调触发之间同样会生效，不会被吞掉', async () => {
    sshd = await startFakeSshd({ commands: { late: { stdout: 'late', exitCode: 0 } } })
    client = await connect(sshd.port)
    const controller = new AbortController()
    const promise = execRemote(client, {
      command: 'late', timeoutMs: 5000, stdoutMaxBytes: 1024, signal: controller.signal,
    })
    // execRemote 内部在调用 client.exec() 之前就同步挂好了 abort 监听器
    // 并同步发起了 exec()；exec() 真正的回调要等一次网络往返，这里紧跟着
    // 调用 abort() 必然落在"已经挂号监听、还没等到回调"这个窗口。
    controller.abort()
    const result = await promise
    expect(result.aborted).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  // ---- 边界：连接在拿到手时/执行到一半时已经死了（含 I2 的 started 判别）----

  it('对已经断开的连接执行命令，返回 started:false 的 SSH_DISCONNECTED', async () => {
    sshd = await startFakeSshd({ commands: { quick: { exitCode: 0 } } })
    client = await connect(sshd.port)
    client.end()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(
      execRemote(client, { command: 'quick', timeoutMs: 5000, stdoutMaxBytes: 1024 }),
    ).rejects.toSatisfy(
      (err: unknown) => isSshError(err) && err.code === 'SSH_DISCONNECTED' && err.recoverable && err.started === false,
    )
  })

  it('执行到一半连接断开，返回 started:true 的 SSH_DISCONNECTED，而不是 exitCode:null 的正常结果', async () => {
    sshd = await startFakeSshd({ commands: { slow: { stdout: 'x', delayMs: 3000 } } })
    client = await connect(sshd.port)
    const execPromise = execRemote(client, { command: 'slow', timeoutMs: 5000, stdoutMaxBytes: 1024 })
    setTimeout(() => sshd?.disconnectAll(), 100)
    await expect(execPromise).rejects.toSatisfy(
      (err: unknown) => isSshError(err) && err.code === 'SSH_DISCONNECTED' && err.recoverable && err.started === true,
    )
  })

  it('执行到一半断线时，SshError 上带着断线前已收集到的部分输出', async () => {
    sshd = await startFakeSshd({
      commands: { slow: { stdout: 'partial-out', delayMs: 3000, writeBeforeDelay: true } },
    })
    client = await connect(sshd.port)
    const execPromise = execRemote(client, { command: 'slow', timeoutMs: 5000, stdoutMaxBytes: 1024 })
    setTimeout(() => sshd?.disconnectAll(), 150)
    await expect(execPromise).rejects.toSatisfy(
      (err: unknown) => isSshError(err) && err.started === true && err.partialStdout === 'partial-out',
    )
  })

  // ---- Addition B：stdoutMaxBytes 按字节数（UTF-8），不是按 JS 字符串长度 ----

  it('尾部截断时不会把开头被切开的多字节字符留成乱码', async () => {
    // 三个不同的汉字，UTF-8 各 3 字节，共 9 字节。保留尾部 4 字节会砍在
    // 第二个字符中间——只留下第三个完整字符，而不是产生 U+FFFD。
    const text = '你好吗'
    expect(Buffer.byteLength(text, 'utf8')).toBe(9)
    sshd = await startFakeSshd({ commands: { cjk: { stdout: text, exitCode: 0 } } })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'cjk', timeoutMs: 5000, stdoutMaxBytes: 4 })
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stdout).toBe('吗')
    expect(result.stdout).not.toContain('\uFFFD')
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(4)
  })

  // ---- I6/I7：跨多个 'data' 事件拆分的多字节字符 + onData 的正确性 ----

  it('跨多个 data 事件、逐字节拆分的多字节字符能正确重组：onData 增量与最终结果都不乱码', async () => {
    const text = '你好，世界！😀'
    const bytes = Buffer.from(text, 'utf8')
    const pieces = Array.from(bytes, (b) => Buffer.from([b])) // 每个字节单独一次 write()
    sshd = await startFakeSshd({ commands: { splitty: { stdoutChunks: pieces, exitCode: 0 } } })
    client = await connect(sshd.port)
    const onDataPieces: string[] = []
    const result = await execRemote(client, {
      command: 'splitty', timeoutMs: 5000, stdoutMaxBytes: 1_000_000,
      onData: (chunk, which) => { if (which === 'stdout') onDataPieces.push(chunk) },
    })
    expect(result.stdout).toBe(text)
    expect(result.stdout).not.toContain('\uFFFD')
    expect(onDataPieces.join('')).toBe(text)
  })

  it('onData 按到达顺序回调，且标注正确的流', async () => {
    sshd = await startFakeSshd({ commands: { mix: { stdout: 'OUT', stderr: 'ERR', exitCode: 0 } } })
    client = await connect(sshd.port)
    const events: Array<{ chunk: string; stream: 'stdout' | 'stderr' }> = []
    await execRemote(client, {
      command: 'mix', timeoutMs: 5000, stdoutMaxBytes: 1024,
      onData: (chunk, stream) => { events.push({ chunk, stream }) },
    })
    expect(events.length).toBeGreaterThan(0)
    expect(events.filter((e) => e.stream === 'stdout').map((e) => e.chunk).join('')).toBe('OUT')
    expect(events.filter((e) => e.stream === 'stderr').map((e) => e.chunk).join('')).toBe('ERR')
  })

  it('onData 的增量不受 stdoutMaxBytes 限制，即使最终结果被截断', async () => {
    const text = 'A'.repeat(50)
    sshd = await startFakeSshd({ commands: { cap: { stdout: text, exitCode: 0 } } })
    client = await connect(sshd.port)
    let onDataTotal = ''
    const result = await execRemote(client, {
      command: 'cap', timeoutMs: 5000, stdoutMaxBytes: 5,
      onData: (chunk, which) => { if (which === 'stdout') onDataTotal += chunk },
    })
    expect(result.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(5)
    expect(onDataTotal).toBe(text)
  })

  // ---- I1：onData 抛出的异常不能变成进程崩溃或伪造的断线 ----

  it('onData 抛出的异常被吞掉，不会让 exec 崩溃或误判成连接断开', async () => {
    sshd = await startFakeSshd({ commands: { quick: { stdout: 'hi', exitCode: 0 } } })
    client = await connect(sshd.port)
    const result = await execRemote(client, {
      command: 'quick', timeoutMs: 5000, stdoutMaxBytes: 1024,
      onData: () => { throw new Error('boom from consumer') },
    })
    expect(result.stdout).toBe('hi')
    expect(result.exitCode).toBe(0)
  })

  // ---- Addition C：命令里的 &&、多行、行尾注释不会被 workdir/env 的拼接破坏 ----

  it('命令内部的 && 被包进子 shell，不会被 workdir 的 && 链吞掉短路语义', async () => {
    sshd = await startFakeSshd({ commands: {} })
    client = await connect(sshd.port)
    await execRemote(client, {
      command: 'a && b', timeoutMs: 5000, stdoutMaxBytes: 1024, workdir: '/x',
    })
    expect(sshd.received[0]).toBe(`cd '/x' && (\na && b\n)`)
  })

  it('多行命令被整体包进子 shell，不会在换行处跳出 cd/export 的 && 链', async () => {
    sshd = await startFakeSshd({ commands: {} })
    client = await connect(sshd.port)
    await execRemote(client, {
      command: 'line1\nline2', timeoutMs: 5000, stdoutMaxBytes: 1024, workdir: '/x',
    })
    expect(sshd.received[0]).toBe(`cd '/x' && (\nline1\nline2\n)`)
  })

  it('命令末尾的 # 注释不会吞掉用来包裹的右括号', async () => {
    sshd = await startFakeSshd({ commands: {} })
    client = await connect(sshd.port)
    await execRemote(client, {
      command: 'echo hi # trailing comment', timeoutMs: 5000, stdoutMaxBytes: 1024, workdir: '/x',
    })
    expect(sshd.received[0]).toBe(`cd '/x' && (\necho hi # trailing comment\n)`)
  })

  // I5：上面三个测试只断言了拼出来的字符串长什么样，任何生成同样字符串的
  // 实现都会通过——真正要保证的性质（"cd 失败时，括号里的内容一行都不会
  // 执行"）从没被验证过。这里直接跑真实 /bin/sh，并且带一个朴素拼接（没有
  // 括号包裹）的反面对照组，证明这个测试真的会抓到它想抓的 bug，而不是
  // 凑巧总是通过。
  it('workdir 失败时，包裹后的多行命令一行都不会执行——朴素拼接会踩这个坑（反面对照）', async () => {
    const missingDir = '/definitely-missing-xyz-zzz'
    const wrapped = buildRemoteCommand({ command: 'echo A\necho B', workdir: missingDir })
    const wrappedRun = await runShShell(wrapped)
    expect(wrappedRun.exitCode).not.toBe(0)
    expect(wrappedRun.stdout).toBe('')

    const naive = [`cd ${JSON.stringify(missingDir).replace(/"/g, "'")}`, 'echo A\necho B'].join(' && ')
    const naiveRun = await runShShell(naive)
    expect(naiveRun.stdout).toContain('B') // 朴素拼接：cd 失败，"echo B" 仍然照样执行
  })

  // ---- Addition D：env 的 key 未经转义直接拼进命令，必须校验 ----

  it('拒绝非法的 env key，不让它被当成命令注入', async () => {
    sshd = await startFakeSshd({ commands: {} })
    client = await connect(sshd.port)
    await expect(
      execRemote(client, {
        command: 'x', timeoutMs: 5000, stdoutMaxBytes: 1024, env: { 'X; rm -rf /': 'y' },
      }),
    ).rejects.toThrow(/非法的环境变量名/)
    // 校验在真正 exec 之前就失败，服务器不应该收到任何命令。
    expect(sshd.received).toEqual([])
  })

  // ---- M1：workdir/env 存在但 command 为空白时不能生成语法错误 ----

  it('workdir/env 存在但 command 是空白时，退化成 no-op 而不是语法错误', async () => {
    const built = buildRemoteCommand({ command: '   ', workdir: '/x' })
    expect(built).toBe(`cd '/x' && (\n:\n)`)
    const { exitCode } = await runShShell(built.replace('/x', '/tmp'))
    expect(exitCode).toBe(0)
  })
})
