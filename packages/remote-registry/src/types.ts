/** 一台用户配置的远程执行机器。私钥不存在这里，只存引用名。 */
export interface RemoteMachine {
  /** 用户可见、profile 内唯一的名字，如 'gpu-h20'。 */
  name: string
  host: string
  port: number
  user: string
  /** 指向 .credentials.yaml 里的条目名，如 'REMOTE_KEY_GPU_H20'。 */
  keyRef: string
  /** 路由用标签，如 ['gpu', 'cuda']。 */
  tags: string[]
  /** 已知的服务器主机公钥指纹（sha256:base64）。缺失表示尚未固定。 */
  hostFingerprint?: string
  /** 远程默认工作目录。 */
  defaultWorkdir?: string
}
