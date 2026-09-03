/** 一台用户配置的远程执行机器。私钥不存在这里，只存引用名。 */
export interface RemoteMachine {
  /** 用户可见、profile 内唯一的名字，如 'gpu-h20'。 */
  name: string
  host: string
  port: number
  user: string
  /**
   * 指向 .credentials.yaml 里的条目名，如 'REMOTE_KEY_GPU_H20'。
   * 由 `name` 派生（见 url.ts 的 keyRefForName），不能单独设置——
   * url.ts 的 normalizeAndValidate 会拒绝与派生值不一致的 keyRef。
   */
  keyRef: string
  /** 路由用标签，如 ['gpu', 'cuda']。 */
  tags: string[]
  /** 已知的服务器主机公钥指纹（sha256:base64）。缺失表示尚未固定。 */
  hostFingerprint?: string
  /** 远程默认工作目录。 */
  defaultWorkdir?: string
}

/**
 * 连接一台机器所需的认证材料。由 dsh-credentials 解出 keyRef 对应的条目后
 * 产出，只在内存里传递，不落盘、不进这份类型定义之外的任何地方。
 * 三个字段都可选——具体传哪个由凭据条目的类型决定（密码 vs 私钥），
 * ssh2 的 Client#connect 本身也接受两者之一或都不传（走 agent/其他方式）。
 */
export interface SshCredentials {
  password?: string
  privateKey?: string | Buffer
  passphrase?: string
}
