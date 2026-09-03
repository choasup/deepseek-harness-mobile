/**
 * `dsh-remote://` URL 的解析与生成——Mac 端生成器与手机端解析器之间的契约。
 *
 * 语法：dsh-remote://user@host[:port]/?name=&tags=&fp=&workdir=
 *
 * - `user`、`name` 必填，其余可选；`port` 省略时默认为 22。
 * - `tags` 逗号分隔，省略视为空数组；每项会被 trim，且不允许包含逗号。
 * - `fp` 为 `sha256:<base64>`；前缀大小写不敏感（`ssh-keygen -lf` 打印
 *   的是大写 `SHA256:`），会被归一化成小写前缀，payload 原样保留。
 * - `host` 会被归一化成 WHATWG 的规范形式：小写、IPv6 压缩、去掉写法
 *   差异。非 ASCII host 会被拒绝——请提供 punycode（如 `xn--...`），
 *   这个包不做 Unicode→punycode 转换。带 zone id 的链路本地地址（如
 *   `[fe80::1%eth0]`）不支持：WHATWG 的 IPv6 解析器本身就拒绝 `%`。
 * - `keyRef` 永远由 `name` 派生（见 keyRefForName），不能单独指定；
 *   与派生值不一致会被拒绝。
 * - `workdir` 不做校验。
 * - **未识别的参数会被忽略**——为协议向前兼容留出空间。
 */
import type { RemoteMachine } from './types.ts'

export type RemoteUrlErrorCode =
  | 'BAD_URL' | 'BAD_SCHEME' | 'MISSING_USER' | 'MISSING_NAME'
  | 'BAD_NAME' | 'BAD_PORT' | 'BAD_TAG' | 'BAD_FINGERPRINT' | 'BAD_KEY_REF'

export class RemoteUrlError extends Error {
  readonly code: RemoteUrlErrorCode

  constructor(message: string, code: RemoteUrlErrorCode) {
    super(message)
    this.name = 'RemoteUrlError'
    this.code = code
  }
}

export const REMOTE_URL_SCHEME = 'dsh-remote:'

const DEFAULT_SSH_PORT = 22
const MAX_PORT = 65535

/** 机器名：字母数字起头，其后允许字母数字、连字符、点、下划线。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 主机公钥指纹：`sha256:<base64>`，前缀大小写不敏感。 */
const FINGERPRINT_RE = /^sha256:[A-Za-z0-9+/]+=*$/i

const ASCII_RE = /^[\x00-\x7F]*$/

/**
 * host 是否全 ASCII——同时防住两种来路：format 方向的原始 Unicode
 * （如 '例え.jp'），以及 parse 方向的 host（此时 new URL() 已经把
 * Unicode percent-encode 成一串 ASCII 乱码，`%E4%BE%8B...`，本身
 * 通过朴素的 ASCII 检查，必须 decode 回来再判一次）。
 */
function isAsciiHost(host: string): boolean {
  if (!ASCII_RE.test(host)) return false
  try {
    return ASCII_RE.test(decodeURIComponent(host))
  } catch {
    return true
  }
}

/**
 * 把指纹归一化成 ssh-keygen -lf 会打印的规范形式：前缀小写、去掉
 * base64 的尾部 padding（`=`）。接受时宽松（padding 可有可无），
 * 存储时严格（统一成不带 padding 的形式），否则一个存了带 padding
 * 指纹的机器会在 Task 9 的握手比对里永远匹配不上。
 */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/^sha256:/i, 'sha256:').replace(/=+$/, '')
}

/**
 * 由机器名推导凭据引用名，保证是合法的环境变量名。
 *
 * 注意：这个映射不是单射——'my-box' 与 'my_box' 都会映射到
 * 'REMOTE_KEY_MY_BOX'。已知且接受：keyRef 的跨机器唯一性由
 * registry（Task 8）在 add() 时校验，不在这里处理。
 */
export function keyRefForName(name: string): string {
  return `REMOTE_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * 校验一台机器描述并返回规范化后的副本（host 大小写/IPv6 形式、fp
 * 前缀与 padding 等都已归一化）。parseRemoteUrl 与 formatRemoteUrl
 * 都通过它，两者互为逆运算；也是唯一的规范化入口——外部调用方
 * （例如 Task 8 手动录入表单的 add()）应该用这个函数的返回值去存储，
 * 而不是调用方自己传进来的原始对象，否则 formatRemoteUrl 序列化出的
 * 是规范形式，但存进 registry 的还是 'H.Test' 这种未归一化的写法。
 */
export function normalizeMachine(machine: RemoteMachine): RemoteMachine {
  if (typeof machine.user !== 'string' || !machine.user) {
    throw new RemoteUrlError('user 不能为空', 'MISSING_USER')
  }

  if (typeof machine.name !== 'string' || !NAME_RE.test(machine.name)) {
    throw new RemoteUrlError(
      `机器名不合法: ${machine.name}（只允许字母数字与 . _ -，且须字母数字开头）`,
      'BAD_NAME',
    )
  }

  // keyRef 只能是 name 的派生值，不能被指向别的凭据条目再靠 URL 带走。
  const expectedKeyRef = keyRefForName(machine.name)
  if (machine.keyRef !== expectedKeyRef) {
    throw new RemoteUrlError(
      `keyRef 必须由 name 派生: 期望 ${expectedKeyRef}，实际 ${machine.keyRef}`,
      'BAD_KEY_REF',
    )
  }

  // 类型和范围分开报——`port: '22'`（字符串）是类型错，不是"越界"。
  if (typeof machine.port !== 'number' || !Number.isInteger(machine.port)) {
    throw new RemoteUrlError(`端口必须是整数: ${machine.port}`, 'BAD_PORT')
  }
  if (machine.port < 1 || machine.port > MAX_PORT) {
    throw new RemoteUrlError(`端口越界: ${machine.port}`, 'BAD_PORT')
  }

  if (!Array.isArray(machine.tags)) {
    throw new RemoteUrlError('tags 必须是字符串数组', 'BAD_TAG')
  }
  // BAD_TAG 只可能从 format 方向抛出：parse 是把 tags 参数按逗号切开
  // 来产生数组的，切出来的每一项天然不可能再包含逗号。
  for (const tag of machine.tags) {
    // 逗号是 tags 的分隔符，含逗号的 tag 在往返序列化时会被拆成两个。
    if (typeof tag !== 'string' || tag.includes(',')) {
      throw new RemoteUrlError(`标签不合法: ${tag}`, 'BAD_TAG')
    }
  }

  let hostFingerprint = machine.hostFingerprint
  if (hostFingerprint) {
    if (!FINGERPRINT_RE.test(hostFingerprint)) {
      throw new RemoteUrlError(`host 指纹格式不合法: ${hostFingerprint}`, 'BAD_FINGERPRINT')
    }
    hostFingerprint = normalizeFingerprint(hostFingerprint)
  }

  if (typeof machine.host !== 'string' || !machine.host) {
    throw new RemoteUrlError('host 不能为空', 'BAD_URL')
  }
  if (!isAsciiHost(machine.host)) {
    // 非 ASCII host 会被 WHATWG percent-encode 成一串谁也连不上的乱码
    // （不是 punycode），而且悄悄"成功"——必须在这里挡住。
    throw new RemoteUrlError(`host 含非 ASCII 字符: ${machine.host}（请提供 punycode 形式，如 xn--...）`, 'BAD_URL')
  }
  // 一个裸 '@'（空 username、空 password，如 '@evil.test'）解析后
  // probe.username 和 probe.password 都是空串，探测结果查不出任何
  // 异常——WHATWG 把这个空 userinfo 分隔符原样丢弃，不留痕迹。host
  // 语法本身不允许 '@'，在探测之前就直接拒绝。
  if (machine.host.includes('@')) {
    throw new RemoteUrlError(`host 不合法: ${machine.host}`, 'BAD_URL')
  }
  // 先转小写再探测：普通域名的大小写折叠靠我们自己做（WHATWG 对
  // 非特殊 scheme 的 host 不会折叠大小写），IPv6 压缩等则靠探测结果。
  let probe: URL
  try {
    probe = new URL(`${REMOTE_URL_SCHEME}//${machine.host.toLowerCase()}/`)
  } catch {
    throw new RemoteUrlError(`host 不合法: ${machine.host}`, 'BAD_URL')
  }
  // 只看"抛没抛错"不够：WHATWG 对 host 位置里的 '/','?','#',':' 不
  // 抛错，而是把字符串悄悄重新切分成别的部分。这里正向断言探测结果
  // 里除了 host 什么都没有，把混入的额外分隔符挡住（password 也要
  // 查——非空 password、空 username 的 userinfo，如 ':pw@evil.test'，
  // 只看 username 会漏过去；'@' 本身已经在上面单独挡掉了）。
  if (
    probe.username || probe.password || probe.port
    || probe.pathname !== '/' || probe.search || probe.hash
  ) {
    throw new RemoteUrlError(`host 不合法: ${machine.host}`, 'BAD_URL')
  }

  const result: RemoteMachine = {
    name: machine.name,
    host: probe.hostname,
    port: machine.port,
    user: machine.user,
    keyRef: machine.keyRef,
    tags: machine.tags,
  }
  if (hostFingerprint) result.hostFingerprint = hostFingerprint
  if (machine.defaultWorkdir) result.defaultWorkdir = machine.defaultWorkdir
  return result
}

export function parseRemoteUrl(input: string): RemoteMachine {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    // WHATWG 在端口超出 0..65535 时于 new URL() 阶段直接整体抛错，
    // 这里从原始字符串里把这一种情况单独挑出来报成 BAD_PORT；
    // 要求端口后紧跟分隔符或结尾，避免把 `:99999abc` 这类畸形串
    // 误判成"越界"。
    const portMatch = input.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?[^/:?#]+:(\d+)(?:[/?#]|$)/)
    if (portMatch && Number(portMatch[1]) > MAX_PORT) {
      throw new RemoteUrlError(`端口越界: ${portMatch[1]}`, 'BAD_PORT')
    }
    throw new RemoteUrlError(`不是合法的 URL: ${input}`, 'BAD_URL')
  }
  if (url.protocol !== REMOTE_URL_SCHEME) {
    throw new RemoteUrlError(`协议必须是 ${REMOTE_URL_SCHEME}//，收到 ${url.protocol}//`, 'BAD_SCHEME')
  }

  let user: string
  try {
    user = decodeURIComponent(url.username)
  } catch {
    throw new RemoteUrlError(`用户名编码不合法: ${url.username}`, 'BAD_URL')
  }
  if (!user) throw new RemoteUrlError('URL 缺少用户名（应为 user@host）', 'MISSING_USER')

  // 参数缺失（MISSING_NAME）与参数存在但不合法（BAD_NAME）是两种
  // 不同的错误码，必须在调用共享校验之前分开判断。
  const name = url.searchParams.get('name')
  if (!name) throw new RemoteUrlError('URL 缺少 name 参数', 'MISSING_NAME')

  const port = url.port ? Number(url.port) : DEFAULT_SSH_PORT
  const tagsRaw = url.searchParams.get('tags')
  const machine: RemoteMachine = {
    name,
    host: url.hostname,
    port,
    user,
    keyRef: keyRefForName(name),
    tags: tagsRaw ? tagsRaw.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
  }
  const fp = url.searchParams.get('fp')
  if (fp) machine.hostFingerprint = fp
  const workdir = url.searchParams.get('workdir')
  if (workdir) machine.defaultWorkdir = workdir

  return normalizeMachine(machine)
}

export function formatRemoteUrl(machine: RemoteMachine): string {
  const normalized = normalizeMachine(machine)

  const url = new URL(`${REMOTE_URL_SCHEME}//${normalized.host}/`)
  url.username = encodeURIComponent(normalized.user)
  if (normalized.port !== DEFAULT_SSH_PORT) url.port = String(normalized.port)
  url.searchParams.set('name', normalized.name)
  if (normalized.tags.length) url.searchParams.set('tags', normalized.tags.join(','))
  if (normalized.hostFingerprint) url.searchParams.set('fp', normalized.hostFingerprint)
  if (normalized.defaultWorkdir) url.searchParams.set('workdir', normalized.defaultWorkdir)
  return url.toString()
}
