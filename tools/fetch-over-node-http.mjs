/**
 * 用 `node:http` / `node:https` 实现 `fetch`，绕开 undici 的 WebAssembly。
 *
 * ## 为什么必须有这个
 *
 * iOS 只能跑 jitless 的 V8，而 jitless **关掉 WebAssembly**。Node 内置的
 * undici（`fetch` 的实现）用 WASM 版 llhttp 解析 HTTP，于是第一次调用 fetch
 * 就死：
 *
 *     ReferenceError: WebAssembly is not defined
 *         at lazyllhttp (node:internal/deps/undici/undici:5827:9)
 *
 * 这不是 dsh 的依赖，是 **Node 自己的**——所以躲不开，只能替换。
 *
 * ## 为什么只替换 fetch 就够
 *
 * 实测 jitless 下 `Headers` / `Request` / `Response` / `ReadableStream`
 * **全部可用**：它们是 V8/Node 原生实现，不经过 WASM。只有真正发请求那条
 * 路径（undici 的 HTTP/1 客户端）需要 llhttp。而 `node:http` 用的是编译进
 * libnode 的 **C++ 版** llhttp，同样不需要 WASM。
 *
 * 所以这里保留全部 web 标准对象，只把"把字节发出去、把字节读回来"这一段
 * 换成 node:http。调用方拿到的仍然是真正的 `Response`。
 */
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'

/** fetch 默认最多跟 20 次跳转，与规范一致。 */
const MAX_REDIRECTS = 20

async function nodeFetch(input, init) {
  const request = input instanceof Request && init === undefined ? input : new Request(input, init)
  // 请求体要先读完：node:http 要么给 Buffer 要么给流，而 Request 的 body
  // 只能消费一次，跳转重发时需要原始字节。
  const bodyBytes = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
  return send(request, bodyBytes, 0)
}

/**
 * 规范要求：被 AbortSignal 中断时，fetch 必须以 **AbortError** 失败。
 *
 * 这不是细节。dsh 和绝大多数代码都靠 `error.name === 'AbortError'` 区分
 * "用户主动取消" 与 "网络故障"：前者安静收尾，后者要报错甚至重试。
 * node:http 在 abort 时抛的是普通 Error（ECONNRESET / aborted），照传出去
 * 的话，用户按下"停止生成"会被当成网络失败——界面弹 "Load failed
 * (internal)"，而生成停不下来。实测就是这个现象。
 */
function abortReason(signal) {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function send(request, bodyBytes, redirectCount) {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url)
    const mod = url.protocol === 'https:' ? https : http

    const headers = {}
    for (const [k, v] of request.headers) headers[k] = v
    // Request 不会自动带 host 以外的这些；node:http 需要显式长度，
    // 否则会用 chunked，有些服务端不接受。
    if (bodyBytes) headers['content-length'] = String(bodyBytes.byteLength)

    const req = mod.request(
      url,
      { method: request.method, headers, signal: request.signal ?? undefined },
      (res) => {
        // 流已经开始之后再中断（"停止生成"的真实场景）：必须把中断原因带进
        // 响应流，否则读取方拿到的是连接重置，而不是"这是一次取消"。
        request.signal?.addEventListener(
          'abort',
          () => res.destroy(abortReason(request.signal)),
          { once: true },
        )
        const status = res.statusCode ?? 0
        // 跳转：fetch 的默认 redirect 模式是 follow。
        if (
          request.redirect !== 'manual' &&
          [301, 302, 303, 307, 308].includes(status) &&
          res.headers.location
        ) {
          res.resume() // 丢弃响应体，否则 socket 不释放
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new TypeError('fetch: too many redirects'))
            return
          }
          const next = new URL(res.headers.location, request.url)
          // 303，以及 301/302 上的 POST，按规范降级成 GET 且丢掉请求体。
          const downgrade = status === 303 || (request.method === 'POST' && (status === 301 || status === 302))
          const nextInit = {
            method: downgrade ? 'GET' : request.method,
            headers: request.headers,
            redirect: request.redirect,
            signal: request.signal ?? undefined,
          }
          resolve(send(new Request(next, nextInit), downgrade ? undefined : bodyBytes, redirectCount + 1))
          return
        }

        // 204/304 按规范不能有 body，给 Response 传流会抛。
        const empty = status === 204 || status === 304 || request.method === 'HEAD'
        resolve(
          new Response(empty ? null : Readable.toWeb(res), {
            status,
            statusText: res.statusMessage ?? '',
            headers: toHeaders(res.headers),
          }),
        )
      },
    )

    req.on('error', (err) => {
      // 中断导致的错误要还原成 AbortError；其余错误原样传出。
      reject(request.signal?.aborted === true ? abortReason(request.signal) : err)
    })
    if (bodyBytes) req.write(bodyBytes)
    req.end()
  })
}

/** node:http 的 headers 里 set-cookie 是数组，其余是字符串。 */
function toHeaders(raw) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(name, v)
    else headers.set(name, value)
  }
  return headers
}

/**
 * 装上替代实现。前提是 `wasm-stub.mjs` 已经先求值过——见那个文件的说明。
 * @returns 是否替换了 fetch。
 */
export function installFetchShim() {
  // 只在没有真 WASM 时替换。有 WASM（比如在 Mac 上跑）就用 Node 原生的 fetch。
  if (typeof WebAssembly !== 'undefined' && WebAssembly.__dshMobileStub !== true) return false
  Object.defineProperty(globalThis, 'fetch', {
    value: nodeFetch,
    writable: true,
    configurable: true,
  })
  return true
}
