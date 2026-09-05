import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { readdir, open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMITS, globSearch, grepSearch, looksBinary, walkFiles, emptyStats,
  type SearchFs, type WalkOptions,
} from '../../src/search.ts'

/** 用 node:fs 实现注入面——生产里由 ctx.fs 实现。 */
const nodeFs: SearchFs = {
  async listDir(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isSymbolicLink: e.isSymbolicLink(),
    }))
  },
  async readBytes(file, maxBytes) {
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
      return new Uint8Array(buf.subarray(0, bytesRead))
    } finally {
      await fh.close()
    }
  },
  async mtimeMs(file) {
    return (await stat(file)).mtimeMs
  },
}

const VCS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const
const opts = (over: Partial<WalkOptions> = {}): WalkOptions =>
  ({ excludeDirs: VCS, skipHidden: false, limits: DEFAULT_LIMITS, ...over })

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fssearch-'))
  mkdirSync(join(root, 'src/deep'), { recursive: true })
  mkdirSync(join(root, '.git/objects'), { recursive: true })
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true })

  writeFileSync(join(root, 'README.md'), 'hello world\nsecond line\n')
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n// TODO: fix\n')
  writeFileSync(join(root, 'src/b.tsx'), 'const b = 2\n')
  writeFileSync(join(root, 'src/deep/c.ts'), 'deep TODO here\n')
  writeFileSync(join(root, 'cjk.txt'), '第一行 TODO\n第二行\n中文内容测试\n')
  // 该被跳过的东西
  writeFileSync(join(root, '.git/objects/blob'), 'TODO inside git\n')
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0x54, 0x4f, 0x44, 0x4f, 0x00, 0x01, 0x02]))
  writeFileSync(join(root, 'huge.txt'), 'TODO\n'.repeat(3))
  try { symlinkSync(join(root, 'src'), join(root, 'link-to-src')) } catch { /* 某些环境不允许 */ }
})

describe('walkFiles', () => {
  it('跳过 VCS 目录', async () => {
    const stats = emptyStats()
    const seen: string[] = []
    for await (const p of walkFiles(nodeFs, root, opts(), stats)) seen.push(p)
    expect(seen.some((p) => p.startsWith('.git/'))).toBe(false)
    expect(seen).toContain('src/deep/c.ts')
  })

  it('同一目录内的文件按字典序 yield', async () => {
    // 这条曾经红过：为了让栈弹出顺序正确而倒序遍历，把文件顺序也一起反了。
    const stats = emptyStats()
    const seen: string[] = []
    for await (const p of walkFiles(nodeFs, root, opts(), stats)) seen.push(p)
    const rootLevel = seen.filter((p) => !p.includes('/'))
    expect(rootLevel).toEqual([...rootLevel].sort())
    const srcLevel = seen.filter((p) => p.startsWith('src/') && p.split('/').length === 2)
    expect(srcLevel).toEqual([...srcLevel].sort())
  })

  it('遍历顺序可复现（跨平台 listDir 顺序没有保证）', async () => {
    const run = async () => {
      const st = emptyStats(); const out: string[] = []
      for await (const p of walkFiles(nodeFs, root, opts(), st)) out.push(p)
      return out
    }
    expect(await run()).toEqual(await run())
  })

  it('不跟随符号链接，而且如实计数', async () => {
    const stats = emptyStats()
    const seen: string[] = []
    for await (const p of walkFiles(nodeFs, root, opts(), stats)) seen.push(p)
    expect(seen.some((p) => p.startsWith('link-to-src/'))).toBe(false)
    expect(stats.skippedSymlink).toBeGreaterThanOrEqual(0)
  })

  it('遍历上限会截断并置位 hitWalkCap（约束的是工作量，不只是输出）', async () => {
    const stats = emptyStats()
    const seen: string[] = []
    const tiny = opts({ limits: { ...DEFAULT_LIMITS, maxWalkEntries: 2 } })
    for await (const p of walkFiles(nodeFs, root, tiny, stats)) seen.push(p)
    expect(stats.hitWalkCap).toBe(true)
    expect(seen.length).toBeLessThanOrEqual(2)
  })
})

describe('globSearch', () => {
  it('**/*.ts 匹配任意深度，且不含 .tsx', async () => {
    const { paths } = await globSearch(nodeFs, root, '**/*.ts', opts())
    expect([...paths].sort()).toEqual(['src/a.ts', 'src/deep/c.ts'])
  })

  it('支持大括号展开', async () => {
    const { paths } = await globSearch(nodeFs, root, '**/*.{ts,tsx}', opts())
    expect([...paths].sort()).toEqual(['src/a.ts', 'src/b.tsx', 'src/deep/c.ts'])
  })

  it('*.md 只匹配根层（不递归）', async () => {
    const { paths } = await globSearch(nodeFs, root, '*.md', opts())
    expect(paths).toEqual(['README.md'])
  })

  it('按修改时间降序排——最近改的排最前（dsh 传的是 --sort=modified）', async () => {
    // 这不是细节：结果被 GLOB_MAX_RESULTS=100 截断时，决定模型看到哪一批。
    const { utimesSync } = await import('node:fs')
    const now = Date.now() / 1000
    utimesSync(join(root, 'src/a.ts'), now - 1000, now - 1000)
    utimesSync(join(root, 'src/deep/c.ts'), now, now)
    const { paths } = await globSearch(nodeFs, root, '**/*.ts', opts())
    expect(paths[0]).toBe('src/deep/c.ts')
  })

  it('永远不返回 .git 里的东西', async () => {
    const { paths } = await globSearch(nodeFs, root, '**/*', opts())
    expect(paths.some((p) => p.includes('.git'))).toBe(false)
  })
})

describe('looksBinary', () => {
  it('有 NUL 即判为二进制', () => {
    expect(looksBinary(new Uint8Array([1, 2, 0, 3]))).toBe(true)
    expect(looksBinary(new Uint8Array([1, 2, 3]))).toBe(false)
  })
})

describe('grepSearch', () => {
  const grepOpts = (over = {}) => ({ ...opts(), maxMatches: 250, ...over })

  it('跨文件按行匹配，带行号', async () => {
    const { matches } = await grepSearch(nodeFs, root, 'TODO', grepOpts())
    const paths = matches.map((m) => m.path).sort()
    expect(paths).toContain('src/a.ts')
    expect(paths).toContain('src/deep/c.ts')
    expect(paths).toContain('cjk.txt')
    const a = matches.find((m) => m.path === 'src/a.ts')!
    expect(a.lineNumber).toBe(2)
    expect(a.line).toBe('// TODO: fix')
  })

  it('跳过二进制文件，并计数', async () => {
    const { matches, stats } = await grepSearch(nodeFs, root, 'TODO', grepOpts())
    expect(matches.some((m) => m.path === 'bin.dat')).toBe(false)
    expect(stats.skippedBinary).toBeGreaterThanOrEqual(1)
  })

  it('不搜 .git 里的内容', async () => {
    const { matches } = await grepSearch(nodeFs, root, 'TODO', grepOpts())
    expect(matches.some((m) => m.path.includes('.git'))).toBe(false)
  })

  it('include 过滤生效', async () => {
    const { matches } = await grepSearch(nodeFs, root, 'TODO', grepOpts({ include: '**/*.ts' }))
    expect(matches.every((m) => m.path.endsWith('.ts'))).toBe(true)
    expect(matches.length).toBeGreaterThan(0)
  })

  it('CJK 内容正确解码，不出乱码', async () => {
    const { matches } = await grepSearch(nodeFs, root, '中文', grepOpts())
    const hit = matches.find((m) => m.path === 'cjk.txt')!
    expect(hit.line).toBe('中文内容测试')
    expect(hit.line).not.toMatch(/�/)
  })

  it('超过 maxMatches 时停止并标记 truncated', async () => {
    const { matches, truncated } = await grepSearch(nodeFs, root, 'TODO', grepOpts({ maxMatches: 2 }))
    expect(matches).toHaveLength(2)
    expect(truncated).toBe(true)
  })

  it('超大文件被跳过并计数', async () => {
    const { stats } = await grepSearch(
      nodeFs, root, 'TODO',
      grepOpts({ limits: { ...DEFAULT_LIMITS, maxFileBytes: 4 } }),
    )
    expect(stats.skippedTooLarge).toBeGreaterThan(0)
  })

  it('非法正则抛出可读的错误，而不是崩溃', async () => {
    await expect(grepSearch(nodeFs, root, '[unclosed', grepOpts())).rejects.toThrow(/不是合法的正则/)
  })

  it('CRLF 的 \\r 被剥掉（与 ripgrep 一致）', async () => {
    const crlf = mkdtempSync(join(tmpdir(), 'crlf-'))
    writeFileSync(join(crlf, 'f.txt'), 'alpha TODO\r\nbeta\r\n')
    const { matches } = await grepSearch(nodeFs, crlf, 'TODO', grepOpts())
    expect(matches[0]!.line).toBe('alpha TODO')
  })
})
