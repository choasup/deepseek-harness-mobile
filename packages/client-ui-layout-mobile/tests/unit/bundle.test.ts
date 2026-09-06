import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 浏览器半边不是普通 ESM，也不是普通 CJS：宿主要求
 * `window.__ModuleLoader__.load({ id, factory })` 这个外壳（lazy CJS / web2）。
 * 格式错了不会有编译错误——`/plugins/…/client.js` 照常 200，脚本照常执行，
 * 只是**什么都没注册**，界面空白。所以这几条检查的是构建产物本身。
 */
const bundle = fileURLToPath(new URL('../../lib/client.js', import.meta.url))
const ready = existsSync(bundle)
const text = ready ? readFileSync(bundle, 'utf8') : ''

describe.skipIf(!ready)('client bundle 的加载格式', () => {
  it('以 __ModuleLoader__.load 注册，id 就是包名', () => {
    expect(text.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(text).toContain('id: "@dsh-mobile/client-ui-layout-mobile"')
  })

  it('导出 apply 与 inject（loader 把整个模块当 object plugin 用）', () => {
    expect(text).toContain('apply: () => apply')
    expect(text).toContain('inject: () => inject')
  })

  it('只 require 宿主预置的那几个 external，不夹带自己的 React', () => {
    const required = [...text.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!)
    expect(new Set(required)).toEqual(
      new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-runtime/client']),
    )
  })

  it('把 CSS 打进了 bundle（宿主不会替我们加载样式表）', () => {
    // 样式随 factory 执行时注入；漏了它整个外框没有布局。
    expect(text).toContain('data-plugin-css')
    expect(text).toContain('dshm-frame')
  })
})
