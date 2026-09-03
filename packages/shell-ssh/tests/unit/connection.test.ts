import { afterEach, describe, expect, it } from 'vitest'
// ssh2 是 CommonJS：具名导入在真实 Node ESM 下抛 SyntaxError，vitest 的 esbuild
// 转译会掩盖这一点。这里跟 fake-sshd.ts / connection.ts 保持一致的写法。
import ssh2 from 'ssh2'
import { SshConnectionPool, fingerprintOfHostKey } from '../../src/connection.ts'
import { SshError } from '../../src/errors.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'

const { Client: SshClient } = ssh2

let sshd: FakeSshd | undefined
let pool: SshConnectionPool | undefined

afterEach(async () => {
  await pool?.disposeAll(); pool = undefined
  await sshd?.close(); sshd = undefined
})

function machineFor(port: number): RemoteMachine {
  return { name: 'test', host: '127.0.0.1', port, user: 'tester', keyRef: 'REMOTE_KEY_TEST', tags: [] }
}

/**
 * 用一条独立于 SshConnectionPool 的连接去问服务器"你的主机指纹是什么"，
 * 用来在"匹配"测试里事先拿到一个会通过校验的合法值——不能反过来用连接池
 * 自己算出来的指纹去测连接池，那样测试和实现共享同一个 bug 也测不出来。
 */
function captureHostFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const probe = new SshClient()
    probe.on('ready', () => probe.end())
    probe.on('error', (err) => reject(err))
    probe.connect({
      host: '127.0.0.1',
      port,
      username: 'tester',
      password: 'x',
      hostVerifier: (hostKeyBlob: Buffer): boolean => {
        resolve(fingerprintOfHostKey(hostKeyBlob))
        return true
      },
    })
  })
}

describe('SshConnectionPool', () => {
  it('同一台机器复用同一条连接', async () => {
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    const machine = machineFor(sshd.port)
    const [a, b] = await Promise.all([pool.acquire(machine), pool.acquire(machine)])
    expect(a).toBe(b)
    expect(pool.size).toBe(1)
  })

  it('连不上时抛 SSH_UNREACHABLE 且标记为可恢复', async () => {
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    // 端口 1 上不会有 sshd
    await expect(pool.acquire(machineFor(1))).rejects.toSatisfy(
      (err: unknown) => err instanceof SshError && err.code === 'SSH_UNREACHABLE' && err.recoverable,
    )
  })

  it('认证失败时抛 SSH_AUTH_FAILED 且标记为不可恢复', async () => {
    sshd = await startFakeSshd({ rejectAuth: true })
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'wrong' }) })
    await expect(pool.acquire(machineFor(sshd.port))).rejects.toSatisfy(
      (err: unknown) => err instanceof SshError && err.code === 'SSH_AUTH_FAILED' && !err.recoverable,
    )
  })

  it(
    '服务器关闭后自动从池中摘除；对受影响的机器再次 acquire 能连上新服务器并拿到不同的 Client 实例',
    async () => {
      // 这个测试证明两件事：
      //   1) 断线后 pool.size 掉到 0——池确实把死连接摘除了（这是核心断言）。
      //   2) 摘除之后再 acquire() 能连上一台活着的服务器，拿到的是一个新的
      //      Client 实例，不是之前那个已经关闭的对象。
      // 它不证明"对完全相同的 host:port 断线重连"——fake sshd 用
      // `listen(0, ...)` 让操作系统分配随机端口，没有提供在同一端口上
      // 重新监听的能力（这是 Task 3 夹具的固有限制，不在本任务范围内改动），
      // 所以这里第二台服务器不可避免地换了端口，即池的 key（host:port:user）
      // 也跟着变了——"同一条 key 断线后重连复用" 这个更强的说法，本测试
      // 无法在当前夹具下验证。
      sshd = await startFakeSshd()
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const clientBefore = await pool.acquire(machineFor(sshd.port))
      expect(pool.size).toBe(1)

      await sshd.close()
      await new Promise((r) => setTimeout(r, 50))
      expect(pool.size).toBe(0) // 断线后自动从池里摘除

      sshd = await startFakeSshd()
      const clientAfter = await pool.acquire(machineFor(sshd.port))
      expect(pool.size).toBe(1)
      expect(clientAfter).not.toBe(clientBefore)
    },
  )

  it('disposeAll 清空连接池', async () => {
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    await pool.acquire(machineFor(sshd.port))
    await pool.disposeAll()
    expect(pool.size).toBe(0)
  })

  it('把 credentials() 返回的密码原样传给 ssh2，而不是随便一个值也能连上', async () => {
    sshd = await startFakeSshd()
    const distinctivePassword = 'correct-horse-battery-staple'
    pool = new SshConnectionPool({ credentials: async () => ({ password: distinctivePassword }) })
    await pool.acquire(machineFor(sshd.port))

    // 客户端总会先发一轮 method 'none' 的探测，夹具总是拒绝它；真正有意义
    // 的是紧接着那次带着我们实际密码的 'password' 尝试。用 toContainEqual
    // 而不是 toEqual 整个数组，因为 'none' 那条噪声条目也在数组里。
    expect(sshd.authAttempts.some((a) => a.method === 'none')).toBe(true)
    expect(sshd.authAttempts).toContainEqual({
      method: 'password',
      username: 'tester',
      password: distinctivePassword,
    })
  })

  describe('主机指纹校验', () => {
    it('未固定指纹时按可信首连处理，正常连接', async () => {
      sshd = await startFakeSshd()
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const client = await pool.acquire(machineFor(sshd.port))
      expect(client).toBeDefined()
      expect(pool.size).toBe(1)
    })

    it('指纹与已固定值匹配时正常连接', async () => {
      sshd = await startFakeSshd()
      const fingerprint = await captureHostFingerprint(sshd.port)
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const machine = { ...machineFor(sshd.port), hostFingerprint: fingerprint }
      const client = await pool.acquire(machine)
      expect(client).toBeDefined()
      expect(pool.size).toBe(1)
    })

    it('指纹与已固定值不符时拒绝连接，标记为不可恢复，且不留下任何连接', async () => {
      sshd = await startFakeSshd()
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const wrongFingerprint = `sha256:${'A'.repeat(43)}`
      const machine = { ...machineFor(sshd.port), hostFingerprint: wrongFingerprint }
      await expect(pool.acquire(machine)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof SshError && err.code === 'SSH_FINGERPRINT_MISMATCH' && !err.recoverable,
      )
      // 硬失败，不能悄悄留下一条"半信任"的连接。
      expect(pool.size).toBe(0)
    })
  })
})
