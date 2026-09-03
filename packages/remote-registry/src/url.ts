/**
 * `dsh-remote://` URL 的解析与生成。
 *
 * 语法：dsh-remote://user@host[:port]/?name=&tags=&fp=&workdir=
 *
 * - `user`（userinfo）与 `name` 参数为必填，其余全部可选。
 * - `port` 省略时默认为 22。
 * - `tags` 为逗号分隔列表，省略时视为空数组；单个 tag 会被 trim，
 *   且不允许包含逗号（否则往返序列化时会被错误地拆成两个 tag）。
 * - `fp` 为服务器主机公钥指纹，格式固定为 `sha256:<base64>`；前缀
 *   大小写不敏感（`ssh-keygen -lf` 打印的就是大写的 `SHA256:`），
 *   parseRemoteUrl 会把前缀归一化成小写，避免 `SHA256:` 与
 *   `sha256:` 在下游（Task 9 的主机指纹校验）被当成两个不同的指纹。
 * - `workdir` 为远程默认工作目录，不做进一步校验。
 * - **未识别的参数会被忽略**——这是有意为之，用来给协议留出向前兼容的
 *   空间：新版本的生成端可以携带旧版本解析端不认识的参数，旧解析端
 *   应当照常工作而不是报错。
 * - `host` 在 parse 和 format 两个方向都会被归一化成小写——`dsh-remote:`
 *   是非特殊 scheme，WHATWG URL 不会替我们做大小写归一化，用户在表单
 *   里敲 `Example.COM` 不应当报错，但序列化结果和内部存储都统一用
 *   小写，避免同一台机器因为大小写不同被当成两条记录。
 *
 * 这份文件是 Mac 端生成器与手机端解析器之间的契约，应当能脱离上下文
 * 单独读懂。
 */
import type { RemoteMachine } from './types.ts'

export type RemoteUrlErrorCode =
  | 'BAD_URL' | 'BAD_SCHEME' | 'MISSING_USER' | 'MISSING_NAME'
  | 'BAD_NAME' | 'BAD_PORT' | 'BAD_TAG' | 'BAD_FINGERPRINT'

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

/**
 * 主机公钥指纹：`sha256:<base64>` 形式；前缀大小写不敏感——
 * `ssh-keygen -lf` 打印的就是大写的 `SHA256:`。base64 载荷部分本身
 * 是大小写敏感的，不能一起转小写，所以这里只对前缀做 `/i`，具体的
 * 归一化在 normalizeFingerprint 里只处理前缀。
 */
const FINGERPRINT_RE = /^sha256:[A-Za-z0-9+/]+=*$/i

/** 把指纹的前缀大小写归一化成小写，payload 部分原样保留。 */
function normalizeFingerprint(fp: string): string {
  return fp.replace(/^sha256:/i, 'sha256:')
}

/**
 * 由机器名推导凭据引用名，保证是合法的环境变量名。
 *
 * 注意：这个映射不是单射——例如 'my-box' 与 'my_box' 都会映射到
 * 'REMOTE_KEY_MY_BOX'。这是已知且接受的行为：keyRef 的唯一性由
 * registry（Task 8）在 add() 时校验并拒绝冲突，不在这里处理。
 */
export function keyRefForName(name: string): string {
  return `REMOTE_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * 校验一台机器描述是否满足 URL 语法能表达的约束。parseRemoteUrl 与
 * formatRemoteUrl 共用这一套规则，保证两者互为逆运算——但要注意：
 * formatRemoteUrl 会先把 host 归一化成小写再校验、再序列化，所以严格
 * 来说 `parseRemoteUrl(formatRemoteUrl(m))` 对比的是「host 已小写化
 * 的 m」，而不是任意大小写的原始 m（用户在表单里敲 `Example.COM`
 * 不该报错，只是序列化结果会是小写）。
 *
 * BAD_TAG 只可能从 format 方向抛出：parse 是把整个 tags 参数按逗号
 * 切开来产生数组的，切出来的每一项天然不可能再包含逗号。
 */
function assertValidMachine(machine: RemoteMachine): void {
  if (!machine.user) throw new RemoteUrlError('user 不能为空', 'MISSING_USER')

  if (!NAME_RE.test(machine.name)) {
    throw new RemoteUrlError(
      `机器名不合法: ${machine.name}（只允许字母数字与 . _ -，且须字母数字开头）`,
      'BAD_NAME',
    )
  }

  if (!Number.isInteger(machine.port) || machine.port < 1 || machine.port > MAX_PORT) {
    throw new RemoteUrlError(`端口越界: ${machine.port}`, 'BAD_PORT')
  }

  // 不能默认调用方真的传了个数组——tags 是这个校验函数里唯一一个不做
  // 类型防御就直接 for...of 的字段，会在拿到 `undefined` 时抛出裸的
  // TypeError，重蹈 decodeURIComponent 那次同样的“信任自己的类型标注
  // 超过信任运行时输入”的错。
  if (!Array.isArray(machine.tags)) {
    throw new RemoteUrlError('tags 必须是字符串数组', 'BAD_TAG')
  }
  for (const tag of machine.tags) {
    if (tag.includes(',')) {
      throw new RemoteUrlError(`标签不能包含逗号: ${tag}`, 'BAD_TAG')
    }
  }

  if (machine.hostFingerprint && !FINGERPRINT_RE.test(machine.hostFingerprint)) {
    throw new RemoteUrlError(`host 指纹格式不合法: ${machine.hostFingerprint}`, 'BAD_FINGERPRINT')
  }

  if (!machine.host) throw new RemoteUrlError('host 不能为空', 'BAD_URL')
  // 只看 new URL() 会不会抛，不足以验证 host：WHATWG 对 host 位置里的
  // '/', '?', '#', '@', ':' 并不会抛错，而是悄悄把整个字符串重新
  // 切分成别的部分（host、port、userinfo、path 混在了一起）。这正是
  // 当初 formatRemoteUrl 端口越界被静默丢弃那个 bug 的同一种失效
  // 模式——一个“没抛错”的校验其实什么都没挡住，反而会把
  // `host: 'h.test:2222'`（端口写错地方了）序列化成一个端口真的是
  // 2222 的 URL。所以这里改成正向断言：把 host 单独塞进一个探测用的
  // URL 之后，解析出来的 hostname/username/port/path/query/hash 必须
  // 恰好对应“只有一个 host，别的什么都没有”；任何一项走样，都说明
  // host 字符串里混进了不该出现在这个位置的分隔符。
  let probe: URL
  try {
    probe = new URL(`${REMOTE_URL_SCHEME}//${machine.host}/`)
  } catch {
    throw new RemoteUrlError(`host 不合法: ${machine.host}`, 'BAD_URL')
  }
  if (
    probe.hostname !== machine.host.toLowerCase()
    || probe.username
    || probe.port
    || probe.pathname !== '/'
    || probe.search
    || probe.hash
  ) {
    throw new RemoteUrlError(`host 不合法: ${machine.host}`, 'BAD_URL')
  }
}

export function parseRemoteUrl(input: string): RemoteMachine {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    // WHATWG 的 URL 构造函数在端口超出 0..65535 范围时会直接整体抛错，
    // 我们根本来不及走到自己的范围检查——这里单独识别“协议+host+越界
    // 端口”这个形状，让它报出语义明确的 BAD_PORT，而不是笼统的
    // BAD_URL。要求端口后面紧跟路径/查询/片段分隔符或字符串结尾，
    // 是为了避免把 `:99999abc` 这类根本不是端口的畸形串也误判成
    // “端口越界”。
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

  const name = url.searchParams.get('name')
  if (!name) throw new RemoteUrlError('URL 缺少 name 参数', 'MISSING_NAME')

  const port = url.port ? Number(url.port) : DEFAULT_SSH_PORT

  const tagsRaw = url.searchParams.get('tags')
  const machine: RemoteMachine = {
    name,
    // dsh-remote: 是非特殊 scheme，host 是“不透明主机”，WHATWG URL 不会
    // 帮我们做大小写归一化——自己转小写，避免 'Example.com' 和
    // 'example.com' 在 registry 里被当成两台不同的机器。
    host: url.hostname.toLowerCase(),
    port,
    user,
    keyRef: keyRefForName(name),
    tags: tagsRaw ? tagsRaw.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
  }
  const fp = url.searchParams.get('fp')
  if (fp) machine.hostFingerprint = normalizeFingerprint(fp)
  const workdir = url.searchParams.get('workdir')
  if (workdir) machine.defaultWorkdir = workdir

  // 复用与 formatRemoteUrl 相同的校验，统一给出 BAD_NAME / BAD_PORT /
  // BAD_FINGERPRINT 等错误码（未识别的 `fp` 值到这里才会被拒绝）。
  assertValidMachine(machine)
  return machine
}

export function formatRemoteUrl(machine: RemoteMachine): string {
  // host 归一化成小写再校验、再序列化：parse 方向已经这么做了，这里
  // 保持一致，让往返结果幂等——用户在表单里敲 'Example.COM' 不该
  // 报错，只是序列化出来的 URL 和存回去的记录都会是小写。
  const normalized: RemoteMachine = { ...machine, host: machine.host.toLowerCase() }

  // 先校验再序列化：WHATWG 的 `port` setter 对非法端口是静默 no-op
  // （不会抛错，也不会报错，只是什么都不做），如果不预先校验，
  // 一个越界端口的 RemoteMachine 会被悄悄序列化成一个端口是 22 的
  // URL——这是数据静默丢失，比抛错更危险。
  assertValidMachine(normalized)

  const url = new URL(`${REMOTE_URL_SCHEME}//${normalized.host}/`)
  url.username = encodeURIComponent(normalized.user)
  if (normalized.port !== DEFAULT_SSH_PORT) url.port = String(normalized.port)
  url.searchParams.set('name', normalized.name)
  if (normalized.tags.length) url.searchParams.set('tags', normalized.tags.join(','))
  if (normalized.hostFingerprint) url.searchParams.set('fp', normalized.hostFingerprint)
  if (normalized.defaultWorkdir) url.searchParams.set('workdir', normalized.defaultWorkdir)
  return url.toString()
}
