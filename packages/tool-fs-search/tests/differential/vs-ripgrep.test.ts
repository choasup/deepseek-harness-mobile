import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { readdir, open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, globSearch, grepSearch, type SearchFs } from '../../src/search.ts'
// 用 dsh 自己构造的 argv，保证比的是"被替换掉的那个实现"的真实行为。
import { buildGlobCommand } from '@deepseek-ai/dsh-tool-fs-search'

const DSH_GLOB_ARGV = (pattern: string): string[] => buildGlobCommand({ pattern })

/**
 * 与真实 ripgrep 的差分对照。
 *
 * 我们的引擎要顶替 dsh 靠 ripgrep 实现的 `glob`/`grep`，所以"输出格式一致"
 * 不能只靠读代码断言——直接拿同一棵树喂给真 ripgrep，比结果。
 *
 * 二进制来自 dsh 自己打包的那份（@vscode/ripgrep），也就是被替换掉的那个实现。
 * 找不到就整组 skip，而不是悄悄放过。
 */
const RG = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
const ready = existsSync(RG)

const nodeFs: SearchFs = {
  async listDir(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name, isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink(),
    }))
  },
  async readBytes(file, maxBytes) {
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
      return new Uint8Array(buf.subarray(0, bytesRead))
    } finally { await fh.close() }
  },
  async mtimeMs(file) { return (await stat(file)).mtimeMs },
}

const VCS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const
// glob 传 --hidden（搜隐藏文件）；grep 不传（跳过）。两者语义不同。
const globOpts = { excludeDirs: VCS, skipHidden: false, limits: DEFAULT_LIMITS }
const grepOpts = { excludeDirs: VCS, skipHidden: true, limits: DEFAULT_LIMITS }

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'diff-'))
  mkdirSync(join(root, 'src/deep'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'src/a.ts'), 'const a = 1\n// TODO alpha\nplain\n')
  writeFileSync(join(root, 'src/b.ts'), 'TODO beta\n')
  writeFileSync(join(root, 'src/deep/c.ts'), 'nested TODO gamma\n')
  writeFileSync(join(root, 'src/d.md'), 'TODO in markdown\n')
  writeFileSync(join(root, 'cjk.txt'), '中文 TODO 行\n普通行\n')
  writeFileSync(join(root, '.git/hidden'), 'TODO must not appear\n')
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0x54, 0x4f, 0x44, 0x4f, 0x00, 0xff]))
})

/** ripgrep 的 --files + glob，等价于我们的 globSearch。 */
function rgGlob(pattern: string): string[] {
  // 直接用 dsh 的 buildGlobCommand 产生的 argv，而不是我们猜的等价形式——
  // 猜错过一次：ripgrep 在 `--glob '**/*'` 下会把 .git 里的东西也列出来，
  // 真正挡住它的是 dsh 显式传的 `--glob=!**/.git/**`。
  // 以 root 为 cwd、target 用 '.'——ripgrep 的 glob 是相对**当前目录**匹配的，
  // 不是相对搜索根。这也是 dsh 的调用方式（workdir 作 cwd）。
  const argv = [...DSH_GLOB_ARGV(pattern), '--', '.']
  let out = ''
  try { out = execFileSync(RG, ['--no-config', ...argv], { encoding: 'utf8', cwd: root }) }
  catch (e) { out = String((e as { stdout?: string }).stdout ?? '') }
  return out.split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, ''))
}

/** ripgrep 的 --json 行匹配，等价于我们的 grepSearch。 */
function rgGrep(pattern: string, include?: string): Array<{ path: string; lineNumber: number; line: string }> {
  const args = ['--no-config', '--json', '--sort', 'path']
  if (include) args.push('--glob', include)
  args.push(pattern, '.')
  let out = ''
  try { out = execFileSync(RG, args, { encoding: 'utf8', cwd: root }) }
  catch (e) { out = String((e as { stdout?: string }).stdout ?? '') }  // 无匹配时 rg 退出码为 1
  const hits: Array<{ path: string; lineNumber: number; line: string }> = []
  for (const raw of out.split('\n')) {
    if (!raw) continue
    const ev = JSON.parse(raw) as { type: string; data?: Record<string, never> }
    if (ev.type !== 'match') continue
    const d = ev.data as unknown as {
      path: { text: string }; line_number: number; lines: { text: string }
    }
    hits.push({
      path: d.path.text.replace(/^\.\//, ''),
      lineNumber: d.line_number,
      line: d.lines.text.replace(/\r?\n$/, ''),
    })
  }
  return hits
}

const key = (m: { path: string; lineNumber: number }) => `${m.path}:${m.lineNumber}`

describe.skipIf(!ready)('与真实 ripgrep 的差分对照', () => {
  it.each([['**/*.ts'], ['**/*.md'], ['src/*.ts'], ['**/*'], ['*.ts'], ['*.md']])(
    'glob %s 的结果集与 ripgrep 一致', async (pattern) => {
      const mine = (await globSearch(nodeFs, root, pattern, globOpts)).paths
      const theirs = rgGlob(pattern)
      expect([...mine].sort()).toEqual([...theirs].sort())
    },
  )

  it('grep TODO 命中的 文件:行号 集合与 ripgrep 一致', async () => {
    const mine = (await grepSearch(nodeFs, root, 'TODO', { ...grepOpts, maxMatches: 250 })).matches
    const theirs = rgGrep('TODO')
    expect(mine.map(key).sort()).toEqual(theirs.map(key).sort())
  })

  it('匹配行的文本逐字符一致（含 CJK）', async () => {
    const mine = (await grepSearch(nodeFs, root, 'TODO', { ...grepOpts, maxMatches: 250 })).matches
    const theirs = new Map(rgGrep('TODO').map((m) => [key(m), m.line]))
    for (const m of mine) expect(m.line).toBe(theirs.get(key(m)))
  })

  it('include 过滤的行为与 ripgrep 的 --glob 一致', async () => {
    const mine = (await grepSearch(nodeFs, root, 'TODO', { ...grepOpts, maxMatches: 250, include: '**/*.ts' })).matches
    const theirs = rgGrep('TODO', '**/*.ts')
    expect(mine.map(key).sort()).toEqual(theirs.map(key).sort())
  })

  it('两边都跳过 .git 与二进制文件', async () => {
    const mine = (await grepSearch(nodeFs, root, 'TODO', { ...grepOpts, maxMatches: 250 })).matches
    const theirs = rgGrep('TODO')
    for (const set of [mine, theirs]) {
      expect(set.some((m) => m.path.includes('.git'))).toBe(false)
      expect(set.some((m) => m.path === 'bin.dat')).toBe(false)
    }
  })
})
