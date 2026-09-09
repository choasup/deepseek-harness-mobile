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

// ── 第一步半：给每行日志加上"启动第几秒" ─────────────────────────────
//
// 没有时间戳时，"dsh 起来了但外壳说连不上"这种问题只能靠猜——分不清是它没起来
// 还是起得太慢。实测就栽过一次：自检和插件树抢线程把启动拖过外壳 45 秒的超时线，
// 日志里一切正常，症状却是"dsh 没能启动"。
//
// 前缀是秒数而不是墙上时间：要回答的问题是"到这一步花了多久"。
{
  const started = Date.now()
  const write = console.log.bind(console)
  console.log = (...args) => {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1).padStart(5)
    write(`[${elapsed}s]`, ...args)
  }
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
// 这里只**准备**自检，真正跑是在 dsh 起来之后（文件末尾）。
let selfTestAfter
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

    // 不再自己拼调用链——直接调附件服务的**真实入口** `prepareImageFile`，
    // 相机和上传走的就是它。自己拼链只能覆盖"我想到的方法"，而最后一次
    // 失败漏的根本不是方法，是元数据契约（少报 depth/space，
    // `undefined !== "uchar"` 恒成立，每张图都在最后一步被判负）。
    //
    // **不 await，而且要等 dsh 起完再跑。**
    //
    // 早先只是"不 await"，让它和插件树加载并行——错的。Node 是单线程，
    // 解四张 2100 像素宽的图 + 十几趟原生桥往返，全都在和启动抢同一个线程。
    // 外壳的启动超时是 45 秒，被拖过线之后它就宣告"dsh 没能启动"，
    // 而日志里 dsh 明明起来了、自检还全绿——**最难查的那种失败**。
    //
    // 现在挂在 dshReady 之后：dsh 先服务，自检再跑。诊断不该有代价。
    selfTestAfter = () => import('./bridge-selftest.mjs')

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

// ── 第二步又三分之一：fetch 中断语义自检 ─────────────────────────────
//
// 规范要求被 AbortSignal 中断的 fetch 以 **AbortError** 失败。dsh 靠
// `error.name === 'AbortError'` 区分"用户取消"与"网络故障"；传成普通 Error
// 时，用户按"停止生成"会被当成网络失败——界面弹 Load failed，生成也停不下来。
//
// 这条**必须测流开始之后的中断**，不能只测发出前——两者走的是不同分支，
// 而真实场景是前者。这一课已经交过两次学费（raw、toColourspace）。
{
  const http = await import('node:http')
  const server = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const timer = setInterval(() => res.write('data: x\n\n'), 40)
    res.on('close', () => clearInterval(timer))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const controller = new AbortController()
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: controller.signal })
    const reader = res.body.getReader()
    await reader.read()
    controller.abort()
    await reader.read()
    console.log('[bridge-selftest] abort 语义: 未抛错（不对）')
  } catch (error) {
    const ok = error?.name === 'AbortError'
    console.log(`[bridge-selftest] abort 语义: ${error?.name} ${ok ? 'ok' : '← 应为 AbortError'}`)
  }
  server.close()
}

// ── 第三步：进 dsh ───────────────────────────────────────────────────
await import('./node_modules/@deepseek-ai/dsh/lib/bin.js')

// ── 第三步半：确认端口真的在接受连接 ─────────────────────────────────
//
// **"dsh 打印了一个 URL"和"端口真的通"是两件事。** 实测遇到过两次：日志里
// `dsh web: http://127.0.0.1:47799` 打印了、自检全绿、进程也活着，外壳却报
// "无法连接服务器"。若 `listen()` 因端口被上一个实例占着而失败，那行照样会打印，
// 而错误可能被吞掉——光看日志分辨不出来。
//
// 所以这里自己连一次。这是**否定证据的来源**：下次再出现同样的症状，
// 这一行会直接说清是"端口通、外壳连不上"还是"端口根本没起来"。
{
  const http = await import('node:http')
  const port = Number(process.argv.find((a, i) => process.argv[i - 1] === '--port') ?? 47799)
  const probe = (attempt) =>
    new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 2000 },
        (res) => {
          res.resume()
          resolve(`HTTP ${res.statusCode}`)
        },
      )
      req.on('timeout', () => req.destroy(new Error('超时')))
      req.on('error', (error) => resolve(`${error.code ?? ''} ${error.message}`))
      req.end()
    })
  // 连三次：第一次可能恰好赶在 listen 之前。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await probe(attempt)
    if (result.startsWith('HTTP')) {
      console.log(`[port-check] 127.0.0.1:${port} 通了（${result}）`)
      break
    }
    if (attempt === 3) {
      console.log(`[port-check] 127.0.0.1:${port} **连不上**：${result}——端口没起来，不是外壳的问题`)
    } else {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

// ── 第四步：dsh 起来之后再跑自检 ─────────────────────────────────────
//
// 顺序是有代价的教训：自检和启动并行会把启动拖过外壳 45 秒的超时线，
// 表现成"dsh 没能启动"而日志里一切正常。见上面 selfTestAfter 那段。
if (typeof selfTestAfter === 'function') {
  selfTestAfter()
    .then(async (selftest) => {
      const ok = await selftest.runAttachmentSelfTest((line) => console.log(line))
      console.log(`[bridge-selftest] 附件归一化自检${ok ? '全部通过' : '有失败项'}`)
      const sensorOk = await selftest.runSensorSelfTest((line) => console.log(line))
      console.log(`[sensor-selftest] 传感器自检${sensorOk ? '通过' : '有失败项'}`)
    })
    .catch((error) => console.log(`[bridge-selftest] 自检没跑起来: ${error?.stack ?? error}`))
}
