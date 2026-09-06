import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { MobileAppFrame } from './AppFrame.tsx'
import { MobileLayoutController } from './service.ts'
import { createMobileLayoutStore } from './store.ts'
import { installStyles } from './styles.ts'
import { ThemePresenter } from './theme-presenter.ts'

export { MobileLayoutController }
export type { ILayout } from './types.ts'

/** cordis fiber inject——与 dsh 自己的 layout 插件一致。 */
export const inject = ['slots', 'theme']

/**
 * 浏览器半边。形状照抄 `dsh-client-ui-layout`：provide `ctx.layout`，
 * 一次 `register()` 把外框放进 `root` 并**声明**四个子 slot，外加主题投影。
 *
 * "声明"等于独占渲染权：这四个名字必须跟桌面版一字不差，否则其余 32 个
 * UI 插件注册进来的东西会落不到位——它们注册的目标是 slot 名，不是某个包。
 */
export function apply(ctx: ClientContext): void {
  installStyles()
  const layout = new MobileLayoutController()

  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register(
      {
        name: 'root',
        children: {
          sidebar: { kind: 'single', scope: 'root' },
          conversation: { kind: 'single', scope: 'session-maybe' },
          details: { kind: 'single', scope: 'session' },
          'shell.overlay': { kind: 'list', scope: 'root' },
        },
        store: createMobileLayoutStore,
        inject: (actions) => {
          layout.attachPanels(actions)
          return {}
        },
      },
      MobileAppFrame,
    )
    return () => {
      disposeRegistration()
      disposeService()
    }
  }, 'ui-layout-mobile: service + root registration')

  // 主题投影。换掉 layout 就得连这个一起接管，否则设计令牌变量没人写，
  // 整个界面（不只是这个包）全部掉成无样式——见 theme-presenter.ts 的说明。
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => {
      presenter.apply(snapshot)
    })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-layout-mobile: theme presenter')
}
