import type { ILayout, PanelActions } from './types.ts'

/**
 * `ctx.layout` 的对外面：别的插件（ui-sidebar 的折叠按钮、ui-conversation
 * 点开工具详情）通过它触发面板转场。
 *
 * 接口与 dsh 自己的 `LayoutController` **逐字段一致**——这是替换 layout
 * 插件的前提：那些插件 inject 的是 `layout` 这个服务名，不关心谁提供，
 * 但它们只会调 `toggleSidebar` / `openDetails` / `closeDetails` 这三个方法。
 * 移动端把这三个动作映射成抽屉与底部 sheet，语义仍然成立：
 * "打开侧栏"、"展开详情"、"收起详情"。
 */
export class MobileLayoutController implements ILayout {
  #panels: PanelActions | undefined

  /**
   * 接过 root 条目 store 的 bound actions。由 register() 的 inject 钩子调用，
   * 所以服务从条目第一次渲染起就是活的；条目重新注册时新的一组覆盖旧的。
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  openDetails(): void {
    this.#require().openDetails()
  }

  closeDetails(): void {
    this.#require().closeDetails()
  }

  #require(): PanelActions {
    if (this.#panels === undefined) {
      throw new Error('layout: panel actions not wired (root entry not mounted)')
    }
    return this.#panels
  }
}
