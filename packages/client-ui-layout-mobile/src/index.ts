/**
 * 移动布局插件的 **host 半边**：空的。
 *
 * 存在的唯一目的是让这个包出现在 host 的 cordis Loader 条目里——
 * `dsh-client-modules` 的 Node 半边"扫描已启用的 Loader 条目，找出带
 * `dsh.client` 的 web 包，解析各自的 `exports['./client']`"，然后把那个
 * bundle 挂到 `/plugins/<包名>/client.js` 上供浏览器加载。
 * 没有这一行，浏览器半边永远不会被发现。
 *
 * dsh 自己的 UI 插件是同样的形状（见 `dsh-client-ui-layout/lib/index.js`）。
 */
export function apply(): void {}
