import { createHash, generateKeyPairSync } from 'node:crypto'
import type { Server as NetServer, Socket as NetSocket } from 'node:net'
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
  /**
   * method 为 'password' 时，客户端发来的明文密码。记下具体值而不只是"发生过
   * 一次 password 尝试"，是为了让测试能证明连接池确实把拿到的 SshCredentials
   * 传下去了，而不是随便糊一个密码上去也能连上（ssh2 的 auth.accept() 从不
   * 校验凭据内容，靠它自己测不出这一点）。
   */
  password?: string
  /**
   * method 为 'publickey' 时，客户端公钥数据的 sha256 指纹。只是"这把公钥被
   * 送到了服务器"的证据，不代表签名验证通过——ssh2 对同一把 key 通常会先后
   * 触发一次仅查询（无 signature）和一次带签名的尝试，两条 authAttempts 都
   * 会出现，断言时用 toContainEqual 而不是 toEqual。
   */
  publicKeyFingerprint?: string
}

export interface FakeSshd {
  port: number
  hostKeyPublic: string
  /** 记录服务器实际收到的命令，用于断言。并发执行时到达顺序不保证，断言请用 toContain。 */
  received: string[]
  /** 记录服务器收到的每次认证尝试，供测试断言凭据确实被送达。 */
  authAttempts: FakeAuthAttempt[]
  /**
   * 服务器端捕获到的连接错误（协议错误等）。客户端主动断开也会在这里产生
   * 噪声条目，属于预期；真正有价值的是断言失败时把这个数组打印出来，能看到
   * Tasks 4-7 的代码在服务器一侧实际触发了什么，而不是只看到一个超时。
   */
  errors: Error[]
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
  const errors: Error[] = []
  const openConnections = new Set<Connection>()
  // I1 修复：ssh2 只有在完成 SSH ident 交换之后，才会触发它自己那层
  // 'connection' 事件、把 Connection 对象交给 openConnections。一个已经建立
  // TCP 连接、但还没发 ident 行（或者干脆没打算发）的 socket，对
  // openConnections 完全不可见，但底层 net.Server 仍然把它算作一条活跃连接。
  // 经验证：只要存在这样一个"卡在半握手"的 socket，`server.close()`
  // 就会一直挂起——这在正常测试路径（永远 await 到 ready）里不会发生，但一旦
  // Tasks 4-7 里某个测试在 connect 过程中抛错，afterEach 就会顶着 30s 的
  // hookTimeout 卡死，报出"Hook timed out"而不是真正的断言失败，把 bug 藏起来。
  // 这里的 rawSockets 是 openConnections 的严格超集，兜底覆盖这种情况。
  const rawSockets = new Set<NetSocket>()

  const server = new Server({ hostKeys: [privateKey] }, (client: Connection) => {
    openConnections.add(client)
    client.on('close', () => openConnections.delete(client))
    // 经验证：ssh2 的 Client 总是先发一轮 method 'none' 探测。如果对 'none' 也
    // accept()，客户端在这一轮就直接进入 ready，真正的密码/私钥永远不会被
    // 发送——夹具看起来"认证成功"了，但完全没有证明凭据确实被传输过。这对
    // Task 4 要测的"连接池确实把凭据交给了 ssh2"这件事是不够的，所以这里始终
    // 拒绝 'none'，逼客户端走到真实方法（password / publickey）才会被记录和
    // accept。
    client.on('authentication', (auth) => {
      const entry: FakeAuthAttempt = { method: auth.method, username: auth.username }
      if (auth.method === 'password') entry.password = auth.password
      else if (auth.method === 'publickey') {
        entry.publicKeyFingerprint = createHash('sha256').update(auth.key.data).digest('hex')
      }
      authAttempts.push(entry)

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
    // I3 修复：断开连接是测试里的正常噪声，但真正的协议错误此前被无声吞掉了
    // ——Tasks 4-7 里一个真实 bug 会因此只表现为超时，没有任何诊断信息。
    // 现在把它们都收集到 errors，断言失败时可以打印出来看服务器端实际发生了什么。
    client.on('error', (err) => { errors.push(err) })
  })

  // I1 修复：挂到 ssh2 内部真正的 net.Server 上，捕获"已经 TCP 连接、还没走完
  // SSH 握手"的 socket。`_srv` 是 ssh2 未公开的私有字段，不保证跨版本存在，
  // 所以做存在性检查再用；就算探测失败，下面 close() 里的兜底超时也保证不会
  // 真的卡住一个测试进程——测试夹具宁可在偶发情况下多留一个监听端口，
  // 也不能把一个失败的断言变成 30s 的不透明 hang。
  const internalNetServer = (server as unknown as { _srv?: NetServer })._srv
  if (internalNetServer && typeof internalNetServer.on === 'function') {
    internalNetServer.on('connection', (socket: NetSocket) => {
      rawSockets.add(socket)
      socket.on('close', () => rawSockets.delete(socket))
    })
  }

  const port = await new Promise<number>((resolve, reject) => {
    // I3 修复：listen 失败（比如端口被占用）此前没有任何出路，会让这个
    // Promise 永远 pending，直到外层测试的 hookTimeout 才暴露问题。
    const onListenError = (err: Error) => reject(err)
    server.on('error', onListenError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onListenError)
      // listen 成功之后，Server 级别的 'error' 事件（源自底层 net.Server）
      // 转为记录到 errors，而不是继续 reject 一个早已 settle 的 Promise。
      server.on('error', (err: Error) => errors.push(err))
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error(`expected server.address() to return an AddressInfo, got ${JSON.stringify(address)}`))
        return
      }
      resolve(address.port)
    })
  })

  return {
    port,
    hostKeyPublic: publicKey,
    received,
    authAttempts,
    errors,
    close: () =>
      new Promise<void>((resolve) => {
        // 显式断开还挂着的连接，否则 server.close() 只停止接受新连接，
        // 回调要等所有已建立连接关闭后才触发——测试忘了断开客户端就会一直挂起。
        for (const conn of openConnections) conn.end()
        // I1 修复：同样显式销毁还没完成 SSH 握手的原始 socket（见上面
        // rawSockets 的注释），它们对 openConnections 不可见，但一样会让
        // server.close() 卡住。
        for (const socket of rawSockets) socket.destroy()

        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        server.close(finish)
        // 兜底：万一上面两轮清理漏掉了什么（比如未来 ssh2 版本改了 `_srv`
        // 这个私有字段名，导致 rawSockets 探测从一开始就没接上），close()
        // 也必须在有限时间内返回。测试夹具绝不能把一个失败的断言变成
        // 30 秒的 hook 超时——留下一个孤儿监听端口是便宜得多的失败模式。
        setTimeout(finish, 1000)
      }),
  }
}
