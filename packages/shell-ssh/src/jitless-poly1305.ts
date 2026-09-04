/**
 * 让 ssh2 能在无 JIT、无 WebAssembly 的环境（iOS 上的 V8）里工作。
 *
 * ## 问题
 *
 * `ssh2/lib/protocol/crypto.js` 在模块加载时立即执行一个 IIFE：
 *
 * ```js
 * init: (() => new Promise(async (resolve, reject) => {
 *   POLY1305_WASM_MODULE = await require('./crypto/poly1305.js')()   // ← 内联的 WASM
 *   ...
 * }))()
 * ```
 *
 * 而 `client.js` 与 `server.js` 都**无条件**等待它：
 *
 * ```js
 * cryptoInit.then(() => { proto.start(); ... })   // 没有 .catch()
 * ```
 *
 * iOS 的 V8 是 jitless 的，jitless 关闭 WebAssembly，于是那个 promise reject、
 * `proto.start()` 永不执行、**任何 SSH 连接都无法开始**——与协商哪个 cipher 无关。
 * 同时那条 rejection 没人处理，Node 15+ 默认会直接终止进程。
 *
 * ## 解法
 *
 * ssh2 用 WASM 只为 Poly1305 这一个算法，而 `tweetnacl` 的
 * `lowlevel.crypto_onetimeauth` 就是纯 JS 的 Poly1305。在 ssh2 被 require 之前
 * 往 `require.cache` 里塞一个接口兼容的替身即可。
 *
 * 实测（`node --jitless`，`typeof WebAssembly === 'undefined'`，并强制协商
 * `chacha20-poly1305@openssh.com` 以确保走到这条路径）：握手与远程执行都成功。
 *
 * ## 用法
 *
 * **必须在第一次 `require('ssh2')` 之前调用。** 在 iOS 宿主的启动代码里调，
 * 早于加载 dsh 的插件树。在有 JIT 的桌面环境调它也是安全的——只是把一个
 * WASM 实现换成 JS 实现，行为一致，速度略慢。
 */
import { createRequire } from 'node:module'

/** 结果缓冲区。ssh2 通过 `HEAPU8.buffer` + 偏移量读取这 16 字节。 */
const HEAP_BYTES = 64
const RESULT_OFFSET = 0

let installed = false

/**
 * 用纯 JS 的 Poly1305 替换 ssh2 的 WASM 模块。
 *
 * @param requireFn - 用来解析 ssh2 与 tweetnacl 的 require；默认基于本模块。
 * @returns 是否真的执行了安装（重复调用返回 false）。
 */
export function installJitlessPoly1305(
  requireFn: NodeJS.Require = createRequire(import.meta.url),
): boolean {
  if (installed) return false

  const nacl = requireFn('tweetnacl') as {
    lowlevel: {
      crypto_onetimeauth(
        out: Uint8Array, outpos: number,
        m: Uint8Array, mpos: number, n: number,
        k: Uint8Array,
      ): number
    }
  }
  const { crypto_onetimeauth } = nacl.lowlevel
  const heap = new Uint8Array(HEAP_BYTES)

  // 复刻 emscripten 模块暴露给 crypto.js 的那三样：_malloc / cwrap / HEAPU8。
  const shim = async () => ({
    HEAPU8: heap,
    _malloc: () => RESULT_OFFSET,
    cwrap:
      () =>
      (
        outPtr: number,
        m1: Uint8Array, m1len: number,
        m2: Uint8Array, m2len: number,
        key: Uint8Array,
      ): void => {
        // ssh2 把 MAC 算在两段拼接上（包长密文 ‖ 载荷密文）。
        const msg = new Uint8Array(m1len + m2len)
        msg.set(m1.subarray(0, m1len), 0)
        msg.set(m2.subarray(0, m2len), m1len)
        crypto_onetimeauth(heap, outPtr, msg, 0, msg.length, key)
      },
  })

  const wasmPath = requireFn.resolve('ssh2/lib/protocol/crypto/poly1305.js')
  requireFn.cache[wasmPath] = {
    id: wasmPath,
    filename: wasmPath,
    loaded: true,
    exports: shim,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module

  installed = true
  return true
}

/** 仅供测试：重置安装标志。 */
export function resetJitlessPoly1305ForTesting(): void {
  installed = false
}
