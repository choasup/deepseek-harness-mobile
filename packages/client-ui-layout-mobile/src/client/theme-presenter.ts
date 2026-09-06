/**
 * 把 `ctx.theme` 的快照投影到 document 上。
 *
 * **为什么这个包必须自带一份**：主题的"解析"在 `dsh-client-ui-theme`，
 * 但"写进 DOM"这一步是 `dsh-client-ui-layout` 顺带做的（它的 README
 * 原话：the package also seats the theme presenter）。我们把 layout 换掉，
 * 这一步就没人做了——后果不是"主题不对"，是**所有设计令牌变量都不存在**，
 * 整个界面（包括其余 32 个 UI 插件）全部掉成无样式。
 *
 * 所以这里按 dsh 的实现逐条复刻：html 的 color-scheme（决定原生控件外观）、
 * body 上的暗色属性（令牌样式表按它选调色板）、令牌变量本身，以及一个
 * 自有的 <meta name="theme-color">（内容取自写完之后 body 的计算背景色，
 * 所以"渲染出来的颜色"始终是唯一权威）。
 */

/** 令牌样式表用来选暗色底板的 body 属性。 */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

interface ThemeSnapshot {
  active: { colorScheme: 'light' | 'dark'; tokens: Record<string, string> }
}

export class ThemePresenter {
  /** 上一次写入的令牌名，也就是这个 presenter 的回收集合。 */
  #applied: string[] = []
  /** 这个 presenter 自己插入、自己移除的那个 meta 节点。 */
  readonly #meta: HTMLMetaElement

  constructor() {
    this.#meta = document.createElement('meta')
    this.#meta.name = 'theme-color'
  }

  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)

    for (const name of this.#applied) body.style.removeProperty(name)
    this.#applied = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.#applied.push(name)
    }

    // 顺序要紧：先写完令牌，再读计算样式，否则拿到的是上一帧的背景色。
    this.#meta.content = getComputedStyle(body).backgroundColor
    if (!this.#meta.isConnected) document.head.append(this.#meta)
  }

  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    for (const name of this.#applied) body.style.removeProperty(name)
    this.#applied = []
    this.#meta.remove()
  }
}
