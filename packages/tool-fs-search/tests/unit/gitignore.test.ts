import { describe, expect, it } from 'vitest'
import { isIgnored, parseGitignore, type IgnoreLayer } from '../../src/gitignore.ts'

const layer = (base: string, text: string): IgnoreLayer => ({ base, rules: parseGitignore(text) })
const root = (text: string) => [layer('', text)]

describe('parseGitignore', () => {
  it('忽略空行与 # 注释', () => {
    expect(parseGitignore('\n# comment\n\nfoo\n')).toHaveLength(1)
  })

  it('识别否定与"只匹配目录"', () => {
    const [a, b] = parseGitignore('!keep\nbuild/\n')
    expect(a).toMatchObject({ negated: true, dirOnly: false })
    expect(b).toMatchObject({ negated: false, dirOnly: true })
  })

  it('不含 / 的模式归一化为任意深度', () => {
    expect(parseGitignore('*.log')[0]!.glob).toBe('**/*.log')
  })

  it('含 / 的模式保持锚定，且剥掉前导 /', () => {
    expect(parseGitignore('/dist\n')[0]!.glob).toBe('dist')
    expect(parseGitignore('a/b\n')[0]!.glob).toBe('a/b')
  })

  it('`foo/` 是"任意深度的 foo 目录"，不是锚定', () => {
    // 结尾的 / 表示 dirOnly，不参与锚定判断——这是很容易写错的一条。
    expect(parseGitignore('node_modules/\n')[0]!.glob).toBe('**/node_modules')
  })
})

describe('isIgnored', () => {
  it('目录被忽略时，其下所有内容一并忽略', () => {
    const l = root('node_modules/\n')
    expect(isIgnored('node_modules', true, l)).toBe(true)
    expect(isIgnored('node_modules/pkg/index.js', false, l)).toBe(true)
    expect(isIgnored('src/index.js', false, l)).toBe(false)
  })

  it('dirOnly 的规则不匹配同名文件', () => {
    const l = root('build/\n')
    expect(isIgnored('build', true, l)).toBe(true)
    expect(isIgnored('build', false, l)).toBe(false)
  })

  it('后出现的否定规则覆盖先出现的忽略', () => {
    const l = root('*.log\n!keep.log\n')
    expect(isIgnored('a.log', false, l)).toBe(true)
    expect(isIgnored('keep.log', false, l)).toBe(false)
  })

  it('顺序相反时，后面的忽略又盖回来', () => {
    // 证明"最后一条命中的说了算"是真的按顺序，而不是"否定优先"。
    const l = root('!keep.log\n*.log\n')
    expect(isIgnored('keep.log', false, l)).toBe(true)
  })

  it('锚定的模式只在该层根部生效', () => {
    const l = root('/dist\n')
    expect(isIgnored('dist', true, l)).toBe(true)
    expect(isIgnored('pkg/dist', true, l)).toBe(false)
  })

  it('嵌套的 .gitignore 只作用于自己的子树', () => {
    const layers = [layer('', 'root.txt\n'), layer('pkg', 'inner.txt\n')]
    expect(isIgnored('inner.txt', false, layers)).toBe(false)
    expect(isIgnored('pkg/inner.txt', false, layers)).toBe(true)
    expect(isIgnored('root.txt', false, layers)).toBe(true)
    expect(isIgnored('pkg/root.txt', false, layers)).toBe(true)
  })

  it('内层可以用否定放行外层忽略的东西', () => {
    const layers = [layer('', '*.log\n'), layer('pkg', '!important.log\n')]
    expect(isIgnored('a.log', false, layers)).toBe(true)
    expect(isIgnored('pkg/important.log', false, layers)).toBe(false)
  })
})
