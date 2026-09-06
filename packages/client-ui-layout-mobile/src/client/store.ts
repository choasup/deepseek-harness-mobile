import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * 移动布局的面板 store。
 *
 * 跟桌面版的关键差别：桌面版把"偏好宽度"本身当状态（可拖拽，0 表示关闭），
 * 移动端的抽屉和底部 sheet **没有宽度这个自由度**——它们要么盖住屏幕、
 * 要么不在。所以这里存的是两个布尔量，不是像素。
 *
 * 这也顺带消掉了桌面版那条"让路链"（concession chain）：单栏布局没有
 * 三栏互相挤压的问题，会话列永远是整个可用宽度。
 */
export function createMobileLayoutStore() {
  return defineStore({
    init: () => ({
      /** 左侧抽屉是否展开。移动端默认收起——小屏上先给内容。 */
      drawer: false,
      /** 底部详情 sheet 是否展开。 */
      details: false,
    }),
    actions: {
      toggleSidebar: (d) => {
        d.drawer = !d.drawer
      },
      closeSidebar: (d) => {
        d.drawer = false
      },
      openDetails: (d) => {
        d.details = true
      },
      closeDetails: (d) => {
        d.details = false
      },
    },
  })
}
