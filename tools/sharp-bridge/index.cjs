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
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        )
      },
    )
    req.on('error', (err) => {
      // 桥的失败会被附件服务换成一句无关的 "Unsupported or malformed image
      // data"，真因只在 cause 里、没人显示。所以在这里就记下来。
      console.log(`[sharp-bridge] ${url.pathname} 请求失败: ${err.code ?? ''} ${err.message}`)
      reject(err)
    })
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

/**
 * "这张图带 EXIF" 的标记。
 *
 * 上游只判断 `metadata.exif !== undefined`，不看内容；桥不把 EXIF 字节搬过来
 * （没人要读它，搬过来只是白花一次拷贝）。用一个空 Buffer 表示"有"。
 */
const EXIF_PRESENT = Buffer.alloc(0)

class Pipeline {
  constructor(input, ops) {
    this._input = input
    // 惰性：只记参数，真正处理推迟到 toBuffer()/metadata()
    this._ops = ops ?? { maxDim: 0, quality: 0.8, format: 'jpeg' }
  }

  clone() {
    return new Pipeline(this._input, { ...this._ops })
  }

  /**
   * sharp 的 resize 有多种签名；这里取长边上限，这是附件服务实际用到的语义
   * （它传的一律是 `fit: "inside"` + 等比的 width/height）。
   *
   * `kernel: "nearest"` 要**原样带到原生侧**，不能忽略：附件服务数颜色时用的
   * 就是它，而平滑重采样会把一张噪声照片平均成一片灰、颜色数掉到个位数，
   * 于是照片被判成"少色截图"改用 PNG 编码——280KB 的 JPEG 变成 1.2MB 的 PNG。
   */
  resize(width, height, options) {
    const opts = typeof width === 'object' && width !== null ? width : { width, height, ...options }
    const longest = Math.max(opts.width ?? 0, opts.height ?? 0)
    return new Pipeline(this._input, {
      ...this._ops,
      maxDim: longest || this._ops.maxDim,
      nearest: opts.kernel === 'nearest',
    })
  }

  /** EXIF 方向由原生侧在降采样时一并处理，这里只需保持链式。 */
  rotate() {
    return this
  }

  /**
   * 输出原始 RGBA 像素而不是编码后的图。
   *
   * **这个方法不是可选的**：附件服务的 `hasLowColourCount` 在**每次存图**时
   * 都会走 `.resize(...).raw().toBuffer({ resolveWithObject: true })`。
   * 少了它，`.raw()` 返回 undefined、下一步 TypeError，而上游会把它换成
   * "Unsupported or malformed image data"——一句与真因毫无关系的错误。
   * 相机功能连续四次失败，根因就是这里。
   */
  raw() {
    return new Pipeline(this._input, { ...this._ops, format: 'raw' })
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

  /**
   * WebP 输出。
   *
   * **不能偷偷退回 JPEG。** 上游 `encode()` 用调用方请求的 media type 给结果
   * 打标签，然后 `verifyNormalizedImage` 重新解码、比对 `detected.mediaType
   * !== image.mediaType`——退回 JPEG 就是"标着 webp 的 JPEG 字节"，必然判负，
   * 而报出来的还是那句和真因无关的 "Unsupported or malformed image data"。
   *
   * 所以这里如实请求 webp；原生侧编不了就返回 501，错误里直接说清楚。
   */
  webp(options) {
    const quality = options?.quality
    return new Pipeline(this._input, {
      ...this._ops,
      format: 'webp',
      quality: quality ? quality / 100 : this._ops.quality,
    })
  }

  /**
   * 色彩空间转换。原生侧的 CGContext 用的就是 DeviceRGB，输出本来就是 8 位
   * sRGB，所以这里只需保持链式、不做额外处理。
   *
   * **但不能不实现**：附件服务在归一化前会走
   * `sharp(data).rotate().toColourspace("srgb")`，缺了它返回 undefined、
   * 下一步 TypeError，而上游会把它换成
   * "The undefined JPEG could not be converted to the normalized 8-bit sRGB form"
   * ——一句指向色彩空间、实则与色彩空间无关的错误。
   */
  toColourspace() {
    return this
  }

  /** 英式拼写的别名，sharp 两个都提供。 */
  toColorspace() {
    return this
  }

  /**
   * 裁掉边缘同色区域。原生侧没实现，**原样返回**而不是抛错。
   *
   * 这是有意的取舍：trim 是"锦上添花"的优化（去掉截图白边），跳过它只会让
   * 图片略大一点，而抛错会让整张图存不进去。宁可少一个优化，不要断一条主路。
   */
  trim() {
    return this
  }

  /**
   * 元数据。**字段不是"顺手多报"，是上游的硬性契约。**
   *
   * dsh 的 `verifyNormalizedImage` 会把刚编码出来的字节重新解码，逐项比对
   * media type、宽、高、`depth === "uchar"`、`space === "srgb"`、单帧、
   * 以及"不携带元数据"；任何一项对不上都抛同一句
   * "Unsupported or malformed image data"——**不说是哪一项**。
   * 早先这里只报 format/width/height/hasAlpha，于是 `undefined !== "uchar"`
   * 恒成立，每一张图都在最后一步被判负。相机连续失败的根因就在这里。
   */
  async metadata() {
    const result = await call('/image/metadata', this._input)
    if (result.status !== 200) throw bridgeError(result, '读取图像元数据')
    const meta = JSON.parse(result.body.toString('utf8'))
    // 附件服务只认 png/jpeg/webp/gif；format 落在这之外时它抛的是
    // "Unsupported or malformed image data"，**完全不提是什么格式**。
    // 所以在这里把真实值记下来，否则只能靠猜。
    if (!['png', 'jpeg', 'webp', 'gif'].includes(meta.format)) {
      console.error(
        `[sharp-bridge] 原生侧识别出的格式是 "${meta.format}"，` +
          `（原始 UTI "${meta.uti}"）不在附件服务接受的 png/jpeg/webp/gif 之内；` +
          `输入 ${this._input.length} 字节，前 4 字节 ${this._input.subarray(0, 4).toString('hex')}`,
      )
    }
    return {
      format: meta.format,
      width: meta.width,
      height: meta.height,
      hasAlpha: meta.hasAlpha,
      channels: meta.hasAlpha ? 4 : 3,
      depth: meta.depth ?? 'uchar',
      space: meta.space ?? 'srgb',
      pages: meta.pages ?? 1,
      // **故意不报 orientation**：原生侧的每一次解码都带 `WithTransform`，
      // 方向已经烘进像素、宽高也已对调。再报一次会让上游又转一遍；而且
      // 上游把"有 orientation"直接算作"携带元数据"，那一项同样是判负项。
      //
      // 方向信息并没有丢：它体现在 width/height 上，也体现在解码结果里。
      ...(meta.carriesMetadata ? { exif: EXIF_PRESENT } : {}),
      // ImageIO 写出的每一张图都带一个 sRGB ICC，没有 API 能不写。
      // 照实报会让**我们自己的编码结果**永远通不过上游的自校验，而这个
      // profile 不含任何用户信息、也不改变"8 位 sRGB"这个事实。
      // 真正该拦的是 EXIF/GPS，那个在 carriesMetadata 里如实报了。
      hasProfile: false,
    }
  }

  async toBuffer(options) {
    if (this._ops.format === 'raw') {
      const result = await call('/image/raw', this._input, {
        maxDim: this._ops.maxDim,
        nearest: this._ops.nearest ? '1' : '0',
      })
      if (result.status !== 200) throw bridgeError(result, '解码原始像素')
      // 宽高与通道数不在字节流里，靠响应头带回来。
      const info = {
        width: Number(result.headers['x-image-width'] ?? 0),
        height: Number(result.headers['x-image-height'] ?? 0),
        channels: Number(result.headers['x-image-channels'] ?? 4),
        size: result.body.length,
      }
      return options?.resolveWithObject ? { data: result.body, info } : result.body
    }

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

/**
 * 未实现的方法要**报出自己的名字**。
 *
 * 不加这层兜底时，缺一个方法的表现是"返回 undefined → 下一步 TypeError →
 * 被上游换成一句与真因无关的错误"。相机功能为此连续失败五次，每次都要
 * 一轮设备往返才定位一个方法。有了它，第一次就知道缺谁。
 */
function wrap(pipeline) {
  return new Proxy(pipeline, {
    get(target, prop, receiver) {
      const existing = Reflect.get(target, prop, receiver)
      if (typeof existing === 'function') {
        // 链式方法返回的仍是 Pipeline，要再包一层，否则代理只护住第一跳。
        return (...args) => {
          const out = existing.apply(target, args)
          return out instanceof Pipeline ? wrap(out) : out
        }
      }
      if (existing !== undefined || typeof prop !== 'string') return existing
      // Promise 解包、console.log 等会探测这些，不能当成"缺方法"。
      if (['then', 'catch', 'finally', 'toJSON', 'constructor'].includes(prop)) return undefined
      if (typeof prop === 'symbol') return undefined
      return () => {
        throw new Error(
          `iOS 的图像桥没有实现 sharp 的 .${prop}()。` +
            '要么在 tools/sharp-bridge/index.cjs 里补上，' +
            '要么确认调用方为什么走到了这条路径。',
        )
      }
    },
  })
}

/**
 * 入口。第二个参数（`{ failOn, limitInputPixels }`）**故意忽略**：
 * 它们是 libvips 的解码策略，ImageIO 没有对应旋钮。
 *
 * **必须接受任意 `Uint8Array`，不能只认 `Buffer`。** 附件服务归一化完会走
 * `encode()` 里的 `data: new Uint8Array(data)`，再把它交给
 * `verifyNormalizedImage` → `detectImage` → `sharp(data)`——那一步传进来的
 * 就是普通 Uint8Array。只认 Buffer 的话，**每一次归一化都在最后一步炸**，
 * 而抛出的还是那句与真因无关的 "Unsupported or malformed image data"。
 */
function sharp(input) {
  if (Buffer.isBuffer(input)) return wrap(new Pipeline(input))
  if (ArrayBuffer.isView(input)) {
    // 用 byteOffset/byteLength 建视图，不复制：input 可能只是一个大 buffer
    // 的一段，整块拷过去既浪费又会把别的字节一起发出去。
    return wrap(new Pipeline(Buffer.from(input.buffer, input.byteOffset, input.byteLength)))
  }
  if (input instanceof ArrayBuffer) return wrap(new Pipeline(Buffer.from(input)))
  throw new Error(
    `iOS 的图像桥只接受字节输入（Buffer / TypedArray / ArrayBuffer），收到的是 ${
      input === null ? 'null' : typeof input
    }`,
  )
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
