import { afterEach, describe, expect, it } from 'vitest'
import ssh2 from 'ssh2'
import { execRemote } from '../../src/exec.ts'
import { isSshError } from '../../src/errors.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'

const { Client } = ssh2

let sshd: FakeSshd | undefined
let client: InstanceType<typeof Client> | undefined

afterEach(async () => {
  client?.end(); client = undefined
  await sshd?.close(); sshd = undefined
})

async function connect(port: number) {
  const c = new Client()
  await new Promise<void>((resolve, reject) => {
    c.on('ready', () => resolve()).on('error', reject)
     .connect({ host: '127.0.0.1', port, username: 'tester', password: 'x' })
  })
  return c
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
    expect(result.truncated).toBe(false)
  })

  it('超过 stdoutMaxBytes 时截断并标记', async () => {
    sshd = await startFakeSshd({ commands: { big: { stdout: 'x'.repeat(100), exitCode: 0 } } })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'big', timeoutMs: 5000, stdoutMaxBytes: 10 })
    expect(result.stdout.length).toBe(10)
    expect(result.truncated).toBe(true)
    expect(result.exitCode).toBe(0)   // 截断不改变退出码
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

  // ---- Addition A：连接在拿到手时/执行到一半时已经死了 ----

  it('对已经断开的连接执行命令，返回 SSH_DISCONNECTED 而不是裸错误', async () => {
    sshd = await startFakeSshd({ commands: { quick: { exitCode: 0 } } })
    client = await connect(sshd.port)
    client.end()
    // 给 end() 一点时间真正生效——实测 ssh2 对刚调用过 end() 的连接立刻
    // 再 exec() 也会同步抛 "Not connected"，但这里等一下更贴近"池交出一条
    // 早就死透的连接"这个真实场景。
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(
      execRemote(client, { command: 'quick', timeoutMs: 5000, stdoutMaxBytes: 1024 }),
    ).rejects.toSatisfy((err: unknown) => isSshError(err) && err.code === 'SSH_DISCONNECTED' && err.recoverable)
  })

  it('执行到一半连接断开，返回 SSH_DISCONNECTED 而不是 exitCode:null 的正常结果', async () => {
    sshd = await startFakeSshd({ commands: { slow: { stdout: 'x', delayMs: 3000 } } })
    client = await connect(sshd.port)
    const execPromise = execRemote(client, { command: 'slow', timeoutMs: 5000, stdoutMaxBytes: 1024 })
    setTimeout(() => sshd?.disconnectAll(), 100)
    await expect(execPromise).rejects.toSatisfy(
      (err: unknown) => isSshError(err) && err.code === 'SSH_DISCONNECTED' && err.recoverable,
    )
  })

  // ---- Addition B：stdoutMaxBytes 按字节数（UTF-8），不是按 JS 字符串长度 ----

  it('按字节截断时不会把多字节字符切成乱码', async () => {
    // '中' 在 UTF-8 里是 3 字节；3 个 '中' 是 9 字节。限制 4 字节会砍在
    // 第二个字符的中间——期望砍下去的半个字符被整个丢弃，只留下第一个
    // 完整的 '中'，而不是产生 U+FFFD 替换字符。
    const text = '中'.repeat(3)
    expect(Buffer.byteLength(text, 'utf8')).toBe(9)
    sshd = await startFakeSshd({ commands: { cjk: { stdout: text, exitCode: 0 } } })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'cjk', timeoutMs: 5000, stdoutMaxBytes: 4 })
    expect(result.truncated).toBe(true)
    expect(result.stdout).toBe('中')
    expect(result.stdout).not.toContain('�')
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(4)
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
    // 括号包裹的构造已经用真实 /bin/sh 验证过：cd 失败时括号内两行都不会
    // 执行；这里只验证 execRemote 确实生成了这个安全的包裹形式。
    expect(sshd.received[0]).toBe(`cd '/x' && (\nline1\nline2\n)`)
  })

  it('命令末尾的 # 注释不会吞掉用来包裹的右括号', async () => {
    sshd = await startFakeSshd({ commands: {} })
    client = await connect(sshd.port)
    await execRemote(client, {
      command: 'echo hi # trailing comment', timeoutMs: 5000, stdoutMaxBytes: 1024, workdir: '/x',
    })
    // 右括号被放在单独一行，而不是 `( echo hi # trailing comment )` 同一
    // 行——否则 # 会把行内的右括号也注释掉，导致远端 shell 报
    // "unexpected end of file"（用真实 /bin/sh 验证过）。
    expect(sshd.received[0]).toBe(`cd '/x' && (\necho hi # trailing comment\n)`)
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
})
