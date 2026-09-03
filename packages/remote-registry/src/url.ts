import type { RemoteMachine } from './types.ts'

export type RemoteUrlErrorCode =
  | 'BAD_URL' | 'BAD_SCHEME' | 'MISSING_USER' | 'MISSING_NAME'
  | 'BAD_NAME' | 'BAD_PORT'

export class RemoteUrlError extends Error {
  constructor(message: string, readonly code: RemoteUrlErrorCode) {
    super(message)
    this.name = 'RemoteUrlError'
  }
}

export const REMOTE_URL_SCHEME = 'dsh-remote:'

/** 机器名：字母数字起头，其后允许字母数字、连字符、点、下划线。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 由机器名推导凭据引用名，保证是合法的环境变量名。 */
export function keyRefForName(name: string): string {
  return `REMOTE_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

export function parseRemoteUrl(input: string): RemoteMachine {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    // WHATWG URL rejects out-of-range ports by throwing outright, before we
    // get a chance to inspect them ourselves — detect that case specifically
    // so it reports as BAD_PORT rather than a generic BAD_URL.
    const portMatch = input.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?[^/:?#]+:(\d+)/)
    if (portMatch) {
      const rawPort = Number(portMatch[1])
      if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
        throw new RemoteUrlError(`端口越界: ${portMatch[1]}`, 'BAD_PORT')
      }
    }
    throw new RemoteUrlError(`不是合法的 URL: ${input}`, 'BAD_URL')
  }
  if (url.protocol !== REMOTE_URL_SCHEME) {
    throw new RemoteUrlError(`协议必须是 ${REMOTE_URL_SCHEME}//，收到 ${url.protocol}//`, 'BAD_SCHEME')
  }
  const user = decodeURIComponent(url.username)
  if (!user) throw new RemoteUrlError('URL 缺少用户名（应为 user@host）', 'MISSING_USER')

  const name = url.searchParams.get('name')
  if (!name) throw new RemoteUrlError('URL 缺少 name 参数', 'MISSING_NAME')
  if (!NAME_RE.test(name)) {
    throw new RemoteUrlError(`机器名不合法: ${name}（只允许字母数字与 . _ -，且须字母数字开头）`, 'BAD_NAME')
  }

  const port = url.port ? Number(url.port) : 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RemoteUrlError(`端口越界: ${url.port}`, 'BAD_PORT')
  }

  const tagsRaw = url.searchParams.get('tags')
  const machine: RemoteMachine = {
    name,
    host: url.hostname,
    port,
    user,
    keyRef: keyRefForName(name),
    tags: tagsRaw ? tagsRaw.split(',').filter(Boolean) : [],
  }
  const fp = url.searchParams.get('fp')
  if (fp) machine.hostFingerprint = fp
  const workdir = url.searchParams.get('workdir')
  if (workdir) machine.defaultWorkdir = workdir
  return machine
}

export function formatRemoteUrl(machine: RemoteMachine): string {
  const url = new URL(`${REMOTE_URL_SCHEME}//${machine.host}/`)
  url.username = encodeURIComponent(machine.user)
  if (machine.port !== 22) url.port = String(machine.port)
  url.searchParams.set('name', machine.name)
  if (machine.tags.length) url.searchParams.set('tags', machine.tags.join(','))
  if (machine.hostFingerprint) url.searchParams.set('fp', machine.hostFingerprint)
  if (machine.defaultWorkdir) url.searchParams.set('workdir', machine.defaultWorkdir)
  return url.toString()
}
