// ssh2 是 CommonJS：具名导入在真实 Node ESM 下抛 SyntaxError，而 vitest 能过。
// 这份代码要装进 dsh 用真 Node 跑，所以必须默认导入再解构。
import { createHash } from 'node:crypto'
import ssh2 from 'ssh2'
import type { Client } from 'ssh2'
// SshCredentials 只在 remote-registry 里定义一次；这里复用，避免两处定义漂移。
import type { RemoteMachine, SshCredentials } from '@dsh-mobile/remote-registry'
import { isMissingCredentialError, normalizeFingerprint } from '@dsh-mobile/remote-registry'
import { isSshError, SshError } from './errors.ts'

const { Client: SshClient } = ssh2

/**
 * 判定 `Client#connect()` 的同步抛出是不是"privateKey 用不了"这一类——
 * 见 handshake() 里对这条正则的用法与详细注释（Task 7 二审 I3）。
 */
const PRIVATE_KEY_ERROR_RE = /privateKey/i

export interface SshConnectionPoolOptions {
  /** 为一台机器取认证材料。 */
  credentials(machine: RemoteMachine): Promise<SshCredentials>
  /** TCP + 握手的总超时，默认 15 秒。 */
  connectTimeoutMs?: number
  /**
   * ssh2 自身的存活探测间隔（毫秒）。未设置或 0 时沿用 ssh2 的默认值——
   * 关闭。Task 7 复审 M2：黑洞连接（手机从 Wi-Fi 切到蜂窝网络时对端不再
   * 响应任何东西，但本地 socket 表面上还"活着"）在关闭 keepalive 的情况下
   * 永远不会自己触发 'error'/'close'——唯一能发现它已经死了的时机是"下
   * 一次真的往这条连接上发数据"（比如下一次 exec()），而 exec.ts 的
   * channel-open 超时只覆盖单次调用，连接本身在两次调用之间可以无限期地
   * 假装健康。设了这个值之后，ssh2 会按周期发 keepalive 包，连续
   * `keepaliveCountMax` 次没有回应就主动判定连接已死、触发
   * 'error'/'close'——池照常摘除它（走 watchForDisconnect 已有的路径，
   * 不需要额外代码），下次 acquire() 重新连接。
   */
  keepaliveInterval?: number
  /** 连续多少次 keepalive 没有回应就判定连接已死。ssh2 自己的默认值是 3。 */
  keepaliveCountMax?: number
  /**
   * 一条已经 ready 过的连接后来断线或出错时的通知钩子。池只负责"摘除+
   * 上报"，不负责"通知谁去重连"——重连是下一次 acquire() 自然发生的事。
   *
   * 这条钩子存在的原因：握手阶段的失败会通过 acquire() 的 rejection 直接
   * 交给调用方，但 ready 之后的失败没有一个天然的"调用方"在等着——没人在
   * await 一个已经 resolve 过的 Promise。有了这个钩子，池至少能把"发生了
   * 什么"报出去；具体怎么处理（重试、告警）留给上层。
   *
   * 约定的调用契约（跟实现一起改过一轮，写下来避免下次又漂移）：
   * - **每条连接的每次意外断线，最多触发一次**——即使 ssh2 先后发出
   *   'error' 再 'close' 这一对事件（实测：把 ready 之后的连接底层
   *   socket 强行摧毁，观察到的顺序确实是 `error` 然后紧跟 `close`），
   *   也只会收到一次调用，`error` 参数携带那次 'error' 事件的错误对象
   *   （如果有）。
   * - **只报告意外断线，不报告池自己主动关掉的连接**——`evict()`（指纹
   *   校验触发的摘除重连）和 `disposeAll()` 关闭的连接不会触发这个钩子。
   *   调用方不需要（也不应该）把"我自己主动换了一条连接"当成一次
   *   "断线"来处理。
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
  /**
   * key -> 这条缓存连接是**按哪个 pin 要求**建立/验证的（未固定则为
   * undefined）。只用于 acquire() 的复用判断——"现在这次调用要求的 pin，
   * 跟缓存连接当初满足的 pin 要求是否一致"，不是"这台主机真实的指纹"。
   * 两者在 TOFU 时不是一回事：未固定时这里存 undefined，但握手其实已经
   * 看到了一个具体的指纹值；那个真正观测到的值存在 observedFingerprints
   * 里，见其注释。不要把两个用途合并成一张表——合并后同一台未固定指纹的
   * 机器连续 acquire 两次，第二次会因为"观测值 !== undefined"被误判成
   * "pin 要求变了"，平白摘除重连一条刚建好的健康连接。
   */
  private readonly verifiedFingerprints = new Map<string, string | undefined>()
  /**
   * key -> 这条缓存连接的 hostVerifier 实际观测到的主机指纹。C2 修复：
   * 之前只有上面那张表，TOFU 时存的是 undefined（"没有 pin 要求"），
   * 于是握手时算出来的真实指纹只活在 handshake() 的闭包里，握手一结束
   * 就丢了——探针需要在首次连接后把这个值报给用户去固定，而池里根本
   * 没地方能读到它。见 observedFingerprintFor()。
   */
  private readonly observedFingerprints = new Map<string, string>()
  private readonly pending = new Map<string, Promise<Client>>()
  /**
   * 池自己主动关掉的连接——evict()（指纹校验触发的摘除重连、或者一场
   * "赢家通吃"的并发重连里被顶替的一方）和 disposeAll() 都会先把 client
   * 加进来再调用 end()。watchForDisconnect 的 'close' 处理器看到这里有
   * 记录，就知道这次关闭是意料之中的，不该当成 onDisconnect 意义上的
   * "断线"报出去。
   */
  private readonly intentionallyClosed = new WeakSet<Client>()
  /**
   * 记录 ready 之后那次 'error' 事件带的错误，供随后必然跟着来的 'close'
   * 取用——两者合并成 onDisconnect 的一次调用，而不是各触发一次（实测
   * ssh2 对一次真实故障总是先 'error' 后 'close'，参见 onDisconnect 的
   * 文档注释）。
   */
  private readonly pendingDisconnectError = new WeakMap<Client, Error>()
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
    if (inflight) {
      // C2 修复：这条分支之前直接 `return inflight`，完全跳过指纹校验——
      // 一个带着已固定指纹的 acquire() 撞上一条别人发起的、未固定指纹的
      // in-flight 连接，会原样拿到那条从来没按自己的指纹验证过的连接，
      // 而且是"成功"地拿到，不是报错。这正是 I1 要防的场景，只是它活在
      // pending 这条路径上没被堵上——Task 9 一边写指纹固定，一边可能有
      // 别的调用方正在 acquire 同一台机器，就会撞上这个口子。等它结束后
      // 照 acquire()"缓存命中"分支同样的规则比较：指纹相同才复用，否则
      // 摘除、落到下面重新建连（重新建连时会真的用 requestedFingerprint
      // 去校验）。
      const client = await inflight
      if (this.verifiedFingerprints.get(key) === requestedFingerprint) return client
      this.evict(key, client)
    }
    // 上面这条 in-flight 分支如果失败（inflight 被 reject），`await inflight`
    // 会让当前这次 acquire() 原样带着那个失败继续往外抛，不会走到下面重新
    // 建连——机器连不上或者认证被拒是这台机器此刻的客观状态，跟请求方用
    // 哪个指纹去问无关，重新起一次只会更慢地拿到同一个错误。

    // 经验证：`this.connect(...)` 在这里同步执行到它自己的第一个 await 为止
    // 才把一个 pending Promise 交回来，紧接着的 `pending.set` 也是同步的——
    // 两次几乎同时的 acquire()（比如 Promise.all 里那两个）在事件循环让出
    // 控制权之前就已经共享了同一个 `attempt`，不会各自起一条连接。
    //
    // 例外：上面 in-flight 分支里因指纹不符摘除重连的这条路径不受这条
    // 保证覆盖——两个几乎同时到达、都撞上同一条待验证连接的调用者，会
    // 分别在各自的微任务里独立摘除、独立起一条新连接，彼此看不到对方也
    // 在重连（这里不会重新检查一次 `pending`）。已知的残留竞态，不是本次
    // 修复的目标；下面 `connect()` 里 `this.clients.set` 前的顶替检查
    // 保证这种情况下不会真的泄漏连接，只是不够"合并"。
    const attempt = this.connect(machine, key, requestedFingerprint)
    this.pending.set(key, attempt)
    try {
      return await attempt
    } finally {
      // C3 修复：按身份而不是按 key 摘除 pending 条目。场景：acquire-1
      // 发起 attemptA；disposeAll() 清空 pending（attemptA 仍在后台跑）；
      // acquire-2 为同一个 key 发起 attemptB、装进 pending；attemptA 随后
      // 因为世代号不匹配而失败，它的这个 finally 如果无条件按 key 删，会
      // 把刚装进去的 attemptB 条目错误摘除——下一个 acquire-3 找不到
      // attemptB，会再起一条 attemptC，池里只记得住最后一个 set 进去的，
      // 前一条变成一条没有任何句柄能关掉的活连接（已用测试复现：不加这个
      // 判断时，acquire-2 和 acquire-3 最终会是两个不同的 Client 实例）。
      if (this.pending.get(key) === attempt) this.pending.delete(key)
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
      this.observedFingerprints.delete(key)
    }
    // I8 修复：这是池自己决定要关掉的连接（指纹不再匹配），不是一次意外
    // 断线——标记一下，watchForDisconnect 的 'close' 处理器看到会跳过
    // onDisconnect 通知。
    this.intentionallyClosed.add(client)
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
      // remote-registry 的 credentialsFor() 在这台机器从没 setPrivateKey
      // 过时会抛 MissingCredentialError，而不是返回 {} 悄悄落到"无认证
      // 材料"分支。这里必须单独识别它、映射成 SSH_NO_CREDENTIAL，不能
      // 落进下面 SSH_AUTH_FAILED 的兜底——"去配一把密钥"和"你配的密钥
      // 不对"是两种要求用户做完全不同事情的错误，混成同一个 code 会让
      // Tasks 6/7 里按 code 分流的处理逻辑给出错误的指引。用
      // isMissingCredentialError 而不是裸 instanceof，因为这个类是从
      // 另一个包 import 进来的。
      if (isMissingCredentialError(err)) {
        throw new SshError(err.message, 'SSH_NO_CREDENTIAL', false)
      }
      const message = err instanceof Error ? err.message : String(err)
      throw new SshError(`取 ${machine.name} 的凭据失败：${message}`, 'SSH_AUTH_FAILED', false)
    }

    const client = new SshClient()
    // C2 修复：handshake() 现在把 hostVerifier 实际观测到的指纹带出来。
    // 这个值单独存进 observedFingerprints（见该字段注释），不能拿它去
    // 替换下面 verifiedFingerprints 存的 pinnedFingerprint——那张表存的是
    // "这条连接是按哪个 pin 要求建的"，用于 acquire() 判断缓存是否还能
    // 复用；TOFU 时两者不是一回事：pin 要求是 undefined，但观测值是一个
    // 具体的指纹字符串，把后者错存进前者会导致同一台未固定指纹的机器
    // 连续 acquire 两次时，第二次因为"观测值 !== undefined"而被误判成
    // pin 要求变了，平白摘除重连一条刚建好的健康连接。
    const observedFingerprint = await this.handshake(client, machine, pinnedFingerprint, creds)

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

    // 兜底防线，不是本次修复的主路径：`acquire()` 里已知有一条残留竞态
    // ——两个几乎同时到达、都撞上同一条待验证连接的调用者会各自独立摘除、
    // 独立重连（见 acquire() 里的注释），两条新连接都可能成功，最终会有
    // 一条"赢家通吃"地留在 `this.clients`，另一条被顶替。顶替发生时绝不能
    // 让被顶替的那条悄悄泄漏——它已经完成了握手、已经发送过凭据，是一条
    // 真实存活的连接，找不到句柄的话跟 C3 是同一类问题，只是入口不同。
    const displaced = this.clients.get(key)
    if (displaced && displaced !== client) {
      this.intentionallyClosed.add(displaced)
      displaced.end()
    }

    this.clients.set(key, client)
    this.verifiedFingerprints.set(key, pinnedFingerprint)
    // handshake() 只在握手真正走到 hostVerifier 并成功 settle 时才会给出
    // 一个定义了的值——理论上 ready 事件不可能不经过 hostVerifier 就触发，
    // 这里仍用 `if` 而不是断言，避免 ssh2 内部实现细节变化时静默存入一个
    // 从未出现过的 undefined 覆盖掉上一次可能还有效的观测值。
    if (observedFingerprint) this.observedFingerprints.set(key, observedFingerprint)
    this.watchForDisconnect(client, machine, key)
    return client
  }

  /**
   * 这条连接为该机器实际观测到的主机指纹；没有一条建立好的连接时返回
   * undefined。TOFU（首次连接、尚未固定指纹）之后，这就是用户需要拿去
   * 固定的那个值——Task 9 的探针（remote-registry 的 probeMachine）就是
   * 靠它产出 `discoveredFingerprint`。已固定指纹的连接这里返回的是同一个
   * 值（不匹配的话根本连不上，见 handshake() 的 hostVerifier），跟
   * `machine.hostFingerprint` 一致，只是多了一条独立观测的印证。
   */
  observedFingerprintFor(machine: RemoteMachine): string | undefined {
    return this.observedFingerprints.get(SshConnectionPool.keyOf(machine))
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
  ): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve, reject) => {
      let settled = false
      // hostVerifier 拒绝时，ssh2 报出的 error 只有 level: 'handshake'，和
      // 其他握手期错误（算法协商失败等）撞在一起分不清——用这个标志位而
      // 不是 level 字符串来判定，指纹不匹配就一定走
      // SSH_FINGERPRINT_MISMATCH 分支。
      let fingerprintMismatch = false
      // C2 修复：hostVerifier 是唯一算过原始 host key blob 指纹的地方；
      // 不管走的是"没有固定值，随便接受"（TOFU）还是"比对固定值"分支，
      // 都先把这次实际观测到的指纹记下来，settle 成功时带出去给 connect()
      // 存进 verifiedFingerprints——不然 TOFU 那条路径算出来的值只活在
      // 这个闭包里，握手一结束就没人能再读到它。
      let observedFingerprint: string | undefined

      const settle = (err?: SshError) => {
        if (settled) return
        settled = true
        err ? reject(err) : resolve(observedFingerprint)
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

      // Task 7 复审发现：ssh2 的 Client#connect() 对无法使用的 privateKey 是**同步
      // 抛出**，不会走上面 client.on('error', ...) 那条映射——已经实测验证
      // 过（见本文件对应的单测），且读过 ssh2 1.17.0 的 client.js 源码确认
      // 原因：`parseKey(this.config.privateKey, cfg.passphrase)` 发生在
      // 创建 socket 之前，是纯本地校验，从不触发任何事件。至少两种真实
      // 场景会走到这里，两者是同一个 throw 语句（client.js:261）：
      //   1. 密钥格式不对（贴错成 PuTTY .ppk、复制时截断、整段不是密钥）；
      //   2. 密钥加密了但没给 passphrase，或者 passphrase 给错了——
      //      parseKey() 内部解密失败时返回一个 Error，这里的代码原样
      //      `throw new Error('Cannot parse privateKey: ' + ...)`，跟纯格式
      //      错误共用同一个错误文案前缀，这里没法（也不需要）进一步区分。
      // 紧接着还有一个独立的同步 throw（client.js:267）：密钥解析成功、但
      // 只含公钥部分（`getPrivatePEM() === null`，比如手滑存成了 .pub
      // 文件的内容）。这两个 throw 都发生在 socket 创建之前（client.js:290
      // 才 `this._sock = ...`），所以不需要额外清理任何 socket——这条路径
      // 上确实没有网络层的东西可清。
      //
      // Task 7 二审 I3 修正：**这条"没有网络层东西可清"的结论只对这两个
      // throw 成立**——最初这里把整个 `client.connect({...})` 调用包进
      // try/catch，隐含地假设"这次调用里任何同步抛出都是私钥的问题"，但
      // 这个调用内部在校验完 privateKey 之后还会继续往下走，同步调用
      // `sock.connect(...)`（client.js:1129 一带的 `doConnect()`）——传入
      // 一个非法端口号（比如 0 或负数）时，Node 的 `net.Socket#connect()`
      // 会同步抛出 `ERR_SOCKET_BAD_PORT`，这时 `this._sock` 已经存在，
      // `_readyTimeout` 也已经被 `startTimeout()` 挂上了定时器。原来的
      // catch 分支不分青红皂白地把这类错误也归类成"私钥无法使用"，是一个
      // 主动性的错误诊断——真正的原因是机器记录里的端口不合法，用户会被
      // 指向去检查一把好端端的密钥。
      //
      // 这里改成按错误文案分流：只有真的提到 privateKey 的两种情况才归类
      // 成 SSH_AUTH_FAILED；其余同步抛出（目前已知的例子是 sock.connect()
      // 校验参数）归类成 SSH_UNREACHABLE（可恢复——这一类问题的性质更接近
      // "这次没连上"，跟真正的网络不可达用同一个分类，不单独发明一个新
      // code），原始文本照样带上。至于 `_sock`/`_readyTimeout` 在这条分支
      // 下会不会真的泄漏：不会造成资源泄漏（Node 校验非法端口发生在真正
      // 创建底层 fd 之前），但那个 15 秒的 `_readyTimeout` 定时器确实会在
      // 未来某一刻触发、往这个已经被放弃的 `client` 上发一次迟到的
      // 'error'——这正是 handshake() 里"settle 之后监听器仍然留着"这个
      // 设计本来就要吞掉的那类噪声（见 handshake() 顶部注释），`settled`
      // 挡住重复处理，不需要额外处理。
      //
      // 不接住私钥这两种抛出的话，裸 Error 会直接从 handshake() 冒泡出去，
      // 绕过 Tasks 6/7 靠 isSshError 做的错误路由，把"用户存的密钥有
      // 问题"——这整条链路里用户最可能犯的错——归到"未分类错误"分支，恰恰
      // 是提示最没用的那一种。分类成 SSH_AUTH_FAILED 而不是
      // SSH_NO_CREDENTIAL：后者是"压根没配密钥"，这里是"配了，但用不了"，
      // 两者要求用户做完全不同的事（去配一把 vs 去修这一把），必须保持
      // 可区分——这正是 Task 6 花一整轮才分清楚的两个 code，这里不能又
      // 混到一起。`recoverable: false`：本地重放同一把解析不出来的 key
      // 不会有不同结果，值得重试的是"换一把 key"，不是"再试一次"。
      try {
        client.connect({
          host: machine.host,
          port: machine.port,
          username: machine.user,
          privateKey: creds.privateKey,
          passphrase: creds.passphrase,
          password: creds.password,
          readyTimeout: this.options.connectTimeoutMs ?? 15_000,
          keepaliveInterval: this.options.keepaliveInterval,
          keepaliveCountMax: this.options.keepaliveCountMax,
          hostVerifier: (hostKeyBlob: Buffer): boolean => {
            observedFingerprint = fingerprintOfHostKey(hostKeyBlob)
            // 没有固定指纹：本次是可信首连（TOFU）。固定 UI 是 Task 9 的事，
            // 这里只负责"固定了就必须匹配"这一半。
            if (!pinnedFingerprint) return true
            if (observedFingerprint === pinnedFingerprint) return true
            fingerprintMismatch = true
            return false
          },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (PRIVATE_KEY_ERROR_RE.test(message)) {
          settle(
            new SshError(
              `机器 '${machine.name}' 配置的私钥无法使用（本地解析失败，还没有连上服务器）：${message}`,
              'SSH_AUTH_FAILED',
              false,
            ),
          )
          return
        }
        settle(
          new SshError(
            `连不上 ${machine.name} (${machine.host}:${machine.port})：${message}`,
            'SSH_UNREACHABLE',
            true,
          ),
        )
      }
    })
  }

  /**
   * 连接 ready 之后才挂上的监听器，管的是"这条已经建立好的连接后来怎么
   * 样了"，跟 handshake() 的监听器完全独立（互不残留）。
   */
  private watchForDisconnect(client: Client, machine: RemoteMachine, key: string): void {
    client.on('error', (err: Error) => {
      // I8 修复：不在这里直接调用 onDisconnect。实测对 ready 之后的一次
      // 真实故障（比如底层 socket 被摧毁），ssh2 总是先 'error' 后紧跟
      // 'close'——如果两个事件各自调用一次 onDisconnect，调用方会收到
      // 两次通知：一次带错误、一次不带，代表同一次故障。这里只记下错误，
      // 真正的通知留给 'close' 去发，两个事件合并成一次调用。
      this.pendingDisconnectError.set(client, err)
    })
    client.on('close', () => {
      // I2 修复：只在这个 key 此刻仍然指向这个 client 时才摘除——见 evict()
      // 里同样的身份检查，这里是它的另一处必要场景：一条已经被 acquire()
      // 的指纹不匹配分支摘除、随后 end() 掉的旧连接，它的 'close' 是异步
      // 到达的，到达时 key 可能早就指向了新连接。
      if (this.clients.get(key) === client) {
        this.clients.delete(key)
        this.verifiedFingerprints.delete(key)
        this.observedFingerprints.delete(key)
      }

      const error = this.pendingDisconnectError.get(client)
      this.pendingDisconnectError.delete(client)

      // I8 修复：`intentionallyClosed` 里有记录，说明这次关闭是池自己
      // 干的（指纹校验摘除、赢家通吃顶替、或者 disposeAll），不是一次
      // 意外断线——evict() 摘除、随后重新拿到一条健康连接的那次 acquire()
      // 不该因此收到一次"断线"通知，调用方看到的应该是"这台机器好好的"。
      // `WeakSet.delete` 顺手把记录清掉，返回值就是"删之前在不在"。
      if (this.intentionallyClosed.delete(client)) return

      this.options.onDisconnect?.(machine, error)
    })
  }

  async disposeAll(): Promise<void> {
    // C1 修复：先递增世代号，这样任何仍在握手中的 connect() 在稍后完成时
    // 都能发现自己"跟不上趟了"，自己关掉、不进入下面清空之后的池。
    this.generation++

    const clients = [...this.clients.values()]
    // I8 修复：这一批连接是被 disposeAll() 主动关闭的，不是意外断线——
    // 标记一下，watchForDisconnect 的 'close' 处理器会跳过 onDisconnect
    // 通知（调用方没必要在"我自己主动释放了整个池"这件事上再被通知一次
    // "断线"）。
    for (const client of clients) this.intentionallyClosed.add(client)
    this.clients.clear()
    this.verifiedFingerprints.clear()
    this.observedFingerprints.clear()
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
      // I10 修复：这个兜底定时器如果不清理，会在"'close' 先于超时触发"的
      // 正常路径里继续挂在事件循环上直到 2 秒真的过去——实测 disposeAll()
      // 的 Promise 已经 resolve 了，进程却因为这个定时器还多等了整整
      // 2002ms 才能退出，对一个 CLI 来说是肉眼可见的退出卡顿。finish()
      // 里 clearTimeout 是主路径的修复；unref() 是双保险，就算某处疏漏
      // 没走到 clearTimeout，这个定时器本身也不会拦着进程退出。
      const timer = setTimeout(finish, 2_000)
      timer.unref()

      function finish(): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }

      client.once('close', finish)
      client.end()
    })
  }
}
