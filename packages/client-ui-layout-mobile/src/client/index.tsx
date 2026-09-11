import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { MobileAppFrame } from './AppFrame.tsx'
import { MobileLayoutController } from './service.ts'
import { createMobileLayoutStore } from './store.ts'
import { installStyles } from './styles.ts'
import { ThemePresenter } from './theme-presenter.ts'

export { MobileLayoutController }
export type { ILayout } from './types.ts'

/** cordis fiber inject——与 dsh 自己的 layout 插件一致。 */
export const inject = ['slots', 'theme', 'sessions']

/**
 * 浏览器半边。形状照抄 `dsh-client-ui-layout`：provide `ctx.layout`，
 * 一次 `register()` 把外框放进 `root` 并**声明**四个子 slot，外加主题投影。
 *
 * "声明"等于独占渲染权：这四个名字必须跟桌面版一字不差，否则其余 32 个
 * UI 插件注册进来的东西会落不到位——它们注册的目标是 slot 名，不是某个包。
 */
export function apply(ctx: ClientContext): void {
  installStyles()
  installNativeBridge(ctx)
  const layout = new MobileLayoutController()

  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register(
      {
        name: 'root',
        children: {
          sidebar: { kind: 'single', scope: 'root' },
          // 「环境」Tab 的坑位：机器、探针、GitHub 仓库都落在这里。
          // 声明在这一层而不是插件里，是因为**声明等于独占渲染权**——
          // 外框要先把这一格留出来，占位者才有地方注册。
          env: { kind: 'single', scope: 'root' },
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

/**
 * 「原生 → 网页」的通道。
 *
 * ## 为什么需要它
 *
 * 外壳正在原生化：会话列表先用 SwiftUI 重做，WebView 只留对话。但点了原生
 * 列表里的一行之后，得让 WebView 切到那个会话——而 **dsh 的前端没有基于 URL
 * 的路由**，导航全在应用内走 `ctx.sessions.open(id)`。查过 apps/web 与
 * client/runtime，没有任何读 location.search / hash 的路由代码。
 *
 * 所以原生侧只能调进来。反方向（console 转发到 host 日志）今天已经建好，
 * 这是补上的另一半。
 *
 * ## 为什么挂在 window 上
 *
 * `evaluateJavaScript` 只能执行一段脚本字符串，够得着的只有全局对象。
 * 挂一个带命名空间的入口，比让原生侧去猜内部变量名稳得多。
 */
function installNativeBridge(ctx: ClientContext): void {
  if (typeof window === 'undefined') return
  const target = window as unknown as {
    __dshMobile?: {
      openSession(id: string): boolean
      listSessions(): { id: string; blank: boolean }[]
    }
  }
  target.__dshMobile = {
    /**
     * 切到某个会话。
     * @returns 是否真的切了——id 不在列表里时返回 false 而不是静默无视，
     *   否则原生侧会以为切成功了、切走界面，用户看到的是上一个会话。
     */
    openSession(id: string): boolean {
      const known = ctx.sessions.list.getSnapshot().ids.includes(id as never)
      if (!known) return false
      ctx.sessions.open(id as never)
      return true
    },
    /** 供原生侧对账用：网页这边认得哪些会话。 */
    listSessions() {
      const snapshot = ctx.sessions.list.getSnapshot()
      return snapshot.ids.map((id) => ({
        id: String(id),
        blank: snapshot.byId[id]?.blank === true,
      }))
    },
  }
}