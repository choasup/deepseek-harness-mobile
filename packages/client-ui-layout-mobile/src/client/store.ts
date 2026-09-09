import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * 移动布局的面板 store。
 *
 * ## 从"抽屉"改成"Tab 栏"之后，这里存的是什么
 *
 * 旧版存的是 `drawer: boolean`——侧栏抽屉开没开。新版没有抽屉了：导航移到
 * 底部 Tab 栏（单手可达是重设计要解决的五个问题之一），所以存的是**当前在
 * 哪个 Tab**，以及底部详情 sheet 开没开。
 *
 * 跟桌面版的差别仍然成立：桌面把"偏好宽度"当状态（可拖拽，0 表示关闭），
 * 移动端的 Tab 页与 sheet **没有宽度这个自由度**，要么占满要么不在。
 */
export type MobileTab = 'sessions' | 'env'

export function createMobileLayoutStore() {
  return defineStore({
    init: () => ({
      /** 当前 Tab。会话列表是默认落点。 */
      tab: 'sessions' as MobileTab,
      /**
       * 当前在列表还是在会话里。
       *
       * **必须和"有没有当前会话"分开。** 第一版把路由判据写成
       * `current !== undefined`，结果返回键点了没反应——它只切 Tab、不清会话，
       * 而会话一直都在。导航是导航，选择是选择，两者耦合就没有"返回"可言。
       */
      view: 'list' as 'list' | 'conversation',
      /** 底部详情 sheet 是否展开。 */
      details: false,
    }),
    actions: {
      selectTab: (d, tab: MobileTab) => {
        d.tab = tab
        d.view = 'list'
      },
      openConversation: (d) => {
        d.view = 'conversation'
      },
      backToList: (d) => {
        d.view = 'list'
        d.details = false
      },
      openDetails: (d) => {
        d.details = true
      },
      closeDetails: (d) => {
        d.details = false
      },
      // 兼容 ILayout 的既有契约：dsh 的其他插件会调 toggleSidebar/closeSidebar。
      // 没有抽屉之后它们的语义变成"回到会话 Tab"——**不能直接删掉**，
      // 那会让调用方静默失效（cordis 不会因为少一个 action 而报错）。
      toggleSidebar: (d) => {
        d.tab = 'sessions'
        d.view = 'list'
      },
      closeSidebar: (d) => {
        d.details = false
      },
    },
  })
}
