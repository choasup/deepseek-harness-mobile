/**
 * 启动自检：把 dsh 附件服务的**真实归一化链路**在设备上跑一遍。
 *
 * ## 为什么不是"挨个测桥的方法"
 *
 * 前几版自检测的是 `metadata()` / `normalize()` / `raw()` / `toColourspace()`
 * ——都是"我想到的方法"。每漏一个就是一轮"用户拍照 → 报错 → 加一个方法 →
 * 重新部署"，而报错永远是同一句与真因无关的
 * "Unsupported or malformed image data"（真因被塞进 `cause`，没人显示）。
 *
 * 最后一次漏的不是方法，是**契约**：`verifyNormalizedImage` 会把刚编码出来的
 * 字节重新解码，逐项比对 media type、宽、高、`depth === "uchar"`、
 * `space === "srgb"`、单帧、"不携带元数据"。桥少报 `depth`/`space`，
 * `undefined !== "uchar"` 恒成立，于是**每一张图**都在最后一步被判负——
 * 而按方法逐个测，永远测不出来。
 *
 * 所以这一版不再自己拼调用链，直接调 `prepareImageFile`：那是相机与上传
 * 走的同一个入口，它过了就是真的过了。
 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * 合成一张 PNG。
 *
 * 自检需要**真实尺寸、真实颜色数**的图：1×1 的 PNG 走不到降采样、走不到
 * "颜色数是否够少"的分支，也就测不出这些分支上的问题。设备上没有现成素材，
 * 所以现场合成——用 zlib 就够了，不必把素材塞进 bundle。
 *
 * @param {(x: number, y: number) => number[]} pixel 返回 [r,g,b] 或 [r,g,b,a]
 */
function makePng(width, height, alpha, pixel) {
  const channels = alpha ? 4 : 3
  const raw = Buffer.alloc(height * (1 + width * channels))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // filter: none
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const value = pixel(x, y)
      for (let c = 0; c < channels; c += 1) raw[offset + c] = value[c] ?? 255
      offset += channels
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = alpha ? 6 : 2 // colour type: RGBA / RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 伪随机但可复现：同一台设备上两次启动测的是同一张图。 */
function noise(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state >>> 24
  }
}

/**
 * 自检用的四张图，**按 dsh 的编码分支挑的**，不是随手画的：
 * `encodingAttemptsAtSize` 依"颜色数是否 ≤256"和"有没有透明通道"分出三条
 * 互不相同的编码路径（JPEG / PNG优先 / 只有 WebP），三条都得走到。
 */
function samples() {
  const rnd = noise(20260908)
  // 尺寸刻意超过归一化的长边上限（2048），否则 `canPassThroughNormalization`
  // 会让这几张图**原样直通**——一行编码代码都不会执行，自检就成了摆设。
  // 高度压到 200：要走到的是分支，不是像素数；启动时多解一张 4K 图没有意义。
  const W = 2100
  const H = 200
  return [
    {
      name: '照片式 RGB（→ JPEG）',
      data: makePng(W, H, false, () => [rnd(), rnd(), rnd()]),
      mediaType: 'image/png',
      expect: 'image/jpeg',
    },
    {
      // 四块纯色。刻意做得**毫不含糊**：重采样在边界上会掺出中间色，
      // 用渐变或细条纹的话"颜色数是否 ≤256"就成了掷硬币，自检会时绿时红。
      name: '少色 RGB（→ PNG）',
      data: makePng(W, H, false, (x, y) => {
        const quadrant = (x < W / 2 ? 0 : 1) + (y < H / 2 ? 0 : 2)
        return [[220, 30, 30], [30, 200, 90], [40, 90, 230], [250, 240, 60]][quadrant]
      }),
      mediaType: 'image/png',
      expect: 'image/png',
    },
    {
      name: '少色带透明（→ PNG）',
      data: makePng(W, H, true, (x, y) => [255, 128, 0, x + y > 300 ? 0 : 255]),
      mediaType: 'image/png',
      expect: 'image/png',
    },
    {
      // 带透明通道又不是少色 —— dsh 对这一类**只提供 WebP 一条编码路径**
      // （`if (hasAlpha) return webp`，没有 png/jpeg 的退路）。
      // iOS 的 ImageIO 写不了 WebP，这一条走的是随包的 libwebp。
      name: '照片式带透明（→ WebP）',
      data: makePng(W, H, true, (x) => [rnd(), rnd(), rnd(), x < 1000 ? 200 : 255]),
      mediaType: 'image/png',
      expect: 'image/webp',
      needsWebP: true,
    },
  ]
}

/** 把 error.cause 链摊平。真因常常在第二、三层，只看 message 等于什么也没看到。 */
export function describeError(error) {
  const parts = []
  let current = error
  for (let depth = 0; depth < 6 && current; depth += 1) {
    parts.push(`${current.name ?? 'Error'}: ${current.message ?? String(current)}`)
    current = current.cause
  }
  return parts.join(' ← ')
}

/**
 * 跑一遍附件归一化自检。
 * @param log 记日志的函数（设备上写进 dsh-host.log）。
 * @returns 是否全部通过（WebP 缺失导致的那一条按"已知缺口"单独计）。
 */
export async function runAttachmentSelfTest(log) {
  // 路径可覆盖：Mac 上用真的 sharp 跑同一套自检，确认"自检本身是对的"
  // ——否则自检绿了也只能说明桥和自检一起错。
  const store = await import(
    process.env.DSH_SELFTEST_ATTACHMENT ??
      './node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js'
  )
  const limits = {
    maxImageBytes: store.DEFAULT_MAX_IMAGE_BYTES,
    maxImagePixels: store.DEFAULT_MAX_IMAGE_PIXELS,
    maxImageDimension: store.DEFAULT_MAX_IMAGE_DIMENSION,
  }
  const policy = {
    maxBytes: store.DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
    maxDimension: store.DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  }

  let webp = false
  try {
    const http = await import('node:http')
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        new URL('/image/capabilities', process.env.DSH_NATIVE_BRIDGE),
        { method: 'POST', headers: { 'content-length': 0 } },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        },
      )
      req.on('error', reject)
      req.end()
    })
    webp = JSON.parse(body).webp === true
    log(`[bridge-selftest] 原生可写格式：webp=${webp}`)
  } catch (error) {
    log(`[bridge-selftest] 能力探测失败: ${describeError(error)}`)
  }

  let failures = 0
  for (const sample of samples()) {
    try {
      const prepared = await store.prepareImageFile(
        { data: sample.data, mediaType: sample.mediaType, name: 'selftest.png' },
        limits,
        policy,
      )
      const ref = prepared.ref
      const shape = `${ref.mediaType} ${ref.width}×${ref.height} ${ref.bytes} 字节`
      if (ref.mediaType !== sample.expect) {
        // 编码格式选错不会报错，只会悄悄变差：照片被当成截图存成 PNG，
        // 体积能翻四倍。所以这里当失败处理——它正是"看不见的退化"。
        failures += 1
        log(`[bridge-selftest] ${sample.name} 分类错了：得到 ${shape}`)
        continue
      }
      log(`[bridge-selftest] ${sample.name} ok → ${shape}`)
    } catch (error) {
      if (sample.needsWebP && !webp) {
        // 已知缺口，不算回归：这条路径只有 WebP 一种编码，而这台设备的
        // ImageIO 写不了 WebP。把它单独标出来，免得混进"全部通过"里。
        log(`[bridge-selftest] ${sample.name} 跳过（原生不支持 WebP 编码）`)
        continue
      }
      failures += 1
      log(`[bridge-selftest] ${sample.name} 失败: ${describeError(error)}`)
    }
  }
  return failures === 0
}
