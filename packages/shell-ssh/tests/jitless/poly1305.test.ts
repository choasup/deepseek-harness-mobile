import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 这些用例**必须**走真的 `node --jitless` 子进程。
 *
 * vitest 自己跑不了 jitless——Vite 的工具链需要 WebAssembly，runner 在任何测试
 * 代码执行前就死。而 iOS 上的 V8 正是 jitless 且无 WASM，所以"能否在 jitless 下
 * 建立 SSH 连接"这个问题，只有子进程能回答。
 *
 * 同理不能用 `--experimental-strip-types` 加载 .ts：Node 的类型剥离器本身是 WASM 的。
 * 所以下面的脚本是手写的 CommonJS。
 */
const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 在 jitless 子进程里跑一段 CJS，返回 stdout。 */
function runJitless(script: string): string {
  return execFileSync(process.execPath, ['--jitless', '--input-type=commonjs', '-e', script], {
    encoding: 'utf8',
    cwd: PKG_ROOT,
    timeout: 60_000,
  })
}

const SHIM = `
  const nacl = require('tweetnacl')
  const { crypto_onetimeauth } = nacl.lowlevel
  const heap = new Uint8Array(64)
  const shim = async () => ({
    HEAPU8: heap,
    _malloc: () => 0,
    cwrap: () => (outPtr, m1, m1len, m2, m2len, key) => {
      const msg = new Uint8Array(m1len + m2len)
      msg.set(m1.subarray(0, m1len), 0)
      msg.set(m2.subarray(0, m2len), m1len)
      crypto_onetimeauth(heap, outPtr, msg, 0, msg.length, key)
    },
  })
  const p = require.resolve('ssh2/lib/protocol/crypto/poly1305.js')
  require.cache[p] = { id: p, filename: p, loaded: true, exports: shim, children: [], paths: [] }
`

/** 起一个假 sshd、连上去、执行一条命令，打印结果。cipher 可强制指定。 */
const HANDSHAKE = (cipher: string) => `
  const { generateKeyPairSync } = require('node:crypto')
  const { Server, Client } = require('ssh2')
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type:'pkcs1', format:'pem' }, publicKeyEncoding: { type:'spki', format:'pem' } })
  const srv = new Server({ hostKeys: [privateKey] }, (cl) => {
    cl.on('authentication', a => a.method === 'none' ? a.reject() : a.accept())
    cl.on('ready', () => cl.on('session', acc => acc().on('exec', ae => {
      const st = ae(); st.write('remote-ok'); st.exit(0); st.end()
    })))
    cl.on('error', () => {})
  })
  srv.listen(0, '127.0.0.1', () => {
    const c = new Client()
    c.on('ready', () => c.exec('x', (e, st) => {
        if (e) { console.log('EXEC_ERR:' + e.message); process.exit(1) }
        let s = ''
        st.on('data', d => s += d).on('close', code => {
          console.log('WASM=' + typeof WebAssembly)
          console.log('STDOUT=' + s)
          console.log('EXIT=' + code)
          c.end(); srv.close(); process.exit(0)
        })
      }))
     .on('error', e => { console.log('CONN_ERR:' + e.message); process.exit(1) })
     .connect({ host:'127.0.0.1', port: srv.address().port, username:'t', password:'x',
                algorithms: { cipher: ['${cipher}'] } })
  })
  setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 30000)
`

describe('jitless 下的 ssh2', () => {
  it('未打替身时，ssh2 无法建立连接（这就是待修的 bug）', () => {
    // 反向对照：证明这套测试真的在测东西，而不是碰巧通过。
    let output = ''
    try {
      output = runJitless(`
        process.on('unhandledRejection', () => {})
        ${HANDSHAKE('chacha20-poly1305@openssh.com')}
      `)
    } catch (err) {
      output = String((err as { stdout?: string }).stdout ?? '') + String(err)
    }
    expect(output).not.toContain('STDOUT=remote-ok')
    expect(output).toMatch(/WebAssembly is not defined|TIMEOUT|CONN_ERR/)
  })

  it('打上纯 JS 的 Poly1305 替身后，握手与远程执行都成功', () => {
    const out = runJitless(SHIM + HANDSHAKE('chacha20-poly1305@openssh.com'))
    // 断言它真的跑在无 WASM 的环境里，否则这条测试毫无意义。
    expect(out).toContain('WASM=undefined')
    expect(out).toContain('STDOUT=remote-ok')
    expect(out).toContain('EXIT=0')
  })

  it('AES-GCM 同样可用（说明修的不只是 chacha 那一条路径）', () => {
    const out = runJitless(SHIM + HANDSHAKE('aes128-gcm@openssh.com'))
    expect(out).toContain('WASM=undefined')
    expect(out).toContain('STDOUT=remote-ok')
  })
})
