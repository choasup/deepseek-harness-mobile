/**
 * sharp 的 iOS 实现：把图像处理转发给原生侧的 CoreImage/ImageIO。
 *
 * ## 为什么不是 sharp 本身
 *
 * sharp 是 libvips 的原生绑定，iOS 上 dlopen 不了（WASM 变体也不行——jitless
 * 关掉了 WebAssembly）。但手机本来就有更合适的东西：ImageIO 读元数据不解码
 * 整张图，降采样解码不会把 4800 万像素解进内存。所以不是"把 libvips 弄上
 * iOS"，而是绕开它。
 *
 * ## 只实现用到的那一小块
 *
 * 查过 `dsh-attachment-local` 的调用点，实际用到的是：
 *   sharp(data) / .metadata() / .resize() / .rotate() / .jpeg() / .png()
 *   / .webp() / .toBuffer() / .clone() / sharp.kernel
 * 不做 sharp 的完整 API——多写的每一个方法都是一处没人验证的行为。
 *
 * ## 链式调用怎么处理
 *
 * sharp 是惰性管线：`sharp(buf).resize(...).jpeg(...).toBuffer()`。这里同样
 * 惰性——只记录参数，`toBuffer()`/`metadata()` 时才发一次桥请求。
 * 于是无论链多长都只过一次原生，不会来回搬字节。
 */
const http = require('node:http')

const BRIDGE = process.env.DSH_NATIVE_BRIDGE

function unavailable() {
  return new Error(
    'iOS 上的图像处理需要原生桥，但 DSH_NATIVE_BRIDGE 未设置。' +
      '这通常意味着原生侧的 NativeBridge 没能启动。',
  )
}

/** 向桥发一次请求。返回 { status, contentType, body }。 */
function call(path, body, query) {
  if (!BRIDGE) return Promise.reject(unavailable())
  const url = new URL(path, BRIDGE)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': body.length },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'] ?? '',
            body: Buffer.concat(chunks),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** 把桥返回的错误翻译成一句人能读懂的话，而不是抛出一个 JSON。 */
function bridgeError(result, what) {
  let detail = result.body.toString('utf8').slice(0, 200)
  try {
    detail = JSON.parse(detail).error ?? detail
  } catch {}
  return new Error(`${what}失败（HTTP ${result.status}）：${detail}`)
}

class Pipeline {
  constructor(input, ops) {
    this._input = input
    // 惰性：只记参数，真正处理推迟到 toBuffer()/metadata()
    this._ops = ops ?? { maxDim: 0, quality: 0.8, format: 'jpeg' }
  }

  clone() {
    return new Pipeline(this._input, { ...this._ops })
  }

  /** sharp 的 resize 有多种签名；这里取长边上限，这是附件服务实际用到的语义。 */
  resize(width, height, options) {
    const opts = typeof width === 'object' && width !== null ? width : { width, height, ...options }
    const longest = Math.max(opts.width ?? 0, opts.height ?? 0)
    return new Pipeline(this._input, { ...this._ops, maxDim: longest || this._ops.maxDim })
  }

  /** EXIF 方向由原生侧在降采样时一并处理，这里只需保持链式。 */
  rotate() {
    return this
  }

  jpeg(options) {
    const quality = options?.quality
    return new Pipeline(this._input, {
      ...this._ops,
      format: 'jpeg',
      quality: quality ? quality / 100 : this._ops.quality,
    })
  }

  png() {
    return new Pipeline(this._input, { ...this._ops, format: 'png' })
  }

  /** iOS 的 ImageIO 不写 WebP，退回 JPEG——**有意的降级**，不是遗漏。 */
  webp(options) {
    return this.jpeg(options)
  }

  async metadata() {
    const result = await call('/image/metadata', this._input)
    if (result.status !== 200) throw bridgeError(result, '读取图像元数据')
    const meta = JSON.parse(result.body.toString('utf8'))
    return {
      format: meta.format,
      width: meta.width,
      height: meta.height,
      hasAlpha: meta.hasAlpha,
      orientation: meta.orientation,
      channels: meta.hasAlpha ? 4 : 3,
    }
  }

  async toBuffer(options) {
    const result = await call('/image/normalize', this._input, {
      maxDim: this._ops.maxDim,
      quality: this._ops.quality,
      format: this._ops.format,
    })
    if (result.status !== 200) throw bridgeError(result, '图像编码')
    if (options?.resolveWithObject) {
      const meta = await new Pipeline(result.body).metadata()
      return { data: result.body, info: { ...meta, size: result.body.length } }
    }
    return result.body
  }

  /** 统计信息：附件服务用它判断是否"低色彩数"。原生侧没实现，给一个不会
   *  误导的保守值——宁可让调用方走通用路径，也不要编造一个数字。 */
  async stats() {
    throw new Error('iOS 的图像桥不提供 stats()')
  }
}

function sharp(input) {
  if (!Buffer.isBuffer(input)) {
    throw new Error('iOS 的图像桥只接受 Buffer 输入')
  }
  return new Pipeline(input)
}

sharp.kernel = Object.freeze({
  nearest: 'nearest',
  cubic: 'cubic',
  mitchell: 'mitchell',
  lanczos2: 'lanczos2',
  lanczos3: 'lanczos3',
})
sharp.fit = Object.freeze({
  contain: 'contain',
  cover: 'cover',
  fill: 'fill',
  inside: 'inside',
  outside: 'outside',
})
sharp.format = Object.freeze({})
/** 便于排查：这是桥接实现，不是真的 sharp。 */
sharp.__dshMobileBridge = true

module.exports = sharp
module.exports.default = sharp
