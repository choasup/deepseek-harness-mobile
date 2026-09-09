import { useCallback, useEffect, useRef, useState } from 'react'
import { cls } from './styles.ts'
import type { MobileTab } from './store.ts'
import type { PanelActions } from './types.ts'

/**
 * 移动端外框，注册进内置的 `root` slot（web shell 只渲染 root）。
 *
 * ## 导航模型：底部 Tab 栏，不是侧边抽屉
 *
 * 旧版把桌面的三栏压成"单栏 + 左侧抽屉"，关键操作全在屏幕顶部——重设计要
 * 解决的五个问题里，"单手可达性差"和"桌面组件硬塞进手机"都指向这里。
 * 现在导航在**底部**：会话 / 环境两个 Tab，拇指够得到。
 *
 * **进入某个会话时 Tab 栏整体退出**（下移 + 淡出），顶栏换成返回键——
 * 会话页的底部要留给输入条，两者不能同时占着。这也是 iOS 上"列表 → 详情"
 * 的常规形态。
 *
 * ## 仍然是纯组件
 *
 * 所有输入都从框架的三份 share 来（useStore / useSessions / actions /
 * renderSlot），不 import cordis、不自造 hook——与桌面版 AppFrame 同一约定。
 */

interface FrameProps {
  useStore: <T>(
    selector: (state: { tab: MobileTab; details: boolean; view: 'list' | 'conversation' }) => T,
  ) => T
  useSessions: <T>(
    selector: (state: { current?: string; byId: Record<string, { blank: boolean }> }) => T,
  ) => T
  actions: PanelActions
  renderSlot: (name: string, owner: Record<string, unknown>) => React.ReactNode
}

/** 会话 Tab 图标。inline SVG——这个包不引任何图标库。 */
function SessionsIcon() {
  return (
    <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 6.5h16M4 12h16M4 17.5h10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

/** 环境 Tab 图标：一台机器。 */
function EnvIcon() {
  return (
    <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect
        x="3.2"
        y="5"
        width="17.6"
        height="10.5"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
      />
      <path d="M8 19h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12 15.5V19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** 返回键。 */
function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M15 4.5 7.5 12l7.5 7.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

const TABS: { id: MobileTab; label: string; icon: () => React.ReactElement }[] = [
  { id: 'sessions', label: '会话', icon: SessionsIcon },
  { id: 'env', label: '环境', icon: EnvIcon },
]

export function MobileAppFrame({ useStore, useSessions, actions, renderSlot }: FrameProps) {
  const tab = useStore((s) => s.tab)
  const details = useStore((s) => s.details)
  const view = useStore((s) => s.view)

  const currentSession = useSessions((s) => s.current)
  // 详情 sheet 只在有"非空白"当前会话时才有内容可显示，与桌面版同一判据。
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })

  const inConversation = view === 'conversation'

  // 用户**选中一个会话**时进入会话页——判据是"current 变了"，不是"current 有值"。
  // 后者会让返回键失效：返回不该清除当前会话，而会话一直有值。
  // 首次挂载不算：dsh 启动时会自动选一个会话，那不是用户的导航动作。
  const previousSession = useRef<string | undefined>(undefined)
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      previousSession.current = currentSession
      return
    }
    if (currentSession === previousSession.current) return
    previousSession.current = currentSession
    actions.closeDetails()
    if (currentSession !== undefined) actions.openConversation()
  }, [actions, currentSession])

  const closeSheet = useCallback(() => {
    actions.closeDetails()
  }, [actions])

  // 安卓返回键 / iOS 侧滑返回会走 popstate。有 sheet 时先关 sheet，
  // 而不是让 WebView 退出当前页——移动端对"返回"的期待就是这样。
  useEffect(() => {
    if (!details) return
    const onPop = () => closeSheet()
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [closeSheet, details])

  const detailsOpen = details && detailsSession !== undefined

  return (
    <div
      className={cls.frame}
      data-details={detailsOpen ? 'open' : undefined}
      data-conversation={inConversation ? 'open' : undefined}
    >
      <div className={cls.topbar}>
        {inConversation ? (
          <button
            type="button"
            className={cls.backButton}
            onClick={actions.backToList}
            aria-label="返回"
          >
            <BackIcon />
          </button>
        ) : (
          <span className={cls.pageTitle}>{tab === 'sessions' ? '会话' : '环境'}</span>
        )}
      </div>

      {/*
        会话页与 Tab 页共存于同一棵树、用显示与否切换，而不是卸载重建：
        占位插件（ui-sidebar、ui-conversation）的内部状态因此在来回切换之间
        保留，跟桌面版"width 0 但子树仍挂载"是同一个约定。
      */}
      <div className={cls.center} hidden={!inConversation}>
        {renderSlot('conversation', {})}
      </div>

      <div className={cls.tabPage} hidden={inConversation || tab !== 'sessions'}>
        {renderSlot('sidebar', { collapsed: false, width: 320 })}
      </div>

      <div className={cls.tabPage} hidden={inConversation || tab !== 'env'}>
        {renderSlot('env', {})}
      </div>

      {/* 会话内页不显示 Tab 栏——底部要留给输入条。 */}
      <nav className={cls.tabbar} hidden={inConversation} aria-label="主导航">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={cls.tabItem}
            data-active={tab === id ? 'true' : undefined}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => actions.selectTab(id)}
          >
            <Icon />
            <span className={cls.tabLabel}>{label}</span>
          </button>
        ))}
      </nav>

      <div className={cls.scrim} onClick={closeSheet} aria-hidden="true" />
      <DetailsSheet open={detailsOpen} onClose={closeSheet}>
        {renderSlot('details', {})}
      </DetailsSheet>

      <div className={cls.overlay} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}

/**
 * 底部详情 sheet，**支持下拉关闭**。
 *
 * 下拉手势是重设计点名要补的：只能点抓手关闭是现状的已知缺陷，而在手机上
 * 「往下甩」是关闭底部面板的默认预期，没有它就得去够那个小抓手。
 *
 * 用 pointer 事件而不是 touch：同一套代码在带触控的桌面浏览器上也能测，
 * 而调试正是在那儿做的。
 */
function DetailsSheet({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  const [drag, setDrag] = useState(0)
  const start = useRef<number | undefined>(undefined)

  // 关上之后要把位移清零，否则下次打开会带着上次的偏移弹出来。
  useEffect(() => {
    if (!open) setDrag(0)
  }, [open])

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    start.current = event.clientY
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (start.current === undefined) return
    // 只跟随向下的位移：往上拖不该把 sheet 拉高，那会露出底下的内容。
    setDrag(Math.max(0, event.clientY - start.current))
  }, [])

  const onPointerUp = useCallback(() => {
    if (start.current === undefined) return
    start.current = undefined
    // 阈值取 88px：比误触大得多，又比"必须甩到底"轻松。低于它就弹回去。
    setDrag((value) => {
      if (value > 88) onClose()
      return 0
    })
  }, [onClose])

  return (
    <div
      className={cls.sheet}
      style={drag > 0 ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}
    >
      <div
        className={cls.sheetGrip}
        onClick={onClose}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="button"
        tabIndex={0}
        aria-label="收起详情"
      />
      <div className={cls.sheetBody}>{children}</div>
    </div>
  )
}
