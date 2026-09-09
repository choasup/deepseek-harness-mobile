import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { CapabilitiesEntry } from './CapabilitiesEntry.tsx'
import { installStyles } from './styles.ts'

/**
 * 手机独占能力的入口：输入条上的 ⊕。
 *
 * ## 为什么需要它
 *
 * 重设计要解决的五个问题里，第 5 条是"缺少手机独占能力的入口"。相机和传感器
 * 的**工具早就有了**（`take_photo`、`read_device_sensors`），但界面上没有任何
 * 地方能想到它们——用户得自己想到"我可以让它拍照"并把这句话打出来。
 *
 * ## 为什么用 `conversation.input.left` 而不是接管顶栏
 *
 * 这个坑位是 `kind: list`，dsh 的坑位手册原话是
 * "Entries sit beside that chrome, **never replace it**"——纯附加，不会挤掉
 * 任何既有控件。相比之下 `conversation.session.header` 标着
 * `replaceRisk: shadows-shipped-ui`：占了它就要自己重画标题、视图 Tab
 * （对话/轨迹）和动作行，还会连带吃掉 `header.actions`。设计稿的顶栏里没有
 * 那两个 Tab，照做等于砍掉轨迹视图——那是产品决定，不该夹在一次 UI 重构里
 * 顺手做掉。
 *
 * ## 只列真的能用的
 *
 * 设计稿列了六项（相机 / 相册 / 传感器 / 剪贴板 / 文件 / 语音），但其中四项
 * 背后没有对应的工具。**画一个点了没反应的按钮，比没有这个按钮更糟**，
 * 所以这里只放已经打通的两项，其余等工具落地再加。
 */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() =>
    ctx.slots.inject('conversation.input.left', () =>
      ctx.slots.register(
        {
          name: 'conversation.input.left',
          id: 'dsh-mobile-capabilities',
          // 排在自带控件之后：这是补充入口，不该抢在权限/计划前面。
          order: 200,
          label: '手机能力',
        },
        CapabilitiesEntry,
      ),
    ),
  )
}
