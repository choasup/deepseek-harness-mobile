import type { ReactNode } from 'react'
import { cls } from './styles.ts'

/**
 * 手机版的 `sidebar` 占位者，顶替 dsh 自带的 `SidebarRoot`。
 *
 * ## 为什么必须换掉而不是调样式
 *
 * 自带的那个是**桌面竖栏**：宽度由 `width` 内联写死（实测在 375 宽的屏上
 * 渲染成 320px，右边空出 55px 的死区），顶部一整行品牌标识加一个"折叠侧栏"
 * 按钮，底部钉着设置。把它塞进手机的 Tab 页里，就是一眼能看出来的
 * "桌面组件硬塞进手机"——而这正是这轮重设计要解决的五个问题之一。
 *
 * 光把 `width` 传对只能去掉那条死区，品牌行、折叠键、桌面密度都还在。
 * 而那些元素的类名是 CSS Modules 的哈希（`hHd-Xa_logoRow` 之类），
 * **升一次 dsh 就会变**，靠选择器去藏它们等于埋一颗定时炸弹。
 *
 * ## 为什么这样换是安全的
 *
 * dsh 的坑位系统本来就允许替换自带 UI：真正要紧的是那五个**子坑位的名字**
 * 一字不差（`sidebar.workspaces` 等），因为其余插件注册的目标是坑位名，
 * 不是某个包。名字对上了，会话树、设置面板、页脚动作照旧落位——换掉的
 * 只有承载它们的那层外壳几何。
 *
 * ## 这一版丢掉了什么
 *
 * - **品牌行**：手机上重复——Tab 页顶上已经有"会话"标题了。
 * - **折叠/展开侧栏**：手机没有"侧栏"这个形态，折叠无意义。
 * - **品牌 mark / name 两个子坑位**：仍然声明（声明等于占位，不声明的话
 *   注册进来的东西会落空并报错），只是这层外壳不画它们。
 */

/** 这层外壳真正用到的 props。其余 share 字段一概不碰。 */
interface MobileSidebarProps {
  /** 新建会话。由插件侧注入，转发到 `ctx.workspaces.startSession`。 */
  startSession: (workspaceId?: string) => void
  renderSlot: (name: string, owner: Record<string, unknown>) => ReactNode
}

/** 新会话图标。这个包不引图标库，内联 SVG。 */
function NewSessionIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

export function MobileSidebar({ startSession, renderSlot }: MobileSidebarProps) {
  return (
    <div className={cls.sidebar}>
      {/* 主操作留在最上面、通栏、44 高——单手可达是这轮的硬指标。 */}
      <button
        type="button"
        className={cls.newSession}
        onClick={() => {
          startSession()
        }}
      >
        <NewSessionIcon />
        <span>新会话</span>
      </button>

      {/*
        会话树本体（ui-workspace 注册在这里）：工作区分组、搜索、每行的菜单、
        "展开其余 N 个会话"全都在这一块里。**这部分是照搬的，不是重做的**
        ——它本身没有桌面假设，缺的只是宽度和触控尺寸，那两样由外壳给。
      */}
      <div className={cls.sidebarBody}>
        {renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}
      </div>

      {/* 设置钉在底部，贴着 Tab 栏上沿。 */}
      <div className={cls.sidebarFoot}>
        {renderSlot('sidebar.footer.action', { wide: true })}
        {renderSlot('sidebar.settings', { wide: true })}
      </div>
    </div>
  )
}
