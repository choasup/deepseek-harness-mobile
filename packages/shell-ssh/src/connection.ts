// ssh2 是 CommonJS：具名导入在真实 Node ESM 下抛 SyntaxError，而 vitest 能过。
// 这份代码要装进 dsh 用真 Node 跑，所以必须默认导入再解构。
import { createHash } from 'node:crypto'
import ssh2 from 'ssh2'
import type { Client } from 'ssh2'
// SshCredentials 只在 remote-registry 里定义一次；这里复用，避免两处定义漂移。
import type { RemoteMachine, SshCredentials } from '@dsh-mobile/remote-registry'
import { normalizeFingerprint } from '@dsh-mobile/remote-registry'
import { SshError } from './errors.ts'

const { Client: SshClient } = ssh2

export interface SshConnectionPoolOptions {
  /** 为一台机器取认证材料。 */
  credentials(machine: RemoteMachine): Promise<SshCredentials>
  /** TCP + 握手的总超时，默认 15 秒。 */
  connectTimeoutMs?: number
}

/**
 * 对服务器主机公钥的原始字节算指纹，格式与 `ssh-keygen -lf` 打印的一致：
 * sha256 摘要、base64、去掉尾部 padding，前缀 `sha256:`（经 normalizeFingerprint
 * 归一化，与 remote-registry 存储的固定指纹使用同一形状，可以直接比较）。
 *
 * 经验证（非假设）：ssh2 的 `hostVerifier` 在 connect() 选项里不设置
 * `hostHash` 时，收到的就是这份原始 key blob 的 Buffer 本身——不是解析过的
 * ParsedKey 对象，也不是十六进制哈希（那是设置 hostHash 后才会给的形式）。
 * 用一个真实 fake sshd 连接一次、在回调里打印 typeof/isBuffer/length 验证过。
 */
export function fingerprintOfHostKey(hostKeyBlob: Buffer): string {
  return normalizeFingerprint(`sha256:${createHash('sha256').update(hostKeyBlob).digest('base64')}`)
}

/** 按 host:port:user 复用 SSH 连接；断线自动摘除，下次 acquire 重连。 */
export class SshConnectionPool {
  private readonly clients = new Map<string, Client>()
  private readonly pending = new Map<string, Promise<Client>>()
  private readonly options: SshConnectionPoolOptions

  constructor(options: SshConnectionPoolOptions) {
    this.options = options
  }

  get size(): number {
    return this.clients.size
  }

  private static keyOf(machine: RemoteMachine): string {
    return `${machine.user}@${machine.host}:${machine.port}`
  }

  async acquire(machine: RemoteMachine): Promise<Client> {
    const key = SshConnectionPool.keyOf(machine)
    const existing = this.clients.get(key)
    if (existing) return existing
    const inflight = this.pending.get(key)
    if (inflight) return inflight

    // 经验证：`this.connect(...)` 在这里同步执行到它自己的第一个 await 为止
    // 才把一个 pending Promise 交回来，紧接着的 `pending.set` 也是同步的——
    // 两次几乎同时的 acquire()（比如 Promise.all 里那两个）在事件循环让出
    // 控制权之前就已经共享了同一个 `attempt`，不会各自起一条连接。
    const attempt = this.connect(machine, key)
    this.pending.set(key, attempt)
    try {
      return await attempt
    } finally {
      this.pending.delete(key)
    }
  }

  private async connect(machine: RemoteMachine, key: string): Promise<Client> {
    const creds = await this.options.credentials(machine)
    const client = new SshClient()
    const pinnedFingerprint = machine.hostFingerprint
      ? normalizeFingerprint(machine.hostFingerprint)
      : undefined

    await new Promise<void>((resolve, reject) => {
      let settled = false
      // hostVerifier 拒绝时，ssh2 报出的 error 只有 level: 'handshake'，和其他
      // 握手期错误（算法协商失败等）撞在一起分不清——用这个标志位而不是 level
      // 字符串来判定，指纹不匹配就一定走 SSH_FINGERPRINT_MISMATCH 分支。
      let fingerprintMismatch = false

      const settle = (err?: SshError) => {
        if (settled) return
        settled = true
        err ? reject(err) : resolve()
      }

      client.on('ready', () => settle())
      client.on('error', (err) => {
        if (fingerprintMismatch) {
          settle(
            new SshError(
              `主机指纹不匹配：${machine.name} (${machine.host}:${machine.port})，`
                + `已固定 ${pinnedFingerprint}，拒绝连接（可能是中间人攻击，也可能是机器重装/换钥）`,
              'SSH_FINGERPRINT_MISMATCH',
              false,
            ),
          )
          return
        }
        // ssh2 用 level 区分失败阶段：认证失败是终局，其余按可重试处理。
        // 经验证：TCP 拒连是 'client-socket'，认证失败是 'client-authentication'，
        // 且两种情况下 'error' 都先于 'close' 触发（用 Promise executor 里的
        // `settled` 标志保证只有第一个到达的事件真正决定结果）。
        const authFailed = err.level === 'client-authentication'
        settle(
          authFailed
            ? new SshError(`认证被 ${machine.name} 拒绝：${err.message}`, 'SSH_AUTH_FAILED', false)
            : new SshError(
                `连不上 ${machine.name} (${machine.host}:${machine.port})：${err.message}`,
                'SSH_UNREACHABLE',
                true,
              ),
        )
      })
      client.on('close', () => {
        // 这个 handler 常驻（不是 once），承担两个职责：连接建立阶段的失败
        // 上报（靠 settled 标志只生效一次），以及建立之后的自动摘除（每次都
        // 执行，跟 settled 无关）——服务器中途关闭时 'close' 会不带 'error'
        // 单独触发（已用假 sshd 验证过），这时 settle() 已经 no-op，只有
        // delete 生效。
        this.clients.delete(key)
        settle(new SshError(`到 ${machine.name} 的连接已关闭`, 'SSH_DISCONNECTED', true))
      })

      client.connect({
        host: machine.host,
        port: machine.port,
        username: machine.user,
        privateKey: creds.privateKey,
        passphrase: creds.passphrase,
        password: creds.password,
        readyTimeout: this.options.connectTimeoutMs ?? 15_000,
        hostVerifier: (hostKeyBlob: Buffer): boolean => {
          // 没有固定指纹：本次是可信首连（TOFU）。固定 UI 是 Task 9 的事，
          // 这里只负责"固定了就必须匹配"这一半。
          if (!pinnedFingerprint) return true
          if (fingerprintOfHostKey(hostKeyBlob) === pinnedFingerprint) return true
          fingerprintMismatch = true
          return false
        },
      })
    })

    this.clients.set(key, client)
    return client
  }

  async disposeAll(): Promise<void> {
    for (const client of this.clients.values()) client.end()
    // 经验证：client.end() 之后 'close' 是异步触发的（哪怕连接完全建立在
    // 本机回环上），不会在这个同步循环里重入 delete。这里直接清空整个 map，
    // 之后姗姗来迟的 'close' handler 对着已经清空的 map 调用 delete(key) 是
    // 无操作，不会出错。
    this.clients.clear()
    this.pending.clear()
  }
}
