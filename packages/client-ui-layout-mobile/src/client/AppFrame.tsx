import { useCallback, useEffect } from 'react'
import { cls } from './styles.ts'
import type { PanelActions } from './types.ts'

/**
 * 移动端的单栏外框，注册进内置的 `root` slot（web shell 只渲染 root）。
 *
 * 布局：顶栏（菜单键）+ 会话列铺满；侧栏是左侧抽屉，详情是底部 sheet，
 * 两者都用 transform 移出屏幕而不卸载，占位插件的内部状态因此保留。
 *
 * 跟桌面版 AppFrame 一样是**纯组件**：所有输入都从框架的三份 share 来
 * （useStore / useSessions / actions / renderSlot），不 import cordis，
 * 不自造 hook。
 */

interface FrameProps {
  useStore: <T>(selector: (state: { drawer: boolean; details: boolean }) => T) => T
  useSessions: <T>(
    selector: (state: { current?: string; byId: Record<string, { blank: boolean }> }) => T,
  ) => T
  actions: PanelActions
  renderSlot: (name: string, owner: Record<string, unknown>) => React.ReactNode
}

/** 三横线菜单图标。inline SVG——这个包不引任何图标库。 */
function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M3 5.5h14M3 10h14M3 14.5h14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

export function MobileAppFrame({ useStore, useSessions, actions, renderSlot }: FrameProps) {
  const drawer = useStore((s) => s.drawer)
  const details = useStore((s) => s.details)

  // 详情 sheet 只在有"非空白"当前会话时才有内容可显示，与桌面版同一判据。
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })

  // 切换会话时收起两个覆盖层：留着上一会话的详情是错的内容，
  // 而抽屉在选完会话后就该让路给内容——这也是移动端选完即关的常规行为。
  useEffect(() => {
    actions.closeDetails()
    actions.closeSidebar()
  }, [actions, detailsSession])

  const closeAll = useCallback(() => {
    actions.closeSidebar()
    actions.closeDetails()
  }, [actions])

  // 安卓返回键 / iOS 侧滑返回会走 popstate。有覆盖层时先关覆盖层，
  // 而不是让 WebView 退出当前页——移动端对"返回"的期待就是这样。
  useEffect(() => {
    if (!drawer && !details) return
    const onPop = () => closeAll()
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [closeAll, drawer, details])

  const detailsOpen = details && detailsSession !== undefined

  return (
    <div
      className={cls.frame}
      data-drawer={drawer ? 'open' : undefined}
      data-details={detailsOpen ? 'open' : undefined}
    >
      <div className={cls.topbar}>
        <button
          type="button"
          className={cls.menuButton}
          onClick={actions.toggleSidebar}
          aria-label="打开导航"
          aria-expanded={drawer}
        >
          <MenuIcon />
        </button>
      </div>

      <div className={cls.center}>{renderSlot('conversation', {})}</div>

      {/* 点遮罩关闭。抽屉和 sheet 共用一层，同时只会有一个是开的。 */}
      <div className={cls.scrim} onClick={closeAll} aria-hidden="true" />

      {/*
        侧栏占位者（ui-sidebar 的 SidebarRoot）拿到的永远是 collapsed:false。
        它的契约是"collapsed 时渲染紧凑控制条"，而抽屉里要的是完整侧栏——
        关上的时候整个抽屉被 transform 移出屏幕，根本不需要那条控制条。
      */}
      <div className={cls.drawer}>
        {renderSlot('sidebar', { collapsed: false, width: 320 })}
      </div>

      <div className={cls.sheet}>
        <div
          className={cls.sheetGrip}
          onClick={actions.closeDetails}
          role="button"
          tabIndex={0}
          aria-label="收起详情"
        />
        <div className={cls.sheetBody}>{renderSlot('details', {})}</div>
      </div>

      <div className={cls.overlay} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
