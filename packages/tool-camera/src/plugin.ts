import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// 类型侧的服务扩展：不显式 import 就拿不到 ctx.attachments 的类型。
// 运行时不产生任何导入（类型导入会被擦除）。
import type {} from '@deepseek-ai/dsh-attachment'

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

  ctx.plugin(
    defineTool((toolCtx: Context) => ({
      name: 'take_photo',
      description:
        'Ask the user to take a photo with the device camera and return the image. ' +
        'The system camera UI is shown and the user may cancel; a cancelled capture ' +
        'returns { cancelled: true } rather than an error. Use this when seeing the ' +
        "user's physical surroundings would answer the question.",
      parameters: {
        reason: {
          type: 'string',
          required: false,
          description: 'Shown to the user to explain why a photo is being requested.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cancelled: { type: 'boolean' },
            image: {
              type: 'object',
              properties: {
                attachmentId: { type: 'string' },
                mediaType: { type: 'string' },
                width: { type: 'number' },
                height: { type: 'number' },
              },
            },
          },
        },
      },
      async handler() {
        const response = await fetch(`${BRIDGE}/camera/capture`, { method: 'POST' })

        // 409 = 用户取消。这是正当结果，不是失败。
        if (response.status === 409) return { cancelled: true }
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error(`拍照失败（HTTP ${response.status}）：${detail.slice(0, 200)}`)
        }

        const data = Buffer.from(await response.arrayBuffer())
        const attachments = (toolCtx as unknown as { attachments: {
          saveImage(input: { data: Buffer; mediaType: string; name?: string }): Promise<{
            attachmentId: string
            mediaType: string
            bytes: number
            width: number
            height: number
          }>
        } }).attachments

        // 原生侧已经归一化成 JPEG，这里只是入库并拿到模型可引用的 id。
        const ref = await attachments.saveImage({
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
      },
      presentCall(args: { reason?: string }) {
        return {
          card: 'generic',
          title: args.reason ? `拍照：${args.reason}` : '请求拍照',
          kind: 'read',
        }
      },
    })),
  )
}
