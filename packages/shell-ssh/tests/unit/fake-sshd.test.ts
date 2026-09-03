import { createConnection } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
// ssh2 是 CommonJS，具名导入在真实 Node ESM 下会抛 SyntaxError；vitest 的
// esbuild 转译会掩盖这一点（参见 fake-sshd.ts 顶部注释），这里同样改成默认
// 导入再解构，保证脱离 vitest 用 `node --experimental-strip-types` 直接跑
// 也不会炸。
import ssh2 from 'ssh2'
const { Client } = ssh2
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'

let sshd: FakeSshd | undefined
afterEach(async () => { await sshd?.close(); sshd = undefined })

function execOnce(port: number, command: string) {
  return new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
    const client = new Client()
    client
      .on('ready', () => {
        client.exec(command, (err, stream) => {
          if (err) return reject(err)
          let stdout = ''
          stream.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
          stream.on('close', (code: number | null) => { client.end(); resolve({ stdout, code }) })
        })
      })
      .on('error', reject)
      .connect({ host: '127.0.0.1', port, username: 'tester', password: 'x' })
  })
}

describe('startFakeSshd', () => {
  it('执行已注册的命令并返回退出码', async () => {
    sshd = await startFakeSshd({ commands: { 'echo hi': { stdout: 'hi\n', exitCode: 0 } } })
    const result = await execOnce(sshd.port, 'echo hi')
    expect(result.stdout).toBe('hi\n')
    expect(result.code).toBe(0)
    expect(sshd.received).toEqual(['echo hi'])
  })

  it('未注册的命令返回 127', async () => {
    sshd = await startFakeSshd()
    expect((await execOnce(sshd.port, 'nope')).code).toBe(127)
  })

  it('记录真实认证尝试的密码，证明凭据确实被送达而不是被 none 探测蒙混过关', async () => {
    sshd = await startFakeSshd()
    await execOnce(sshd.port, 'echo hi')
    // 'none' 探测总是先发一次且总被拒绝；紧接着必须有一次 method 是
    // 'password'、且带着我们连接时实际用的密码的真实尝试——这才是连接池
    // 确实把 SshCredentials 交给了 ssh2 的证据，而不只是"某次密码尝试发生过"。
    expect(sshd.authAttempts.some((a) => a.method === 'none')).toBe(true)
    expect(sshd.authAttempts).toContainEqual({ method: 'password', username: 'tester', password: 'x' })
  })

  it('close() 在还有一个未完成 SSH 握手的裸 TCP 连接时也能及时返回', async () => {
    sshd = await startFakeSshd()
    // 只建立 TCP 连接、不发送任何数据——ssh2 在这种情况下不会触发它自己的
    // 'connection' 事件，openConnections 看不到这个 socket，只有底层
    // net.Server 知道它的存在。这正是 I1 要修的那类"半握手"连接。
    const socket = createConnection({ host: '127.0.0.1', port: sshd.port })
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve())
      socket.on('error', reject)
    })

    const start = Date.now()
    await sshd.close()
    expect(Date.now() - start).toBeLessThan(4000)

    socket.destroy()
  })
})
