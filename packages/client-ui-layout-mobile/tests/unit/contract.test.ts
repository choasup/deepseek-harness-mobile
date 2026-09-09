import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 这个包顶替 `@deepseek-ai/dsh-client-ui-layout` 的坑位。顶替的正确性**不由
 * 类型系统保证**——我们故意不 import 那个包（装上时它是被禁用的，而我们的
 * client bundle 是自包含的），契约是照它的 `.d.ts` 手抄的。
 *
 * 抄错的后果不是编译失败，是运行时静默错位：slot 名对不上，其余 32 个 UI
 * 插件注册进来的东西**落不到任何位置**，界面就是一片空白，没有报错。
 *
 * 所以这里拿真实安装里的 `.d.ts` 对账。dsh 升级后契约若变了，红的是这条。
 */
const DSH_LAYOUT =
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout'
const dts = `${DSH_LAYOUT}/lib/types/client/index.d.ts`
const serviceDts = `${DSH_LAYOUT}/lib/types/client/service.d.ts`
const ready = existsSync(dts) && existsSync(serviceDts)

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

describe.skipIf(!ready)('与 dsh 真实 layout 插件的契约对账', () => {
  /**
   * **方向是"不能少"，不是"必须相等"。**
   *
   * 少一个名字 = dsh 那些插件注册进来的东西落不到任何位置，界面空白且不报错
   * ——这是这条测试存在的理由，一直没变。
   *
   * 多一个是有意的：移动版重设计把左侧抽屉换成底部 Tab 栏，多出一个 `env`
   * 坑位给「环境」Tab（机器、探针、GitHub）。桌面版没有这一格，所以断言从
   * "相等"放宽成"超集"，而不是把这条测试删掉。
   */
  it('dsh 的每个子 slot 名都被我们声明了（可以多，不能少）', () => {
    // dsh 的 SlotMap 扩展里，每个 slot 名以 `'name': {` 的形式出现。
    const block = readFileSync(dts, 'utf8')
    const declared = new Set(
      [...block.matchAll(/^\s{8}'([a-z.]+)':\s*\{/gm)].map((m) => m[1]!),
    )
    const ours = new Set(
      [...src('client/index.tsx').matchAll(/^\s{10}'?([a-z.]+)'?:\s*\{\s*kind:/gm)].map(
        (m) => m[1]!,
      ),
    )
    expect(declared.size, 'dsh 的 .d.ts 里没解析出 slot 名，正则该更新了').toBeGreaterThan(0)
    const missing = [...declared].filter((name) => !ours.has(name))
    expect(missing, '少一个名字 = 那一格的注册全部落空，界面空白且不报错').toEqual([])
  })

  it('每个 slot 的 kind 与 scope 也一致', () => {
    const block = readFileSync(dts, 'utf8')
    const theirs = [...block.matchAll(/'([a-z.]+)':\s*\{\s*kind:\s*'(\w+)';\s*scope:\s*'([\w-]+)'/g)]
      .map((m) => `${m[1]}:${m[2]}:${m[3]}`)
      .sort()
    const ours = [
      ...src('client/index.tsx').matchAll(
        /'?([a-z.]+)'?:\s*\{\s*kind:\s*'(\w+)',\s*scope:\s*'([\w-]+)'/g,
      ),
    ]
      .map((m) => `${m[1]}:${m[2]}:${m[3]}`)
      .sort()
    expect(theirs.length).toBeGreaterThan(0)
    // 同上：我们自己多出来的坑位不参与比对，dsh 有的每一个都必须一字不差。
    const oursByName = new Map(ours.map((row) => [row.split(':')[0]!, row]))
    for (const row of theirs) {
      const name = row.split(':')[0]!
      expect(oursByName.get(name), `slot ${name} 的 kind/scope 与 dsh 不一致`).toBe(row)
    }
  })

  it('ILayout 的方法集与 dsh 的一致（别的插件按这几个名字调用）', () => {
    const block = readFileSync(serviceDts, 'utf8')
    // 只取 interface 那一段：同一个文件里 LayoutController 又实现了一遍
    // 同名方法，从 interface 一路切到文件尾会把每个名字数两次。
    const start = block.indexOf('export interface ILayout')
    const iface = block.slice(start, block.indexOf('\n}', start))
    const theirs = [...iface.matchAll(/^\s{4}(\w+)\(\):\s*void;/gm)].map((m) => m[1]!).sort()
    const ours = [...src('client/types.ts').matchAll(/^\s{2}(\w+)\(\):\s*void$/gm)]
      .map((m) => m[1]!)
      .filter((n) => ['toggleSidebar', 'openDetails', 'closeDetails', 'closeSidebar'].includes(n))
      .sort()
    expect(theirs).toEqual(['closeDetails', 'openDetails', 'toggleSidebar'])
    // 我们的 ILayout 必须至少覆盖 dsh 的全部方法；多出来的（closeSidebar）
    // 只在 PanelActions 上，不在对外面上。
    for (const name of theirs) expect(ours).toContain(name)
  })

  it('root 注册的 slot 名是 "root"（web shell 只渲染这一个）', () => {
    expect(src('client/index.tsx')).toContain("name: 'root'")
  })
})
