import { generateKeyPairSync } from 'node:crypto'
import { Server, type Connection } from 'ssh2'

export interface FakeCommandResult {
  stdout?: string
  stderr?: string
  exitCode?: number
  /** 写完输出后等这么久再关闭 channel，用来测超时与取消。 */
  delayMs?: number
  /** 不返回 exit-status，而是报告被信号杀死。 */
  killedBy?: string
}

export interface FakeSshdOptions {
  /** 命令原文 → 结果。未命中的命令返回 exitCode 127。 */
  commands?: Record<string, FakeCommandResult>
  /** 认证一律失败，用来测认证错误路径。 */
  rejectAuth?: boolean
}

export interface FakeSshd {
  port: number
  hostKeyPublic: string
  /** 记录服务器实际收到的命令，用于断言。 */
  received: string[]
  close(): Promise<void>
}

/** 起一台进程内假 sshd，监听 127.0.0.1 的随机端口。 */
export async function startFakeSshd(options: FakeSshdOptions = {}): Promise<FakeSshd> {
  // 经验证：ssh2 的 keyParser 只认 "BEGIN OPENSSH PRIVATE KEY"（新格式，任意算法）
  // 或 "BEGIN RSA/DSA/EC PRIVATE KEY"（旧 PKCS1 格式），不认通用 PKCS8
  // （"BEGIN PRIVATE KEY"）。Node 的 crypto 给 ed25519 只能导出 PKCS8，
  // 所以 `generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', ... } })`
  // 生成的 host key 会在 `new Server()` 里直接抛出
  // "Cannot parse privateKey: Unsupported key format"。改用 RSA + pkcs1 规避。
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const received: string[] = []
  const openConnections = new Set<Connection>()

  const server = new Server({ hostKeys: [privateKey] }, (client: Connection) => {
    openConnections.add(client)
    client.on('close', () => openConnections.delete(client))
    // 经验证：ssh2 的 Client 总是先发一轮 method 'none' 探测。这里对任何方法
    // （含 'none'）一律 accept()，客户端在 'none' 上就直接进入 ready，完全不必
    // 走完整的 password/publickey 协商——对假 sshd 来说这就够用了，我们不关心
    // 凭据是否正确，只关心"认证成功 / 认证失败"两条路径。
    client.on('authentication', (auth) => {
      if (options.rejectAuth) auth.reject()
      else auth.accept()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          received.push(info.command)
          const result = options.commands?.[info.command] ?? { exitCode: 127, stderr: 'command not found\n' }
          const stream = acceptExec()
          const finish = () => {
            if (result.stdout) stream.write(result.stdout)
            if (result.stderr) stream.stderr.write(result.stderr)
            if (result.killedBy) stream.exit(result.killedBy)
            else stream.exit(result.exitCode ?? 0)
            stream.end()
          }
          if (result.delayMs) setTimeout(finish, result.delayMs)
          else finish()
        })
      })
    })
    client.on('error', () => { /* 测试里断开连接是正常的 */ })
  })

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error(`expected server.address() to return an AddressInfo, got ${JSON.stringify(address)}`)
      }
      resolve(address.port)
    })
  })

  return {
    port,
    hostKeyPublic: publicKey,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        // 显式断开还挂着的连接，否则 server.close() 只停止接受新连接，
        // 回调要等所有已建立连接关闭后才触发——测试忘了断开客户端就会一直挂起。
        for (const conn of openConnections) conn.end()
        server.close(() => resolve())
      }),
  }
}
