/** 可路由的 SSH 失败分类。recoverable 决定 agent 是否值得重试。 */
export type SshErrorCode =
  | 'SSH_UNREACHABLE'          // TCP 连不上
  | 'SSH_AUTH_FAILED'          // 认证被拒
  | 'SSH_FINGERPRINT_MISMATCH' // 主机指纹与已固定值不符
  | 'SSH_DISCONNECTED'         // 连接中途断开
  | 'SSH_NO_MACHINE'           // 注册表里没有这台机器
  | 'SSH_NO_CREDENTIAL'        // 机器在注册表里，但从没写过密钥（区别于密钥错误的 SSH_AUTH_FAILED）

/** SshError 构造时可选携带的额外上下文，只有部分 code 会用到。 */
export interface SshErrorDetails {
  /**
   * 仅对 execRemote() 抛出的 SSH_DISCONNECTED 有意义：这条命令有没有真的
   * 被送到远端、开始执行过。
   * - `false`：命令从没真正开始执行——要么 exec() 同步/异步报错（连接
   *   早就死了，请求根本没送到服务器），要么 channel-open 请求从头到尾
   *   没得到任何答复。这种情况下重试是安全的。
   * - `true`：命令已经拿到 channel、确实在远端跑起来了，断线发生在执行
   *   期间。一条非幂等命令（`make install`、`rm`、`git push`）可能已经
   *   半途生效——调用方绝不能在这种情况下自动重试。
   * - `undefined`：跟"命令有没有开始执行"这个问题无关的错误（连接池的
   *   握手失败、认证被拒、指纹不匹配等）。
   */
  started?: boolean
  /**
   * 仅在 started 为 true 时可能有值：断线发生前，execRemote() 已经收集到
   * 的部分输出。移动网络断线是常态而不是异常——"构建打印了 200 行然后
   * 链路掉了"——直接丢弃这部分输出是真实的信息损失，所以带上它。
   */
  partialStdout?: string
  partialStderr?: string
}

export class SshError extends Error {
  readonly code: SshErrorCode
  readonly recoverable: boolean
  readonly started?: boolean
  readonly partialStdout?: string
  readonly partialStderr?: string

  constructor(message: string, code: SshErrorCode, recoverable: boolean, details?: SshErrorDetails) {
    super(message)
    this.name = 'SshError'
    this.code = code
    this.recoverable = recoverable
    this.started = details?.started
    this.partialStdout = details?.partialStdout
    this.partialStderr = details?.partialStderr
  }
}

export function isSshError(value: unknown): value is SshError {
  return value instanceof SshError
}
