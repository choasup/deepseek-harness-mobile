/**
 * 宿主（Node）半边。
 *
 * 这个插件**只有浏览器半边有内容**：它往 `env` 坑位注册「环境」Tab 的内容，
 * 全部逻辑都在 `src/client/`。宿主这半边之所以还要存在，是因为
 * dsh 的 loader 是按包加载的——`dsh-client-modules` 扫的是已启用的 Loader
 * 条目里带 `dsh.client` 的包，包得先被挂上，它的 client bundle 才会被服务出去。
 *
 * 所以这里是一个空插件，不注入任何服务、不注册任何东西。
 */
export function apply(): void {
  // 有意为空：见上面的说明。
}
