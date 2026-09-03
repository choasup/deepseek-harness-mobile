// ssh2 只作类型导入；类型导入在编译期被整个擦除，不受"ssh2 是 CommonJS，
// 具名值导入在真实 Node ESM 下会抛 SyntaxError"这条限制（参见 connection.ts
// 顶部注释与 errors.ts 的用法）。
import { StringDecoder } from 'node:string_decoder'
import type { Client, ClientChannel } from 'ssh2'
import { SshError } from './errors.ts'

export interface RemoteExecOptions {
  command: string
  timeoutMs: number
  stdoutMaxBytes: number
  workdir?: string
  env?: Record<string, string>
  stdin?: string
  signal?: AbortSignal
  /** 每收到一段输出就回调，用于 start() 的增量读取。 */
  onData?(chunk: string, stream: 'stdout' | 'stderr'): void
}

export interface RemoteExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  truncated: boolean
}

/** 用单引号包裹并转义，供 POSIX shell 安全解析。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 把 workdir 与 env 折进一条命令——SSH exec 没有独立的 cwd/env 通道。
 *
 * env 的值经 shellQuote 转义后可以放心拼进单引号里；但 **key 是原样拼进
 * `export ${key}=...` 的，不经过任何转义**——一个像 `X; rm -rf /` 这样的
 * key 会变成一条独立命令被执行。这里用白名单正则挡掉，而不是转义 key
 * 本身：环境变量名本来就只应该是字母/数字/下划线，没有任何合法理由需要
 * 转义，出现非法字符直接判定为调用方的错误，快速失败。
 */
export function buildRemoteCommand(options: Pick<RemoteExecOptions, 'command' | 'workdir' | 'env'>): string {
  const parts: string[] = []
  if (options.workdir) parts.push(`cd ${shellQuote(options.workdir)}`)
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`非法的环境变量名 ${JSON.stringify(key)}：只允许字母、数字、下划线，且不能以数字开头`)
    }
    parts.push(`export ${key}=${shellQuote(value)}`)
  }
  if (parts.length === 0) return options.command

  // parts 非空说明命令前面挂了 cd/export，用 ' && ' 链接。如果把 command
  // 原样拼在最后一节，一个内部带换行的多行命令会在换行处跳出这条 && 链——
  // 换行在 POSIX shell 里和 ';' 一样是语句分隔符。用真实 /bin/sh 验证过：
  //   sh -c 'cd /nonexistent && echo A
  //   echo B'
  // "B" 照样打印、退出码还是 0——即使 cd 失败，第二行也不受 && 的短路
  // 保护，是一条独立执行的新语句。用一对圆括号把 command 包成子 shell
  // 分组，`X && ( 多行内容 )` 里括号内的整段作为 && 链的一个原子单元，
  // cd/export 失败时整段都不会执行；子 shell 的退出码等于其中最后一条
  // 命令的退出码，不影响外层 exitCode 语义（同样用真实 shell 验证过）。
  //
  // 开括号和 command 之间、command 和闭括号之间必须换行，不能写成
  // `( command )` 一行：如果 command 末尾带一个 `#` 注释，会把同一行里的
  // 闭括号也一起注释掉，导致 "unexpected end of file"（也是用真实 shell
  // 验证过的，不是猜测）。
  parts.push(`(\n${options.command}\n)`)
  return parts.join(' && ')
}

/**
 * 如果 buf 末尾是一个被截断的多字节 UTF-8 序列（引导字节声明的长度超出了
 * buf 剩下的字节数），把这个不完整字符从末尾去掉再返回；否则原样返回。
 *
 * 只应该在"这段 buffer 确实是按字节数硬截断过"的场景下调用——按字节数截断
 * 完全可能砍在一个多字节字符正中间，直接 decode 会在断点处产生一个
 * U+FFFD 替换字符（乱码），而不是干净地"少一个字符"。
 *
 * 设计选择：宁可丢掉这个不完整的字符，也不把半个字符保留在输出里——半个
 * 字符 decode 出来是替换字符，比"字符串在这里被截短了"更容易被误读成
 * "数据本身损坏了"。
 */
function trimIncompleteUtf8Tail(buf: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
  const len = buf.length
  if (len === 0) return buf
  const maxLead = Math.min(4, len) // UTF-8 最长的合法序列是 4 字节
  for (let back = 1; back <= maxLead; back++) {
    const byte = buf[len - back]!
    if ((byte & 0xc0) === 0x80) continue // 延续字节（10xxxxxx），继续往前找引导字节
    let seqLen: number
    if ((byte & 0x80) === 0x00) seqLen = 1 // 0xxxxxxx：ASCII
    else if ((byte & 0xe0) === 0xc0) seqLen = 2 // 110xxxxx
    else if ((byte & 0xf0) === 0xe0) seqLen = 3 // 1110xxxx
    else if ((byte & 0xf8) === 0xf0) seqLen = 4 // 11110xxx
    else seqLen = 1 // 非法引导字节：当成损坏数据里的独立字节，不额外截断
    // 引导字节声明的序列长度比 buf 里从它开始到末尾剩下的字节数还长——
    // 序列被硬截断了，把它整个丢掉。
    if (seqLen > back) return buf.subarray(0, len - back)
    return buf
  }
  // 连续 4 个字节全是延续字节：不构成合法的 UTF-8 尾部，视为损坏数据，原样返回。
  return buf
}

function toDisconnectedError(err: unknown, context: string): SshError {
  const message = err instanceof Error ? err.message : String(err)
  return new SshError(`${context}：${message}`, 'SSH_DISCONNECTED', true)
}

interface StreamState {
  chunks: Buffer[]
  bytes: number
  truncated: boolean
  decoder: StringDecoder
}

function newStreamState(): StreamState {
  return { chunks: [], bytes: 0, truncated: false, decoder: new StringDecoder('utf8') }
}

/**
 * 边界说明（Task 4 review 定的）：`pool.acquire()` 交出的连接只保证"取用
 * 那一刻是活的"，不保证 exec 这一刻还活着——池不负责 exec 期间的存活
 * 检测。这个函数因此要同时接住两种"连接其实已经死了"的表现形式（都实测
 * 验证过，不是假设）：
 *
 * 1. **拿到手时就已经死了**：对一条已经 `client.end()` 过的连接调用
 *    `exec()`，ssh2 是**同步抛出** `Error('Not connected')`——既不会走进
 *    回调（不管是带 err 还是不带），也不会触发任何事件。如果不包一层
 *    try/catch，这个裸 Error 会直接从 execRemote 的 Promise executor
 *    里抛出去，被 Promise 构造函数当成"executor 同步抛出"自动 reject——
 *    调用方拿到的是一个 `SSH_DISCONNECTED`/`SSH_UNREACHABLE` 之外的、
 *    isSshError() 认不出来的裸错误。这里同时防了两条路：exec() 同步抛出
 *    的分支，以及"以后 ssh2 版本改成走异步回调报错"的分支（`err` 参数）。
 * 2. **执行到一半死了**：连接在命令跑到一半时断线（实测用法：伪造 sshd
 *    的 `disconnectAll()` 挂断所有连接 + 一条 `delayMs` 够长的命令）。
 *    观察到的事件序列是 stream 只收到 'close'，'exit' 永远不会到达——
 *    没有 'error'，没有任何异常，看起来和"命令正常跑完，只是退出码不知道
 *    为什么是 null"一模一样。finish() 里专门判定这种情况，reject 成
 *    SshError 而不是安静地 resolve 一个 exitCode: null 的"正常"结果。
 */
export function execRemote(client: Client, options: RemoteExecOptions): Promise<RemoteExecResult> {
  return new Promise((resolve, reject) => {
    let command: string
    try {
      command = buildRemoteCommand(options)
    } catch (err) {
      reject(err)
      return
    }

    function runExec(stream: ClientChannel): void {
      const streams = { stdout: newStreamState(), stderr: newStreamState() }
      let exitCode: number | null = null
      let signal: NodeJS.Signals | null = null
      let gotExit = false
      let timedOut = false
      let aborted = false
      let settled = false
      let streamError: Error | undefined

      const append = (chunk: Buffer, which: 'stdout' | 'stderr') => {
        const state = streams[which]
        // 实时回调不受 stdoutMaxBytes 限制——它是喂给 start() 用的增量
        // 直播，跟"最终存储截不截断"是两回事。用 StringDecoder 而不是
        // 逐块 chunk.toString('utf8') 是因为一个多字节字符完全可能横跨
        // 两次网络 'data' 事件被拆开；StringDecoder 会把不完整的尾部
        // 字节缓存起来等下一块数据补全，不会在这里的回调里冒出 U+FFFD。
        options.onData?.(state.decoder.write(chunk), which)

        if (state.bytes >= options.stdoutMaxBytes) {
          state.truncated = true
          return
        }
        const room = options.stdoutMaxBytes - state.bytes
        if (chunk.length <= room) {
          state.chunks.push(chunk)
          state.bytes += chunk.length
        } else {
          // 按字节数（Buffer.byteLength 的口径，不是 JS 字符串的 .length，
          // 后者数的是 UTF-16 code unit）截到 room 字节。这一刀完全可能
          // 切在一个多字节字符正中间——先原样存进 chunks，等 finish() 时
          // 对拼接后的整个 buffer 做一次 trimIncompleteUtf8Tail，而不是
          // 在这里就 decode（那样切分点前的字符边界信息已经丢了，没法
          // 干净地退回上一个完整字符）。
          state.chunks.push(chunk.subarray(0, room))
          state.bytes += room
          state.truncated = true
        }
      }

      const timer = setTimeout(() => {
        timedOut = true
        stream.close()
      }, options.timeoutMs)

      const onAbort = () => {
        aborted = true
        stream.close()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)

        // 见函数顶部的边界说明：既不是我们自己因超时/取消而主动 close()
        // 的，也从没收到过 'exit' 事件，'close' 却来了——这是连接中途
        // 断开，不是命令跑完了。
        if (!gotExit && !timedOut && !aborted) {
          const detail = streamError ? `：${streamError.message}` : ''
          reject(new SshError(`执行远程命令时连接断开${detail}`, 'SSH_DISCONNECTED', true))
          return
        }

        let stdoutBuf = Buffer.concat(streams.stdout.chunks)
        let stderrBuf = Buffer.concat(streams.stderr.chunks)
        // 只在真的发生过按字节截断时才去修尾部——命令自己的输出恰好在半个
        // 多字节字符上结束（没截断也没超时），那是远端命令自己的问题，
        // 不该被这里悄悄啃掉一块。
        if (streams.stdout.truncated) stdoutBuf = trimIncompleteUtf8Tail(stdoutBuf)
        if (streams.stderr.truncated) stderrBuf = trimIncompleteUtf8Tail(stderrBuf)

        resolve({
          stdout: stdoutBuf.toString('utf8'),
          stderr: stderrBuf.toString('utf8'),
          exitCode: timedOut || aborted ? null : exitCode,
          signal,
          timedOut,
          aborted,
          truncated: streams.stdout.truncated || streams.stderr.truncated,
        })
      }

      // 必须在拿到 stream 后的这一刻、同一个 tick 里同步挂上 data
      // 监听器：实测 ssh2 的 exec channel 默认是暂停模式，如果不给它挂至少
      // 一个 'data' 监听器让它进入流动模式，'close' 事件永远不会触发——
      // 哪怕命令早就跑完、哪怕后来手动调用了 stream.close()。这不是猜测：
      // 用一个独立探针脚本对比过"挂了 data 监听器"和"完全不挂"两种情况，
      // 后者跑到 3 秒超时也等不到 close。
      stream.on('data', (chunk: Buffer) => append(chunk, 'stdout'))
      stream.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'))

      // 防止一次真实的 channel 级错误在没有监听器的情况下变成 Node 的
      // 未捕获异常——EventEmitter 对没人监听的 'error' 事件默认直接抛出，
      // 会打崩整个进程，而 vitest 只会把它计成"Unhandled Errors"，不会让
      // 相关测试显式失败，等于把 bug 藏起来。这里只记录，真正的判定逻辑
      // 在 finish() 里（结合"有没有收到 exit"一起看）。
      stream.on('error', (err: Error) => { streamError = err })
      stream.stderr.on('error', (err: Error) => { streamError = err })

      // 实测：ssh2 对信号终止的进程会把 code 报成 null、把信号名报成已经
      // 带 "SIG" 前缀的形式（比如伪造 sshd 的 `stream.exit('TERM')`，客户端
      // 收到的却是 "SIGTERM"），且这个事件对普通退出和信号终止是同一个
      // 'exit'，靠有没有第二个参数区分。
      stream.on('exit', (code: number | null, sig?: string) => {
        gotExit = true
        exitCode = code
        if (sig) signal = (sig.startsWith('SIG') ? sig : `SIG${sig}`) as NodeJS.Signals
      })
      stream.on('close', finish)

      if (options.stdin !== undefined) stream.end(options.stdin)
    }

    try {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(toDisconnectedError(err, '执行远程命令失败'))
          return
        }
        runExec(stream)
      })
    } catch (err) {
      reject(toDisconnectedError(err, 'SSH 连接已断开，无法执行命令'))
    }
  })
}
