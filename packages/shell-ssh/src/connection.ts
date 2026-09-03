// ssh2 是 CommonJS：具名导入在真实 Node ESM 下抛 SyntaxError，而 vitest 能过。
// 这份代码要装进 dsh 用真 Node 跑，所以必须默认导入再解构。
import { createHash } from 'node:crypto'
import ssh2 from 'ssh2'
import type { Client } from 'ssh2'
// SshCredentials 只在 remote-registry 里定义一次；这里复用，避免两处定义漂移。
import type { RemoteMachine, SshCredentials } from '@dsh-mobile/remote-registry'
import { normalizeFingerprint } from '@dsh-mobile/remote-registry'
import { isSshError, SshError } from './errors.ts'

const { Client: SshClient } = ssh2

export interface SshConnectionPoolOptions {
  /** 为一台机器取认证材料。 */
  credentials(machine: RemoteMachine): Promise<SshCredentials>
  /** TCP + 握手的总超时，默认 15 秒。 */
  connectTimeoutMs?: number
  /**
   * 一条已经 ready 过的连接后来断线或出错时的通知钩子。池只负责"摘除+
   * 上报"，不负责"通知谁去重连"——重连是下一次 acquire() 自然发生的事。
   *
   * 这条钩子存在的原因：握手阶段的失败会通过 acquire() 的 rejection 直接
   * 交给调用方，但 ready 之后的失败没有一个天然的"调用方"在等着——没人在
   * await 一个已经 resolve 过的 Promise。以前的实现里，握手阶段和 ready
   * 之后共用同一个 close/error 监听器，靠 `settled` 标志让第二次触发变成
   * no-op——这意味着 ready 之后的真实错误被无声吞掉，调用方唯一能看到的
   * 后果是 pool.size 悄悄减一。有了这个钩子，池至少能把"发生了什么"报出去；
   * 具体怎么处理（重试、告警）留给上层。
   */
  onDisconnect?(machine: RemoteMachine, error?: Error): void
}

/**
 * 对服务器主机公钥的原始字节算指纹，格式与 `ssh-keygen -lf` 打印的一致：
 * sha256 摘要、base64、去掉尾部 padding，前缀 `sha256:`（经 normalizeFingerprint
 * 归一化，与 remote-registry 存储的固定指纹使用同一形状，可以直接比较）。
 *
 * 经验证（非假设，非道听途说）：
 * - ssh2 的 `hostVerifier` 在 connect() 选项里不设置 `hostHash` 时，收到的
 *   就是这份原始 key blob 的 Buffer 本身——不是解析过的 ParsedKey 对象，
 *   也不是十六进制哈希（那是设置 hostHash 后才会给的形式）。
 * - 这个函数的输出与真实 `ssh-keygen -lf` 的输出逐字节一致——但只有在
 *   `ssh-keygen -lf` 吃的是 OpenSSH 格式公钥（`ssh-rsa AAAA...`）时才成立。
 *   直接把 fake sshd 生成的 SPKI PEM（"BEGIN PUBLIC KEY"）丢给
 *   `ssh-keygen -lf` 会被拒绝（"is not a public key file"）——必须先
 *   `ssh-keygen -i -m PKCS8 -f` 转换成 OpenSSH 格式，`-lf` 才认。这一点在
 *   本文件的测试里也用真实 ssh-keygen 子进程验证过，不是自证。
 */
export function fingerprintOfHostKey(hostKeyBlob: Buffer): string {
  return normalizeFingerprint(`sha256:${createHash('sha256').update(hostKeyBlob).digest('base64')}`)
}

/**
 * 按 `user@host:port` 复用 SSH 连接；断线自动摘除，下次 acquire 重连。
 *
 * 生命周期边界很重要：`acquire()` 返回的是一条在**取用那一刻**是活的连接，
 * 不保证在调用方真正拿它去 exec 的那一刻还活着——期间完全可能断线。池不
 * 负责 exec 期间的存活检测，那是 Task 5 的事：exec 时如果连接已经死了，
 * Task 5 自己要把这种失败映射成 SSH_DISCONNECTED，而不是指望这个池提前
 * 发现。
 */
export class SshConnectionPool {
  private readonly clients = new Map<string, Client>()
  /** key -> 建连时实际校验通过的指纹（未固定则为 undefined）。见 acquire() 里的复用判断。 */
  private readonly verifiedFingerprints = new Map<string, string | undefined>()
  private readonly pending = new Map<string, Promise<Client>>()
  private readonly options: SshConnectionPoolOptions
  /**
   * disposeAll() 每次调用递增。一条正在建连的连接完成握手后，会拿自己开始
   * 建连时记下的世代号跟这个值比较——不一致说明池在它握手期间被清空过，
   * 这条连接不该被复活进一个新世代的池里，直接关掉。用计数器而不是一个
   * `disposed: boolean`，是因为 disposeAll() 之后池还要能继续正常工作
   * （当前测试不这么用，但 Task 7 的 cordis 生命周期——重建/reload 插件——
   * 可能会连续 dispose 多次后继续 acquire，一个一次性的布尔标志会把池锁死）。
   */
  private generation = 0

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
    const requestedFingerprint = machine.hostFingerprint
      ? normalizeFingerprint(machine.hostFingerprint)
      : undefined

    const existing = this.clients.get(key)
    if (existing) {
      // I1 修复：缓存命中不能跳过指纹校验。旧连接可能是在没有固定指纹时
      // 用可信首连（TOFU）建立的；如果调用方现在带着一个已固定的指纹来
      // acquire 同一台机器，必须重新验证，而不是把从未验证过的连接原样
      // 交出去——那样 Task 9 的指纹固定 UI 形同虚设：固定之后，池里躺着
      // 的旧连接依然是没人验证过的那一条。指纹相同（含都是 undefined）
      // 才复用；否则摘除重连。
      if (this.verifiedFingerprints.get(key) === requestedFingerprint) return existing
      this.evict(key, existing)
    }

    const inflight = this.pending.get(key)
    if (inflight) return inflight

    // 经验证：`this.connect(...)` 在这里同步执行到它自己的第一个 await 为止
    // 才把一个 pending Promise 交回来，紧接着的 `pending.set` 也是同步的——
    // 两次几乎同时的 acquire()（比如 Promise.all 里那两个）在事件循环让出
    // 控制权之前就已经共享了同一个 `attempt`，不会各自起一条连接。
    const attempt = this.connect(machine, key, requestedFingerprint)
    this.pending.set(key, attempt)
    try {
      return await attempt
    } finally {
      this.pending.delete(key)
    }
  }

  /** 摘除并挂断池里 key 对应的连接——仅当它确实还是 client 自己占着这个位置时。 */
  private evict(key: string, client: Client): void {
    // I2 修复：按身份而不是按 key 摘除。如果这个 key 此刻已经指向一个
    // 更新的 client（典型场景：一条迟到的 'close' 事件来自一个早就被替换
    // 掉的旧连接），绝不能把新连接从 map 里删掉。
    if (this.clients.get(key) === client) {
      this.clients.delete(key)
      this.verifiedFingerprints.delete(key)
    }
    client.end()
  }

  private async connect(
    machine: RemoteMachine,
    key: string,
    pinnedFingerprint: string | undefined,
  ): Promise<Client> {
    const generation = this.generation
    let creds: SshCredentials
    try {
      creds = await this.options.credentials(machine)
    } catch (err) {
      // I7 修复：凭据提供方可能抛任何东西（读文件失败、解密失败、网络……），
      // 之前这里没有 try/catch，会原样冒泡出一个非 SshError 的异常。
      // Tasks 6/7 靠 isSshError 做路由，一个漏网的裸 Error 会让它们的
      // switch/if 链落到 default 分支，处理成"未知错误"而不是"认证问题"。
      if (isSshError(err)) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new SshError(`取 ${machine.name} 的凭据失败：${message}`, 'SSH_AUTH_FAILED', false)
    }

    const client = new SshClient()
    await this.handshake(client, machine, pinnedFingerprint, creds)

    // C1 修复：池可能在这条连接握手期间被 disposeAll() 清空过。握手本身
    // 是纯粹的"连没连上"判定，不知道外面发生了什么；这里用世代号补上这个
    // 检查——世代号变了，说明这条握手成功的连接已经没有池要它了，关掉它、
    // 抛错，而不是把它塞回一个刚清空的池，造成"disposeAll 之后连接又活过
    // 来了"的资源泄漏（已用一个"disposeAll 恰好在握手中途执行"的测试
    // 复现过：修复前 size 会在这之后从 0 变回 1）。
    if (generation !== this.generation) {
      client.end()
      throw new SshError(`连接池已释放，丢弃 ${machine.name} 的这次连接尝试`, 'SSH_DISCONNECTED', true)
    }

    this.clients.set(key, client)
    this.verifiedFingerprints.set(key, pinnedFingerprint)
    this.watchForDisconnect(client, machine, key)
    return client
  }

  /**
   * 只负责判定"这次连接尝试是连上了还是失败了"，settle 一次就把自己注册
   * 的监听器摘干净——不管连接后续的生命周期，那是 watchForDisconnect 的
   * 职责。settle() 的 `settled` 标志保证第二次及以后的触发是 no-op——但
   * 关键是这些监听器**永久留着，不摘掉**。曾经尝试过握手一 settle 就
   * `removeListener` 干净：一条握手失败（比如认证被拒）的连接，它的底层
   * socket 有时会在那之后又收到一次迟到的 ECONNRESET（真实网络行为，不是
   * 猜测——本地跑一遍完整测试套件就能稳定复现 3 次 "Uncaught Exception:
   * read ECONNRESET"）。这条连接已经没有调用方持有引用，`watchForDisconnect`
   * 也没机会挂上去（握手失败的连接根本不会走到那一步）——监听器一旦被摘掉，
   * 这个迟到的 'error' 事件在 EventEmitter 上就找不到任何监听者，Node 的
   * 默认行为是直接把它当未捕获异常扔出来，能打崩整个进程。留着这些监听器
   * （靠 settled 挡掉重复处理）双重达成目的：吞掉握手失败连接后续的噪声，
   * 也保证 ready 之后的连接在 watchForDisconnect 的监听器之外，永远还有
   * 这一路监听器兜底。
   */
  private handshake(
    client: Client,
    machine: RemoteMachine,
    pinnedFingerprint: string | undefined,
    creds: SshCredentials,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      // hostVerifier 拒绝时，ssh2 报出的 error 只有 level: 'handshake'，和
      // 其他握手期错误（算法协商失败等）撞在一起分不清——用这个标志位而
      // 不是 level 字符串来判定，指纹不匹配就一定走
      // SSH_FINGERPRINT_MISMATCH 分支。
      let fingerprintMismatch = false

      const settle = (err?: SshError) => {
        if (settled) return
        settled = true
        err ? reject(err) : resolve()
      }

      client.on('ready', () => settle())
      client.on('error', (err: Error & { level?: string }) => {
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
        // 且两种情况下 'error' 都先于 'close' 触发。这里如果已经 settled
        // （典型场景：ready 之后的连接出的错，或者握手失败连接后续的噪声），
        // settle() 是 no-op——真正要"被人听见"的 ready 之后错误，靠下面
        // watchForDisconnect 挂的另一路监听器。
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
        settle(new SshError(`到 ${machine.name} 的连接在完成握手前就已关闭`, 'SSH_DISCONNECTED', true))
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
  }

  /**
   * 连接 ready 之后才挂上的监听器，管的是"这条已经建立好的连接后来怎么
   * 样了"，跟 handshake() 的监听器完全独立（互不残留）。
   */
  private watchForDisconnect(client: Client, machine: RemoteMachine, key: string): void {
    client.on('close', () => {
      // I2 修复：只在这个 key 此刻仍然指向这个 client 时才摘除——见 evict()
      // 里同样的身份检查，这里是它的另一处必要场景：一条已经被 acquire()
      // 的指纹不匹配分支摘除、随后 end() 掉的旧连接，它的 'close' 是异步
      // 到达的，到达时 key 可能早就指向了新连接。
      if (this.clients.get(key) === client) {
        this.clients.delete(key)
        this.verifiedFingerprints.delete(key)
      }
      this.options.onDisconnect?.(machine)
    })
    client.on('error', (err: Error) => {
      // 'error' 之后紧跟着的 'close' 会负责摘除，这里不重复摘除，只负责
      // 把错误对象带给 onDisconnect（'close' 时错误信息已经丢了）。
      this.options.onDisconnect?.(machine, err)
    })
  }

  async disposeAll(): Promise<void> {
    // C1 修复：先递增世代号，这样任何仍在握手中的 connect() 在稍后完成时
    // 都能发现自己"跟不上趟了"，自己关掉、不进入下面清空之后的池。
    this.generation++

    const clients = [...this.clients.values()]
    this.clients.clear()
    this.verifiedFingerprints.clear()
    this.pending.clear()

    // 之前这里只调用 client.end() 就立刻返回，disposeAll() 的 Promise 在
    // 任何一个 socket 真正关闭之前就 resolve 了——调用方以为"释放完了"，
    // 实际上握手/清理仍在后台跑。现在等到每条连接真的触发 'close' 再算数
    // （2 秒兜底超时防止一个卡住的 socket 让 disposeAll 永远挂起，跟
    // fake sshd 自己 close() 的兜底是同一个道理）。
    await Promise.all(clients.map((client) => SshConnectionPool.awaitClose(client)))
  }

  private static awaitClose(client: Client): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      client.once('close', finish)
      client.end()
      setTimeout(finish, 2_000)
    })
  }
}
