import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// AttachmentId 是**运行时**导入：要把 image 块交给模型，就得给它一个合法的
// ImageAttachmentRef，而 attachmentId 是个带品牌的类型。dsh 自己的 read_image
// 走的也是这条路（dsh-tool-fs 的 imageRefFromValue）。
// 顺带这个 import 也带来了 ctx.attachments 的类型扩展。
import { AttachmentId } from '@deepseek-ai/dsh-attachment'

/**
 * `take_photo`：让模型请求用设备的相机拍一张照片。
 *
 * 这是「手机是大脑和感官」里**感官**那一半——摄像头是这个形态最强的输入，
 * 也是它相对桌面 harness 唯一无法被替代的能力。
 *
 * ## 边界：模型只能"请求"，按快门是人的事
 *
 * 工具调用会调起系统相机界面，用户可以取消。取消**不是错误**——
 * 返回一个明确的 `cancelled` 结果给模型，让它据此改变计划，
 * 而不是抛错让它重试（重试只会反复骚扰用户）。
 *
 * ## 为什么需要原生桥
 *
 * 拍照与图像归一化都在原生侧完成（`CameraBridge` + `ImageOps`）：
 * iOS 上没有可用的 sharp，而手机本来就有更合适的 ImageIO——降采样解码，
 * 不会把 4800 万像素解进内存。Node 这边只负责把字节交给附件服务。
 */
export const inject = ['tools', 'attachments']

/** 桥的地址由原生侧通过环境变量给出；没有它就说明这一版没带原生桥。 */
const BRIDGE = process.env.DSH_NATIVE_BRIDGE

export function apply(ctx: Context): void {
  // 没有桥就**不注册**这个工具，而不是注册一个必然失败的。
  // 模型的工具目录里出现一个每次都报错的工具，比没有这个工具更糟。
  if (BRIDGE === undefined) {
    ctx.logger?.info?.('tool-camera: 未设置 DSH_NATIVE_BRIDGE，跳过 take_photo 注册')
    return
  }

  const tool = defineTool({
    name: 'take_photo',
    description:
      'Ask the user to take a photo with the device camera and return the image. ' +
      'The system camera UI is shown and the user may cancel; a cancelled capture ' +
      'reports cancelled: true rather than failing. Use this when seeing the ' +
      "user's physical surroundings would answer the question.",
    parameters: {
      reason: {
        type: 'string',
        description: "Shown to the user to explain why a photo is being requested.",
      },
    },
    output: {
      // additionalProperties 必须**显式**给 true/false——dsh 的校验器不接受
      // 省略（JsonSchemaError: must be explicitly true or false）。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cancelled: { type: 'boolean', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              // bytes 不是可有可无的：ImageAttachmentRef 要求它，
              // 少了它就拼不出交给模型的 image 块。
              bytes: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
            },
          },
        },
      },
      /**
       * 交给模型的内容。
       *
       * **必须返回 image 块，不能只报一个 attachment id。** 早先这里只有一个
       * text 块，写着 "attachment sha256:…"——照片确实拍了、也确实入库了，
       * 但模型手上只有一个字符串，没有任何办法把它变成看得见的图。
       * 用户的说法是"拍照完了，但是 dsh 检索不到"。
       *
       * dsh 自己的 read_image 就是返回两块：一段文字信封 + 一个 image 块
       * （dsh-tool-fs 的 imageReadContent）。这里照同一个约定。
       *
       * 取消时说清楚是**用户主动取消**，不是失败——否则模型会把它当故障
       * 去重试，反复骚扰用户。
       */
      render: (_args: unknown, value: CaptureResult) => {
        if (value.cancelled || value.image === undefined) {
          return [
            {
              type: 'text' as const,
              text: 'The user cancelled the photo capture. Do not retry unless they ask.',
            },
          ]
        }
        const image = value.image
        return [
          {
            type: 'text' as const,
            text: `Photo captured with the device camera: ${image.width}x${image.height} ${image.mediaType}.`,
          },
          {
            type: 'image' as const,
            attachment: {
              attachmentId: AttachmentId(image.attachmentId),
              mediaType: image.mediaType as never,
              bytes: image.bytes,
              width: image.width,
              height: image.height,
            },
          },
        ]
      },
    },
    async execute(args: { reason?: string }): Promise<CaptureResult> {
      void args
      try {
        return await capture()
      } catch (error) {
        // 失败原因要落进 host 日志：否则它只出现在模型的对话里，
        // 而排查的人在另一头，看不到。
        //
        // **必须把 cause 链摊开。** 附件服务把任何图像问题都换成同一句
        // "Unsupported or malformed image data"，真因原封不动塞进 `cause`
        // 且从不显示。只打 message 等于什么都没打——这一点让相机的排查
        // 白白多花了好几轮设备往返。
        console.log(`[take_photo] 失败: ${describeError(error)}`)
        throw error
      }
    },
    presentCall(args: { reason?: string }) {
      return {
        card: 'generic' as const,
        title: args.reason ? `拍照：${args.reason}` : '请求拍照',
        kind: 'read' as const,
      }
    },
  })

  async function capture(): Promise<CaptureResult> {
      const response = await fetch(`${BRIDGE}/camera/capture`, { method: 'POST' })

      // 409 = 用户取消。这是正当结果，不是失败。
      if (response.status === 409) return { cancelled: true }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`拍照失败（HTTP ${response.status}）：${detail.slice(0, 200)}`)
      }

      const data = Buffer.from(await response.arrayBuffer())
      // 原生侧已经归一化成 JPEG，这里只是入库并拿到模型可引用的 id。
      const ref = await attachments(ctx).saveImage({
        data,
        mediaType: 'image/jpeg',
        name: `photo-${new Date().toISOString().replace(/[:.]/gu, '-')}.jpg`,
      })
      return {
        cancelled: false,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        },
      }
  }

  ctx.effect(() => ctx.tools.register(tool))
}

interface CaptureResult {
  cancelled: boolean
  image?: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
  }
}

/**
 * `ctx.attachments` 的最小面。手写而不是从 dsh-attachment 导入，是因为那边的
 * 类型挂在 cordis 的服务扩展上，这个包只用得到一个方法。
 *
 * **字段要和 ImageAttachmentRef 对齐**：少写一个 `bytes`，代价不是类型不严谨，
 * 而是拼不出交给模型的 image 块——照片存进去了、模型却看不见。
 */
interface Attachments {
  saveImage(input: { data: Buffer; mediaType: string; name?: string }): Promise<{
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
  }>
}

/** ctx.attachments 的类型在 dsh-attachment 里，运行时由宿主提供。 */
function attachments(ctx: Context): Attachments {
  return (ctx as unknown as { attachments: Attachments }).attachments
}

/** 把 error.cause 链摊平成一行。真因常在第二、三层。 */
function describeError(error: unknown): string {
  const parts: string[] = []
  let current = error as { name?: string; message?: string; cause?: unknown } | undefined
  for (let depth = 0; depth < 6 && current; depth += 1) {
    parts.push(`${current.name ?? 'Error'}: ${current.message ?? String(current)}`)
    current = current.cause as typeof current
  }
  return parts.join(' ← ')
}
