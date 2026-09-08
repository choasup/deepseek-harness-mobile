/**
 * 设备内 dsh 的入口。**不要直接跑 dsh 的 bin.js。**
 *
 * ## 这个文件为什么长这样（没有一行静态 import）
 *
 * iOS 只能跑 jitless 的 V8，而 jitless 没有 WebAssembly。Node 内置的 undici
 * 在模块作用域就调 `WebAssembly.compile`，且它接住 rejection 的方式是
 * `llhttpPromise.catch()`——**不传处理函数，等于没接住**，于是变成 unhandled
 * rejection 把进程带走。设备上看到的就是：
 *
 *     dsh: fatal load failure: ReferenceError: WebAssembly is not defined
 *         at lazyllhttp (node:internal/deps/undici/undici:5827:9)
 *
 * 而 undici 被拉起的时机比想象中早得多——实测 Node 22 上
 * **`import 'node:http'` 本身就会拉起它**（Node 24 不会，版本差异）。
 * ESM 的静态 import 在模块代码之前求值，所以只要这个文件有任何静态 import，
 * 桩就来不及装。
 *
 * 因此：零静态 import，桩内联在最顶部，其余一律用顶层 await + 动态 import。
 * 顺序由此确定。
 */

// ── 第一步：WebAssembly 桩。必须在任何 import 之前。────────────────────
//
// 为什么是"永不 settle"而不是抛错或 reject：见上面 `.catch()` 那段。
// 让 compile 永远悬着，undici 的那条链就静静挂着，谁也不炸。
// 代价是真要用 WASM 会静默挂起——但 jitless 下 WASM 本就不存在，
// 这里选的是"挂起"而非"在加载期带走整个进程"。
if (typeof WebAssembly === 'undefined') {
  const pending = () => new Promise(() => {})
  Object.defineProperty(globalThis, 'WebAssembly', {
    value: {
      compile: pending,
      instantiate: pending,
      compileStreaming: pending,
      instantiateStreaming: pending,
      validate: () => false,
      Module: class Module {},
      Instance: class Instance {},
      Memory: class Memory {},
      Table: class Table {},
      Global: class Global {},
      CompileError: class CompileError extends Error {},
      LinkError: class LinkError extends Error {},
      RuntimeError: class RuntimeError extends Error {},
      __dshMobileStub: true,
    },
    writable: true,
    configurable: true,
  })
}

// ── 第二步：把 fetch 换成走 node:http 的实现 ──────────────────────────
const { installFetchShim } = await import('./fetch-over-node-http.mjs')
const swapped = installFetchShim()

// 嵌入式 Node 的参数落在哪儿、内部模块能不能 require——这两件事都不能靠猜。
let internals = 'no'
try {
  const { createRequire } = await import('node:module')
  createRequire(import.meta.url)('node:internal/errors')
  internals = 'yes'
} catch (e) {
  internals = `no (${String(e.code ?? e.message).slice(0, 40)})`
}
console.log(`[bootstrap] execArgv=${JSON.stringify(process.execArgv)}`)
console.log(`[bootstrap] argv=${JSON.stringify(process.argv.slice(0, 4))}`)
console.log(`[bootstrap] require internals: ${internals}`)

console.log(
  `[bootstrap] WebAssembly=${typeof WebAssembly}` +
    `(stub=${globalThis.WebAssembly?.__dshMobileStub === true}) fetch-swapped=${swapped}`,
)

// ── 第二步半：原生桥自检 ─────────────────────────────────────────────
//
// 为什么要有这个：附件服务对**任何**图像错误都抛同一句
// "Unsupported or malformed image data"，真实原因被塞进 cause 而不显示。
// 于是桥一旦有问题，症状是一句与真因无关的话，只能靠用户反复拍照来试。
//
// 自检把这条链在启动时就走一遍（1×1 的 PNG，几十字节），成败都写进日志。
// 用户不必再当测试员。
if (process.env.DSH_NATIVE_BRIDGE) {
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  try {
    const sharp = (await import('./node_modules/sharp/index.cjs')).default
    const meta = await sharp(PNG_1X1).metadata()
    console.log(`[bridge-selftest] metadata ok: ${JSON.stringify(meta)}`)
    const out = await sharp(PNG_1X1).resize(64).jpeg({ quality: 80 }).toBuffer()
    console.log(`[bridge-selftest] normalize ok: ${out.length} 字节`)

    // raw 路径：附件服务每次存图都会走它（hasLowColourCount），
    // 而它正是相机连续四次失败的根因——上一版自检没覆盖到，所以没测出来。
    const rawOut = await sharp(PNG_1X1).clone().resize({ width: 64, height: 64 }).raw()
      .toBuffer({ resolveWithObject: true })
    console.log(`[bridge-selftest] raw ok: ${rawOut.data.length} 字节 info=${JSON.stringify(rawOut.info)}`)

    // 大 body 专项：相机照片是几百 KB，而上面那张 PNG 只有几十字节。
    // 相机路由（空 body）是通的、metadata（小 body）也是通的，唯独真实照片失败
    // ——差别就在体积，所以这里单独把传输层压一遍。
    // 这里**不关心它是不是合法图像**：只要拿回任何 HTTP 状态码，就说明
    // 请求体被完整收下了；连接层面出错才是我们要找的问题。
    for (const size of [64 * 1024, 256 * 1024, 1024 * 1024]) {
      try {
        const http = await import('node:http')
        const payload = Buffer.alloc(size, 0x41)
        const status = await new Promise((resolve, reject) => {
          const req = http.request(
            new URL('/image/metadata', process.env.DSH_NATIVE_BRIDGE),
            { method: 'POST', headers: { 'content-length': payload.length } },
            (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) },
          )
          req.on('error', reject)
          req.setTimeout(10_000, () => req.destroy(new Error('超时')))
          req.end(payload)
        })
        console.log(`[bridge-selftest] ${size / 1024}KB body → HTTP ${status}（传输正常）`)
      } catch (error) {
        console.log(`[bridge-selftest] ${size / 1024}KB body → 失败: ${error?.code ?? ''} ${error?.message}`)
      }
    }
  } catch (error) {
    // 打完整信息：message 往往不够，桥的失败常常在 code/errno 上
    console.log(
      `[bridge-selftest] 失败: ${error?.name} ${error?.message} ` +
        `code=${error?.code} errno=${error?.errno} cause=${error?.cause?.message ?? ''}`,
    )
  }
}

// ── 第三步：进 dsh ───────────────────────────────────────────────────
await import('./node_modules/@deepseek-ai/dsh/lib/bin.js')
