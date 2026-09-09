/**
 * 这个包要顶替 `@deepseek-ai/dsh-client-ui-layout` 的坑位，但**不能**从它
 * import 类型——真装上时那个包是被禁用的，而且我们的 lib/client.js 是
 * 自包含的 bundle。所以这里按它 `.d.ts` 公布的契约重新声明一遍。
 *
 * 契约来源：`dsh-client-ui-layout/lib/types/client/{index,service}.d.ts`。
 * 若 dsh 升级后契约变了，坏的是运行时而不是这里的编译——
 * `tests/unit/contract.test.ts` 拿真实安装里的 `.d.ts` 对账，就是为了这个。
 */

/** 侧栏 slot 的 owner share：桌面版给的是并列栏的实时状态。 */
export interface SidebarOwnerProps {
  /** 侧栏是否收起（收起时占位者渲染紧凑控制条）。 */
  collapsed: boolean
  /** 渲染宽度 px。 */
  width: number
}

/** 会话列 owner share：空的，业务状态由占位者自己的 hook 取。 */
export type ConvOwnerProps = Record<string, never>

/** 详情列 owner share：空的，sessionId 由框架按 scope 注入。 */
export type DetailsOwnerProps = Record<string, never>

/** 「环境」Tab 的 owner share：空的，内容由占位者自取。 */
export type EnvOwnerProps = Record<string, never>

/** 布局 store 的 bound action 集合。 */
export interface PanelActions {
  selectTab(tab: 'sessions' | 'env'): void
  openConversation(): void
  backToList(): void
  openDetails(): void
  closeDetails(): void
  /**
   * 没有抽屉之后这两个的语义变了，但**必须保留**：dsh 的其他插件按
   * `ILayout` 契约调它们，删掉不会编译报错，只会在运行时静默失效。
   * toggleSidebar = 回到会话 Tab（也就是会话页的"返回"）。
   */
  toggleSidebar(): void
  closeSidebar(): void
}

/** `ctx.layout` 的对外面。dsh 里别的插件按这三个方法调用。 */
export interface ILayout {
  /** 切换侧栏面板。 */
  toggleSidebar(): void
  /** 打开详情面板（已打开时无操作）。 */
  openDetails(): void
  /** 关闭详情面板。 */
  closeDetails(): void
}
