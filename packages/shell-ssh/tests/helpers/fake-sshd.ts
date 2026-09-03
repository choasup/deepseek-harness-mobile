import { generateKeyPairSync } from 'node:crypto'
// ssh2 是 CommonJS（无 "type" 字段、无 exports map），Node 的 cjs-module-lexer
// 静态分析不出它的具名导出：`import { Server } from 'ssh2'` 在真实 Node ESM 下
// 会直接抛 SyntaxError（"Named export 'Server' not found"）。vitest 走 esbuild
// 转译会掩盖这一点，测试照样全绿，但换成 `node --experimental-strip-types`
// 跑同一个文件就会当场炸掉。这里改成默认导入再解构；`Connection` 只作类型用，
// 类型导入会被整个擦除，不受此限制，可以照常具名导入。
import type { Connection } from 'ssh2'
import ssh2 from 'ssh2'
const { Server } = ssh2

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

export interface FakeAuthAttempt {
  method: string
  username: string
}

export interface FakeSshd {
  port: number
  hostKeyPublic: string
  /** 记录服务器实际收到的命令，用于断言。 */
  received: string[]
  /** 记录服务器收到的每次认证尝试，供测试断言凭据确实被送达。 */
  authAttempts: FakeAuthAttempt[]
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
  const authAttempts: FakeAuthAttempt[] = []
  const openConnections = new Set<Connection>()

  const server = new Server({ hostKeys: [privateKey] }, (client: Connection) => {
    openConnections.add(client)
    client.on('close', () => openConnections.delete(client))
    // 经验证：ssh2 的 Client 总是先发一轮 method 'none' 探测。如果对 'none' 也
    // accept()，客户端在这一轮就直接进入 ready，真正的密码/私钥永远不会被发送
    // ——夹具看起来"认证成功"了，但完全没有证明凭据确实被传输过。这对 Task 4
    // 要测的"连接池确实把凭据交给了 ssh2"这件事是不够的，所以这里始终拒绝
    // 'none'，逼客户端走到真实方法（password / publickey）才会被记录和 accept。
    client.on('authentication', (auth) => {
      authAttempts.push({ method: auth.method, username: auth.username })
      if (auth.method === 'none') {
        auth.reject()
        return
      }
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
    authAttempts,
    close: () =>
      new Promise<void>((resolve) => {
        // 显式断开还挂着的连接，否则 server.close() 只停止接受新连接，
        // 回调要等所有已建立连接关闭后才触发——测试忘了断开客户端就会一直挂起。
        for (const conn of openConnections) conn.end()
        server.close(() => resolve())
      }),
  }
}
