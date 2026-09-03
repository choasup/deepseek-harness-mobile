// ssh2 只作类型导入；类型导入在编译期被整个擦除，不受"ssh2 是 CommonJS，
// 具名值导入在真实 Node ESM 下会抛 SyntaxError"这条限制（参见 connection.ts
// 顶部注释与 errors.ts 的用法）。
import { StringDecoder } from 'node:string_decoder'
import type { Client, ClientChannel } from 'ssh2'
import { SshError } from './errors.ts'

export interface RemoteExecOptions {
  command: string
  timeoutMs: number
  /**
   * stdout 最多保留多少字节。超出的部分从**头部**丢弃，只保留最新的这么
   * 多字节（"尾部"语义）——跟 dsh 本地执行的 `CollectedOutput` 约定一致
   * （其文档明确写着 "the TAIL of the stream when truncated"）：命令失败
   * 时有价值的通常是最后几行（报错、堆栈），不是开头。保留的是一个随数据
   * 到达不断从前面收缩的滑动窗口，不是"收完全部再截断"，内存占用有界。
   *
   * Task 6 review 修复：曾经这一个字段被同时用作 stdout 和 stderr 两个流
   * 各自的窗口预算，跟 dsh-shell 的 `ShellExecSpec.stdoutMaxBytes` 文档原文
   * 相矛盾——"run() uses it for stdout; background jobs and stderr keep the
   * executor's own output cap"，即调用方为 stdout 传入的覆盖值绝不该顺带
   * 影响 stderr 的留存预算（例如一个把 stdoutMaxBytes 调小到 100 字节去
   * 精确解析一小段 stdout 的调用方，会在没有请求的情况下把自己需要读的
   * 报错信息也截没了）。见下面的 `stderrMaxBytes`。
   */
  stdoutMaxBytes: number
  /**
   * stderr 独立于 stdoutMaxBytes 的留存预算，语义与截断算法跟 stdout 完全
   * 一致（头部丢弃、尾部滑动窗口）。**未提供时退化为 stdoutMaxBytes**——
   * 这只是为了不破坏这个字段引入之前就存在的调用方（这个包自己的
   * `run()`/`start()` 现在总是显式传两个值，不依赖这条退化路径）；新增
   * 调用方不应该依赖它，应该总是显式传两者。
   */
  stderrMaxBytes?: number
  workdir?: string
  env?: Record<string, string>
  stdin?: string
  signal?: AbortSignal
  /**
   * 每收到一段输出就回调，用于 start() 的增量读取。不受 stdoutMaxBytes
   * 限制——它是旁路的实时直播，跟"最终存储保留多少"是两回事。抛出的异常
   * 会被吞掉（见 execRemote 内部 append() 的注释），不会影响命令本身的
   * 收集与结算。
   */
  onData?(chunk: string, stream: 'stdout' | 'stderr'): void
}

export interface RemoteExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  /** stdout 是否被 stdoutMaxBytes 截断过（丢弃了更早的字节）。 */
  stdoutTruncated: boolean
  stderrTruncated: boolean
  /** stdout 总共收到的字节数，即使超过 stdoutMaxBytes 被丢弃也计入——用来算丢了多少。 */
  stdoutBytesSeen: number
  stderrBytesSeen: number
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
 * 本身：环境变量名本来就只应该是字母、数字、下划线，没有任何合法理由需要
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
  // parts 为空说明命令前面没有挂 cd/export，直接原样发送、不做任何包裹。
  // 这不只是为了不破坏伪造 sshd 按精确字符串匹配命令的测试夹具——它是有
  // 实际价值的行为：sshd.received[0]、以及 Task 7 要做的执行前审批 UI，
  // 看到的会是用户输入的命令原文，一字不差，而不是包了一层看不出内容的
  // 子 shell。只有真的存在 workdir/env 前缀、需要用 && 链接时，才有下面
  // 这个"跳出 && 链"的风险要防，此时才值得为了正确性牺牲这份"所见即所得"。
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
  // 命令的退出码，不影响外层 exitCode 语义（同样用真实 shell 验证过，见
  // tests/unit/exec.test.ts 里那组直接跑 /bin/sh 的语义测试，带反面对照）。
  //
  // 开括号和 command 之间、command 和闭括号之间必须换行，不能写成
  // `( command )` 一行：如果 command 末尾带一个 `#` 注释，会把同一行里的
  // 闭括号也一起注释掉，导致 "unexpected end of file"（也是用真实 shell
  // 验证过的，不是猜测）。
  //
  // command 整段是空白（trim 后为空字符串）时，`(\n\n)` 是一个没有任何
  // 命令的空分组，POSIX shell 视为语法错误（"unexpected token `)'"）——
  // 哪怕在没有 workdir/env 前缀时同一个空命令完全无害。这里退化成一个
  // 明确的 no-op（`:`），保持"空命令等于什么都不做"这条语义在两种路径下
  // 一致。
  const body = options.command.trim() === '' ? ':' : options.command
  parts.push(`(\n${body}\n)`)
  return parts.join(' && ')
}

/**
 * 如果 buf 头部是被截断的多字节 UTF-8 序列的残余延续字节，把它们从开头
 * 去掉再返回；否则原样返回。
 *
 * 只应该在"这段 buffer 是尾部截断（只保留了最新 N 字节）"的场景下调用：
 * 按字节数保留尾部窗口，完全可能砍在一个多字节字符正中间——被砍掉的是
 * 这个字符的引导字节，留在窗口最前面的只是它的延续字节（10xxxxxx），
 * 这些延续字节脱离了自己的引导字节，decode 时会在这里产生 U+FFFD 替换
 * 字符（乱码）。
 *
 * 判定很简单，不需要像"从尾部截断"那样计算序列长度：出现在 buffer
 * **最开头**的任何延续字节，其引导字节必然在窗口之外（已经被丢弃），
 * 一定是孤儿，直接连续剥掉即可——不像尾部截断需要先找到引导字节、算出
 * 它声明的序列长度、再判断是否够长，头部截断的方向天然更简单。
 *
 * 设计选择（跟 tail 版本一致）：宁可丢掉这些孤儿字节，也不把半个字符
 * 保留在输出里——那样 decode 出来是替换字符，比"字符串从这里开始"更容易
 * 被误读成"数据本身损坏了"。
 */
function trimIncompleteUtf8Head(buf: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
  let start = 0
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++
  return start === 0 ? buf : buf.subarray(start)
}

function toDisconnectedError(err: unknown, context: string, details: { started: boolean }): SshError {
  const message = err instanceof Error ? err.message : String(err)
  return new SshError(`${context}：${message}`, 'SSH_DISCONNECTED', true, details)
}

interface StreamState {
  /** 当前保留的尾部滑动窗口，按到达顺序排列，窗口内字节数之和 <= stdoutMaxBytes。 */
  chunks: Buffer[]
  /** chunks 里的字节数之和。 */
  windowBytes: number
  /** 这个流总共收到的字节数，包含被窗口丢弃的部分——用来告诉调用方到底丢了多少。 */
  bytesSeen: number
  truncated: boolean
  decoder: StringDecoder
}

function newStreamState(): StreamState {
  return { chunks: [], windowBytes: 0, bytesSeen: 0, truncated: false, decoder: new StringDecoder('utf8') }
}

/** 断线之后，"stream.close() 发出去却永远等不到 close 事件回音"这条兜底路径的宽限期。 */
const DISCONNECT_GRACE_MS = 3000

/**
 * 边界说明（Task 4 review 定的）：`pool.acquire()` 交出的连接只保证"取用
 * 那一刻是活的"，不保证 exec 这一刻还活着——池不负责 exec 期间的存活
 * 检测。这个函数因此要同时接住这些"连接其实已经死了/正在死"的表现形式
 * （都实测验证过，不是假设）：
 *
 * 1. **拿到手时就已经死了**：对一条已经 `client.end()` 过的连接调用
 *    `exec()`，ssh2 是**同步抛出** `Error('Not connected')`——既不会走进
 *    回调，也不会触发任何事件。同时兜底"以后 ssh2 版本改成走异步回调
 *    报错"的分支（`err` 参数）。这两条路都映射成 `started: false`——
 *    请求demonstrably 没有送到服务器，重试是安全的。
 * 2. **channel-open 请求被对端黑洞**：TCP 连接表面上还在，但对端（或
 *    中间的网络设备——手机从 Wi-Fi 切到蜂窝网络是这个项目要处理的真实
 *    场景，不是假设）不再响应任何东西，`client.exec()` 的回调永远不会
 *    触发。不专门处理的话 `timeoutMs` 在这个阶段完全不生效，
 *    execRemote() 会永远 pending——见下面在调用 `client.exec()` 之前就
 *    起好的 `deadlineTimer`。
 * 3. **执行到一半死了**：连接在命令跑到一半时断线（实测用法：伪造 sshd
 *    的 `disconnectAll()` 挂断所有连接 + 一条 `delayMs` 够长的命令）。
 *    观察到的事件序列是 stream 只收到 'close'，'exit' 永远不会到达——
 *    没有 'error'，没有任何异常，看起来和"命令正常跑完，只是退出码不知道
 *    为什么是 null"一模一样。这种情况映射成 `started: true`（命令已经
 *    在远端跑起来过，一条非幂等命令可能已经半途生效，调用方不能自动
 *    重试），并且把断线前已经收集到的部分输出带在错误上——移动网络断线
 *    是常态，"构建打印了 200 行然后掉线"不该被直接丢弃。
 * 4. **`close()` 发出去之后同样被黑洞**：超时或取消都会调用 `stream.close()`
 *    然后等一个 'close' 事件才能结算——但对端黑洞的连接一样收不到这个
 *    回音（ssh2 1.17.0 源码：`onCHANNEL_CLOSE` 要等本地先收到 'end' 才
 *    触发 `doClose`，黑洞连接下 'end' 永远不会来）。这里也不专门处理的话
 *    第 2 点修好了、第 4 点还是会卡死。`requestClose()` 里 `stream.close()`
 *    之后紧跟着起的 `graceTimer`（DISCONNECT_GRACE_MS）是这条路径的兜底。
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

    // C2：一个已经处于 aborted 状态的 signal，addEventListener('abort', …)
    // 永远不会再触发——它只在状态"变成" aborted 的那一刻触发一次。如果
    // 调用方复用同一个 signal 依次跑一串命令（Task 6 大概率是这个用法），
    // 前一条命令结束时 signal 可能早就是 aborted 了，这里必须主动查一次
    // 当前状态，而不是干等一个已经错过的事件——实测过：不做这个检查的
    // 话，一个提前 abort() 的 signal 会被完全忽略，命令照样在远端跑完。
    if (options.signal?.aborted) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: true,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutBytesSeen: 0,
        stderrBytesSeen: 0,
      })
      return
    }

    let settled = false
    let stream: ClientChannel | undefined
    let timedOut = false
    let aborted = false
    let closeRequested = false
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const streams = { stdout: newStreamState(), stderr: newStreamState() }
    let exitCode: number | null = null
    let execSignal: NodeJS.Signals | null = null
    let gotExit = false
    let streamError: Error | undefined

    const clearWatchdogs = () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
    }

    const buildResult = (): RemoteExecResult => {
      let stdoutBuf = Buffer.concat(streams.stdout.chunks)
      let stderrBuf = Buffer.concat(streams.stderr.chunks)
      // 只在真的发生过尾部窗口截断时才去修头部——命令自己的输出恰好在半个
      // 多字节字符上结束（没截断也没超时），那是远端命令自己的问题，不该
      // 被这里悄悄啃掉一块。
      if (streams.stdout.truncated) stdoutBuf = trimIncompleteUtf8Head(stdoutBuf)
      if (streams.stderr.truncated) stderrBuf = trimIncompleteUtf8Head(stderrBuf)
      return {
        stdout: stdoutBuf.toString('utf8'),
        stderr: stderrBuf.toString('utf8'),
        exitCode: timedOut || aborted ? null : exitCode,
        signal: execSignal,
        timedOut,
        aborted,
        stdoutTruncated: streams.stdout.truncated,
        stderrTruncated: streams.stderr.truncated,
        stdoutBytesSeen: streams.stdout.bytesSeen,
        stderrBytesSeen: streams.stderr.bytesSeen,
      }
    }

    const settleResolve = () => {
      if (settled) return
      settled = true
      clearWatchdogs()
      options.signal?.removeEventListener('abort', onAbort)
      resolve(buildResult())
    }

    const settleReject = (error: Error) => {
      if (settled) return
      settled = true
      clearWatchdogs()
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    }

    // 超时/取消触发 stream.close() 之后共同的兜底：不管是 armDeadline() 还是
    // onAbort() 先触发，close 请求只真正发一次（idempotent 归 idempotent，
    // 但重复调用会导致 armGrace() 被调用两次，第二次会用新的定时器覆盖掉
    // 前一个的引用，泄漏一个孤儿定时器——用 closeRequested 挡住这种重入）。
    const requestClose = () => {
      if (closeRequested) return
      closeRequested = true
      if (stream) {
        stream.close()
        graceTimer = setTimeout(settleResolve, DISCONNECT_GRACE_MS)
      } else {
        // 还没拿到 channel（要么 exec 的回调还没触发，要么已经永远不会
        // 触发）——没有任何东西可以 close()，也没有什么值得再等的，直接
        // 结算。
        settleResolve()
      }
    }

    const onAbort = () => {
      aborted = true
      requestClose()
    }
    // C2：必须在调用 exec() 之前就挂上这个监听器，而不是像最初版本那样
    // 挂在 exec 的回调里面——否则 abort 如果发生在"调用 exec()"和"exec
    // 的回调触发"之间的这个窗口，监听器那时候根本还不存在，abort 事件会
    // 被无声吞掉，命令在远端正常跑完，调用方却以为自己已经取消了它
    // （用一个"调用后立刻 abort，抢在真实网络往返之前"的测试复现过）。
    options.signal?.addEventListener('abort', onAbort, { once: true })

    // C1：在调用 exec() 之前就把整个操作的截止时间摆好，覆盖 channel-open
    // 阶段。没有这个的话，只有等真的拿到 stream 之后才会起 timer，channel
    // -open 请求被对端黑洞掉（手机从 Wi-Fi 切到蜂窝网络就是典型场景）时
    // exec() 的回调永远不会来，execRemote() 会永远 pending，timeoutMs
    // 形同虚设。
    deadlineTimer = setTimeout(() => {
      timedOut = true
      requestClose()
    }, options.timeoutMs)

    try {
      client.exec(command, (err, s) => {
        if (settled) {
          // 已经因为 channel-open 阶段的超时/取消结算过了——这个迟到的
          // 回调只需要善后：如果确实拿到了 stream，把它关掉，不留一条
          // 没人管的 channel；不能再触发第二次 resolve/reject。
          s?.close()
          return
        }
        if (err) {
          settleReject(toDisconnectedError(err, '执行远程命令失败', { started: false }))
          return
        }
        stream = s
        // C2 的第二个检查点：abort 也可能落在"调用 exec()"和"回调携带
        // stream 到达"之间——上面的 onAbort 那时候还没有 stream 可以关，
        // 只能标记 aborted 然后靠 requestClose() 在没有 stream 时直接
        // 结算；但如果 exec 的回调紧接着才到，就不能再假装"没有 stream"
        // 了，这里补上：一旦真的拿到 stream，立刻重新检查一遍 signal 的
        // 当前状态，该关就关。
        if (aborted || options.signal?.aborted) {
          aborted = true
          requestClose()
          return
        }
        runExec(stream)
      })
    } catch (err) {
      settleReject(toDisconnectedError(err, 'SSH 连接已断开，无法执行命令', { started: false }))
    }

    function runExec(execStream: ClientChannel): void {
      const append = (chunk: Buffer, which: 'stdout' | 'stderr') => {
        const state = streams[which]
        state.bytesSeen += chunk.length

        // I1：onData 是外部消费者代码（Task 6 的 start()/readOutput() 增量
        // 直播），它可能抛错——不能让消费者的 bug 冒充成传输层故障。实测：
        // 不包这层 try/catch 时，onData 抛出的异常经 ssh2 Channel.emit →
        // Readable.read 这条调用链变成一次 vitest "Uncaught Exception"，
        // 而且两次实测出现过不同的表现（一次是进程直接崩，一次被误判成
        // 连接断开）——两种都不对，onData 出不出错跟 SSH 连接健不健康没有
        // 任何关系。用 StringDecoder 而不是逐块 chunk.toString('utf8') 是
        // 因为一个多字节字符完全可能横跨两次网络 'data' 事件被拆开；
        // StringDecoder 会把不完整的尾部字节缓存起来等下一块数据补全，
        // 不会在这里的回调里冒出 U+FFFD。
        if (options.onData) {
          try {
            options.onData(state.decoder.write(chunk), which)
          } catch {
            // 故意吞掉：onData 是只读的旁路通知，它的失败不该影响 exec
            // 本身的收集与结算。
          }
        }

        // Task 6 review 修复：stderr 曾经跟 stdout 共用同一个
        // options.stdoutMaxBytes 阈值——跟 dsh-shell 的文档矛盾（见上面
        // RemoteExecOptions.stdoutMaxBytes 的注释）。这里按流选阈值：
        // stdout 用 stdoutMaxBytes；stderr 用 stderrMaxBytes，未提供时才
        // 退化为 stdoutMaxBytes（仅为兼容这个字段引入之前的调用方）。
        const maxBytesForStream = which === 'stdout' ? options.stdoutMaxBytes : (options.stderrMaxBytes ?? options.stdoutMaxBytes)

        // 尾部滑动窗口：新数据永远追加在后面，然后从窗口最前面按需丢弃，
        // 直到窗口内字节数回到预算以内。跟"收完全部再截断"不同，这里任意
        // 时刻窗口内存占用都有界（至多这个预算加上最后一次追加的那个
        // chunk 的大小）。
        state.chunks.push(chunk)
        state.windowBytes += chunk.length
        if (state.windowBytes > maxBytesForStream) state.truncated = true
        while (state.chunks.length > 0 && state.windowBytes > maxBytesForStream) {
          const front = state.chunks[0]!
          const excess = state.windowBytes - maxBytesForStream
          if (front.length <= excess) {
            state.chunks.shift()
            state.windowBytes -= front.length
          } else {
            // 只需要丢掉这个 chunk 前面的一部分，保留它自己的尾部。
            state.chunks[0] = front.subarray(excess)
            state.windowBytes -= excess
          }
        }
      }

      // 必须在拿到 stream 后的这一刻、同一个 tick 里同步挂上 data
      // 监听器：实测 ssh2 的 exec channel 默认是暂停模式，如果不给它挂至少
      // 一个 'data' 监听器让它进入流动模式，'close' 事件永远不会触发——
      // 哪怕命令早就跑完、哪怕后来手动调用了 stream.close()。这不是猜测：
      // 用一个独立探针脚本对比过"挂了 data 监听器"和"完全不挂"两种情况，
      // 后者跑到 3 秒超时也等不到 close。
      execStream.on('data', (chunk: Buffer) => append(chunk, 'stdout'))
      execStream.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'))

      // 防止一次真实的 channel 级错误在没有监听器的情况下变成 Node 的
      // 未捕获异常——EventEmitter 对没人监听的 'error' 事件默认直接抛出，
      // 会打崩整个进程，而 vitest 只会把它计成"Unhandled Errors"，不会让
      // 相关测试显式失败，等于把 bug 藏起来。这里只记录，真正的判定逻辑
      // 在下面的 'close' 处理器里（结合"有没有收到 exit"一起看）。
      execStream.on('error', (err: Error) => { streamError = err })
      execStream.stderr.on('error', (err: Error) => { streamError = err })

      // 实测：ssh2 对信号终止的进程会把 code 报成 null、把信号名报成已经
      // 带 "SIG" 前缀的形式（比如伪造 sshd 的 `stream.exit('TERM')`，客户端
      // 收到的却是 "SIGTERM"），且这个事件对普通退出和信号终止是同一个
      // 'exit'，靠有没有第二个参数区分。
      execStream.on('exit', (code: number | null, sig?: string) => {
        gotExit = true
        exitCode = code
        if (sig) execSignal = (sig.startsWith('SIG') ? sig : `SIG${sig}`) as NodeJS.Signals
      })

      execStream.on('close', () => {
        // 边界判定（见函数顶部的说明第 3 点）：既不是我们自己因超时/取消
        // 而主动 close() 的，也从没收到过 'exit' 事件，'close' 却来了——
        // 这是连接中途断开，不是命令跑完了。命令已经拿到过 channel、
        // 确实在远端跑起来过，所以 started: true；断线前收集到的部分
        // 输出一并带上，移动网络断线是常态，直接丢弃是真实的信息损失。
        if (!gotExit && !timedOut && !aborted) {
          const detail = streamError ? `：${streamError.message}` : ''
          const partial = buildResult()
          settleReject(
            new SshError(`执行远程命令时连接断开${detail}`, 'SSH_DISCONNECTED', true, {
              started: true,
              partialStdout: partial.stdout,
              partialStderr: partial.stderr,
            }),
          )
          return
        }
        settleResolve()
      })

      // I4：不管调用方有没有提供 stdin，都主动关闭写入端。dsh 本地执行的
      // 语义是 SubprocessStdinMode 'ignore' 时接到 /dev/null（等价于立刻
      // EOF），这里如果 options.stdin 是 undefined 却什么都不做，写入端
      // 就一直开着——一个会读 stdin 的远程命令（哪怕只是 `cat` 或者一个
      // 交互式确认提示）会一直等 EOF 等到 timeoutMs 耗尽，而不是立刻拿到
      // EOF 正常结束。
      execStream.end(options.stdin ?? '')
    }
  })
}
