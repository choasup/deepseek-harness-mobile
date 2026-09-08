/**
 * Mac 上的假原生桥：用真的 sharp 顶替 iOS 的 ImageIO，把 `ios/DshMobile/ImageOps.swift`
 * 的四条路由在本机复现出来。
 *
 * ## 这东西解决的是"每验证一次要一趟真机"
 *
 * `tools/sharp-bridge/index.cjs` 是 sharp 在 iOS 上的替身，而它对不对，
 * 此前只能靠"部署 → 拍照 → 看报错"来验——而附件服务把所有图像错误都换成
 * 同一句 "Unsupported or malformed image data"，于是每个问题都要一轮真机往返。
 * 相机功能为此失败了六次，每次只定位到一个点。
 *
 * 有了这个，`tools/verify-sharp-bridge.mjs` 能在 Mac 上把附件服务的**真实入口**
 * 完整跑一遍，桥的 API 面、元数据契约、Uint8Array/Buffer 之类的输入类型问题
 * 全都当场暴露。
 *
 * ## 它不能替代真机
 *
 * 这里模拟的是 ImageOps 的**语义**，不是 ImageIO 本身。ImageIO 独有的行为
 * （写出来的图自带 sRGB profile、缩略图的取整、WebP 只能读不能写）验不了。
 * 它保证的是"桥与 dsh 的接口对得上"，不保证"原生实现对得上"。
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 真的 sharp。仓库自己不装它（原生模块、40MB，只为这个本地校验不值当），
 * 从已装好的 dsh 里借一份。
 */
const sharp = await (async () => {
  const require = createRequire(import.meta.url)
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    'sharp',
    resolve(here, '../node_modules/sharp'),
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp',
  ]
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate)
      return loaded.default ?? loaded
    } catch {}
  }
  throw new Error(
    '找不到真的 sharp。这个假桥要用它来复现 ImageIO 的语义；' +
      '装一个 dsh（npm i -g @deepseek-ai/dsh）或在仓库里装 sharp 即可。',
  )
})()

/** 与 ImageOps.shortFormat 一致：只认这几种。 */
const UTI = {
  jpeg: 'public.jpeg',
  png: 'public.png',
  webp: 'org.webmproject.webp',
  gif: 'com.compuserve.gif',
  heif: 'public.heic',
}

async function metadata(body) {
  const meta = await sharp(body).metadata()
  const orientation = meta.orientation ?? 1
  const swapped = orientation >= 5
  return {
    format: meta.format,
    uti: UTI[meta.format] ?? '',
    width: swapped ? meta.height : meta.width,
    height: swapped ? meta.width : meta.height,
    orientation,
    hasAlpha: meta.hasAlpha === true,
    depth: meta.depth === 'ushort' ? 'ushort' : 'uchar',
    space: meta.space ?? 'srgb',
    pages: meta.pages ?? 1,
    // ImageOps 判的是"有没有实质标签"，不是"有没有 Exif 字典"。sharp 只在
    // 真有 EXIF 时才给 exif，语义正好对上。
    carriesMetadata:
      meta.exif !== undefined || meta.iptc !== undefined || meta.xmp !== undefined,
  }
}

/** 与 ImageOps.normalize 一致：长边封顶、烘方向、转 sRGB、丢元数据。 */
async function normalize(body, maxDim, quality, format) {
  let pipeline = sharp(body).rotate()
  if (maxDim > 0) {
    pipeline = pipeline.resize({
      width: maxDim,
      height: maxDim,
      fit: 'inside',
      withoutEnlargement: true,
    })
  }
  pipeline = pipeline.toColourspace('srgb')
  const q = Math.round(quality * 100)
  if (format === 'png') return pipeline.png({ compressionLevel: 9 }).toBuffer()
  if (format === 'webp') return pipeline.webp({ quality: q }).toBuffer()
  return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: q }).toBuffer()
}

/** 与 ImageOps.raw 一致：RGBA8，宽高与通道数走响应头，最近邻可选。 */
async function raw(body, maxDim, nearest) {
  let pipeline = sharp(body).rotate()
  if (maxDim > 0) {
    pipeline = pipeline.resize({
      width: maxDim,
      height: maxDim,
      fit: 'inside',
      withoutEnlargement: true,
      ...(nearest ? { kernel: 'nearest', fastShrinkOnLoad: false } : {}),
    })
  }
  return pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}

export function startFakeBridge() {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url, 'http://127.0.0.1')
      const query = url.searchParams
      try {
        if (url.pathname === '/image/capabilities') {
          // 真机上 WebP 由随包的 libwebp 提供，所以这里也报 true。
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ webp: true, imageIODestinationTypes: [] }))
          return
        }
        if (url.pathname === '/image/metadata') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(await metadata(body)))
          return
        }
        if (url.pathname === '/image/normalize') {
          const format = query.get('format') ?? 'jpeg'
          const out = await normalize(
            body,
            Number(query.get('maxDim') ?? 0),
            Number(query.get('quality') ?? 0.8),
            format,
          )
          res.writeHead(200, { 'content-type': `image/${format}` })
          res.end(out)
          return
        }
        if (url.pathname === '/image/raw') {
          const { data, info } = await raw(
            body,
            Number(query.get('maxDim') ?? 0),
            query.get('nearest') === '1',
          )
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'x-image-width': String(info.width),
            'x-image-height': String(info.height),
            'x-image-channels': String(info.channels),
          })
          res.end(data)
          return
        }
        res.writeHead(404).end(`no route: ${url.pathname}`)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}
