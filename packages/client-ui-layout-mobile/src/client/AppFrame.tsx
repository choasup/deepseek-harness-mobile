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

  // **关抽屉要看"当前会话是谁"，不能看 detailsSession。**
  //
  // detailsSession 对**所有空白会话**都是 undefined（那是它的用途：详情面板
  // 没内容可显示）。拿它当依赖，等于"在空白会话之间切换"不算切换——
  // 抽屉不关，用户看到的就是"点了没反应"。
  const currentSession = useSessions((s) => s.current)

  // 切换会话时收起两个覆盖层：留着上一会话的详情是错的内容，
  // 而抽屉在选完会话后就该让路给内容——这也是移动端选完即关的常规行为。
  useEffect(() => {
    actions.closeDetails()
    actions.closeSidebar()
  }, [actions, currentSession])

  /**
   * 抽屉里的操作做完就收起抽屉。
   *
   * **只靠上面那个 effect 是不够的**：点"新建会话"时，如果当前已经是一个空白
   * 会话，dsh 会复用它——实测那一下连建会话的请求都不发，只有一条
   * `subagent.list`。也就是说 `current` 根本没变，任何依赖状态变化的写法都
   * 收不了抽屉。而用户看到的是抽屉盖着屏幕、点多少次都一样，"开不了新会话"。
   *
   * 所以判据换成"用户在抽屉里操作过"，而不是"状态变了"。三类东西不算操作完成：
   *
   * - 被激活的控件**自身**带 `aria-expanded` / `aria-haspopup`：展开收起分组、
   *   搜索开关、菜单触发——用户还在这里翻。
   *
   *   **必须看控件自身，不能从点击点 `closest()` 一路往上找。** "在某工作区里
   *   新建会话"那个按钮就嵌在带 `aria-expanded` 的分组行里，往上找会命中分组、
   *   把它误判成展开操作——正是要修的那个 bug 的另一半。
   * - 输入框：同上。
   * - 这一下**新打开了菜单**：dsh 的行内菜单是 portal 到 body 的
   *   （不在抽屉里），点开之后 DOM 才有 `[role="menu"]`，点击那一刻还看不出来。
   *   所以推到下一个宏任务再判断——React 对离散事件是同步 flush 的，
   *   那时菜单已经在 DOM 里了。
   *
   *   **比的是数量差，不是"现在有没有菜单"。** 早先写成后者，结果是：上一次
   *   操作留下的菜单还开着时，之后每一次点击都被当成"正在开菜单"而不收抽屉。
   *   要判断的是这一下做了什么，不是此刻屏幕上有什么。
   *
   *   **只认菜单，不认对话框。** 对话框是模态的、盖住整屏，抽屉在它后面开着
   *   没有影响；而它出现的时机是异步的（新建会话时那个"添加 API Key"弹窗
   *   就晚一拍），拿它当判据会让"收不收抽屉"变成一场竞态。
   */
  const onDrawerActivate = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      if (target === null) return
      if (target.closest('input, textarea, select, [contenteditable="true"]') !== null) return
      const control = target.closest('button, a, [role="treeitem"], [role="menuitem"]')
      if (control === null) return
      if (control.hasAttribute('aria-expanded') || control.hasAttribute('aria-haspopup')) return
      const openMenus = () => document.querySelectorAll('[role="menu"]').length
      const before = openMenus()
      setTimeout(() => {
        if (openMenus() > before) return
        actions.closeSidebar()
      }, 0)
    },
    [actions],
  )

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
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- 冒泡监听，不是可聚焦控件；键盘路径由抽屉内各控件自己负责 */}
      <div className={cls.drawer} onClick={onDrawerActivate}>
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
