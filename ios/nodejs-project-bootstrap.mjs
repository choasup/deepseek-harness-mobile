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

// ── 第三步：进 dsh ───────────────────────────────────────────────────
await import('./node_modules/@deepseek-ai/dsh/lib/bin.js')
