/** 可路由的 SSH 失败分类。recoverable 决定 agent 是否值得重试。 */
export type SshErrorCode =
  | 'SSH_UNREACHABLE'          // TCP 连不上
  | 'SSH_AUTH_FAILED'          // 认证被拒
  | 'SSH_FINGERPRINT_MISMATCH' // 主机指纹与已固定值不符
  | 'SSH_DISCONNECTED'         // 连接中途断开
  | 'SSH_NO_MACHINE'           // 注册表里没有这台机器

export class SshError extends Error {
  readonly code: SshErrorCode
  readonly recoverable: boolean

  constructor(message: string, code: SshErrorCode, recoverable: boolean) {
    super(message)
    this.name = 'SshError'
    this.code = code
    this.recoverable = recoverable
  }
}

export function isSshError(value: unknown): value is SshError {
  return value instanceof SshError
}
