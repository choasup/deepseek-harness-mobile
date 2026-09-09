import { describe, expect, it } from 'vitest'

/**
 * `take_photo` 的 `render` —— 也就是**交给模型的那两个块**。
 *
 * ## 为什么单独测它
 *
 * 拍照这条链上栽过五次，第五次是：照片拍了、归一化了、也落盘了，`render` 却只
 * 返回一个 text 块写着 "attachment sha256:…"。模型手上只有一个字符串，
 * 没有任何办法把它变成看得见的图。用户的说法是"拍照完了，但是 dsh 检索不到"。
 *
 * 那一次**所有启动自检都是绿的**——自检跑的是 `execute` 那条路（拍照、归一化、
 * 落盘），而 `render` 是纯函数，根本不在那条路上。当时把它记成了已知缺口。
 * 这个文件就是来补这个缺口的：一个纯函数，值得一个纯函数测试。
 *
 * 这里刻意**不**去 import 插件（那要拉起 cordis 和原生桥），只钉住契约本身。
 */

/** dsh 的 ImageAttachmentRef 要求的字段。少一个就拼不出 image 块。 */
const REQUIRED_REF_FIELDS = ['attachmentId', 'mediaType', 'bytes', 'width', 'height'] as const

interface Block {
  type: string
  text?: string
  attachment?: Record<string, unknown>
}

/**
 * 从构建产物里取出 render。
 *
 * 走 lib 而不是 src：要钉的是**真正装进设备的那份**。tsdown 的转换若哪天动了
 * 手脚，从 src 测是看不出来的。
 */
async function loadRender(): Promise<(args: unknown, value: unknown) => Block[]> {
  // **环境变量必须在 import 之前设。** 插件在模块顶层读
  // `const BRIDGE = process.env.DSH_NATIVE_BRIDGE`，没有它就走"不注册工具"
  // 那条分支——那是有意的设计（宁可没有这个工具，也不要一个必然报错的），
  // 但也意味着这里顺序反了就什么都测不到。第一版就栽在这儿。
  process.env.DSH_NATIVE_BRIDGE ??= 'http://127.0.0.1:1'
  const module = (await import('../../lib/plugin.js')) as unknown as {
    apply(ctx: unknown): void
  }
  const registered: { output?: { render(args: unknown, value: unknown): Block[] } }[] = []
  module.apply({
    logger: { info: () => {} },
    effect: (fn: () => void) => fn(),
    tools: { register: (tool: unknown) => registered.push(tool as never) },
  })
  const render = registered[0]?.output?.render
  if (render === undefined) throw new Error('take_photo 没注册，或者它没有 output.render')
  return render
}

const captured = {
  cancelled: false,
  image: {
    attachmentId: `sha256:${'a'.repeat(64)}`,
    mediaType: 'image/jpeg',
    bytes: 44_321,
    width: 1568,
    height: 1176,
  },
}

describe('take_photo 交给模型的内容', () => {
  it('拍成功时给出 image 块，而不是只报一个 attachment id', async () => {
    const render = await loadRender()
    const blocks = render({}, captured)

    const image = blocks.find((block) => block.type === 'image')
    expect(image, '没有 image 块——模型拿不到图，只会看到一串 id').toBeDefined()
    for (const field of REQUIRED_REF_FIELDS) {
      expect(image?.attachment?.[field], `image 块缺 ${field}`).toBeDefined()
    }
    expect(image?.attachment?.attachmentId).toBe(captured.image.attachmentId)
    expect(image?.attachment?.bytes).toBe(captured.image.bytes)
  })

  it('同时给一段文字信封，说明这是相机拍的', async () => {
    const render = await loadRender()
    const blocks = render({}, captured)
    const text = blocks.find((block) => block.type === 'text')
    expect(text?.text).toMatch(/1568x1176/u)
    expect(text?.text).toMatch(/camera/iu)
  })

  it('用户取消时只给文字，并且明说不要重试', async () => {
    const render = await loadRender()
    const blocks = render({}, { cancelled: true })
    expect(blocks.every((block) => block.type === 'text')).toBe(true)
    expect(blocks[0]?.text).toMatch(/cancelled/iu)
    // 取消不是故障。不说清楚的话模型会当成失败去重试，反复骚扰用户。
    expect(blocks[0]?.text).toMatch(/do not retry/iu)
  })
})
