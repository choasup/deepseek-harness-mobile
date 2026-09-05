/**
 * 纯 JS 的 glob / grep 引擎。
 *
 * dsh 自带的 `@deepseek-ai/dsh-tool-fs-search` 靠打包的 ripgrep 二进制，
 * 通过 `ctx.subprocess` spawn——iOS 上起不了进程，所以那两个工具在手机上
 * 直接消失。这里只替换**执行**部分；参数解析、采样、输出格式化、行截断
 * 全部复用 dsh 自己的导出，以保证对模型和界面而言输出逐字节一致。
 *
 * 文件访问走一个注入进来的最小接口而不是 `node:fs`：iOS 宿主提供的
 * `ctx.fs` 未必由 `node:fs` 支撑（可能桥接到 app 容器 / security-scoped
 * bookmark），直接调 `node:fs` 的工具在那里会失效。
 *
 * 注意 `ctx.fs` 的**读不受沙箱约束**——`dsh-fs-sandbox` 的描述明写
 * "fences write/edit ... while reads pass through"。所以用它不是为了读安全，
 * 是为了可移植。
 */
import path from 'node:path'

/** 搜索引擎需要的最小文件系统面。plugin 用 `ctx.fs` 实现，测试里用 `node:fs`。 */
export interface SearchFs {
  listDir(dir: string): Promise<readonly SearchDirEntry[]>
  /** 最多读 `maxBytes` 字节。超长文件不应被整个读进内存。 */
  readBytes(file: string, maxBytes: number): Promise<Uint8Array>
  /** 修改时间（毫秒）。glob 按它降序排——见 globSearch 的说明。 */
  mtimeMs(file: string): Promise<number>
}

export interface SearchDirEntry {
  name: string
  isDirectory: boolean
  isSymbolicLink: boolean
}

/** 一条匹配。字段与 dsh 的 `GrepMatch` 一致。 */
export interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

export interface SearchLimits {
  /** 超过这个大小的文件直接跳过——手机上不该把大文件整个读进内存。 */
  maxFileBytes: number
  /** 在前多少字节里找 NUL 来判定二进制。 */
  binarySniffBytes: number
  /** 遍历的条目总数上限，防病态目录树把手机卡死。 */
  maxWalkEntries: number
  /** 参与正则匹配的单行最大字符数，见下方 ReDoS 说明。 */
  maxMatchLineChars: number
}

export const DEFAULT_LIMITS: SearchLimits = {
  maxFileBytes: 8 * 1024 * 1024,
  binarySniffBytes: 8192,
  maxWalkEntries: 200_000,
  maxMatchLineChars: 8192,
}

export interface WalkOptions {
  /** 不进入的目录名（dsh 的 `GLOB_VCS_EXCLUDES`）。 */
  excludeDirs: readonly string[]
  /**
   * 跳过以 `.` 开头的文件与目录。
   *
   * dsh 的两个工具在这一点上**行为不同**，是从它实际传给 ripgrep 的参数
   * 里读出来的，不是猜的：
   * - `glob` 传 `--hidden`，**搜隐藏文件**（`skipHidden: false`）
   * - `grep` 不传，走 ripgrep 默认，**跳过隐藏文件**（`skipHidden: true`）
   */
  skipHidden: boolean
  limits: SearchLimits
  signal?: AbortSignal
}

/** 遍历过程中的统计，用来如实报告"有东西被跳过了"。 */
export interface WalkStats {
  filesSeen: number
  dirsSeen: number
  skippedTooLarge: number
  skippedBinary: number
  skippedSymlink: number
  hitWalkCap: boolean
}

export function emptyStats(): WalkStats {
  return {
    filesSeen: 0, dirsSeen: 0,
    skippedTooLarge: 0, skippedBinary: 0, skippedSymlink: 0,
    hitWalkCap: false,
  }
}

/**
 * 深度优先遍历，产出相对 `root` 的文件路径（POSIX 分隔符）。
 *
 * - **不跟随符号链接。** 这既避免了环，也与 ripgrep 的默认行为一致。
 *   跳过的数量记在 `stats.skippedSymlink` 里，不静默丢弃。
 * - 每层目录内按名字排序，保证跨平台结果可复现（`listDir` 的顺序没有保证）。
 * - `shouldStop` 返回 true 时立即停止——上限要约束**工作量**，不只是输出量。
 */
export async function* walkFiles(
  fs: SearchFs,
  root: string,
  options: WalkOptions,
  stats: WalkStats,
  shouldStop: () => boolean = () => false,
): AsyncGenerator<string> {
  const exclude = new Set(options.excludeDirs)
  const stack: string[] = ['']
  let entries = 0

  while (stack.length > 0) {
    if (shouldStop()) return
    options.signal?.throwIfAborted()
    const rel = stack.pop()!
    let listing: readonly SearchDirEntry[]
    try {
      listing = await fs.listDir(rel === '' ? root : path.join(root, rel))
    } catch {
      // 读不了的目录（权限、竞态删除）跳过而不是让整次搜索失败。
      continue
    }
    stats.dirsSeen += 1

    // 排序保证确定性。文件要**正序** yield（否则同一目录内的输出是倒的），
    // 而子目录要**倒序**压栈（栈是后进先出，倒序压入才能按字典序弹出）。
    // 这两件事方向相反，必须分开做——写成一个倒序循环会让文件顺序反掉。
    const sorted = [...listing].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const subdirs: string[] = []
    for (const entry of sorted) {
      entries += 1
      if (entries > options.limits.maxWalkEntries) {
        stats.hitWalkCap = true
        return
      }
      if (entry.isSymbolicLink) {
        stats.skippedSymlink += 1
        continue
      }
      if (options.skipHidden && entry.name.startsWith('.')) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory) {
        if (!exclude.has(entry.name)) subdirs.push(childRel)
        continue
      }
      stats.filesSeen += 1
      yield childRel
    }
    for (let i = subdirs.length - 1; i >= 0; i -= 1) stack.push(subdirs[i]!)
  }
}

/**
 * 把 glob 归一化到 **gitignore 语义**，也就是 ripgrep 用的那一套。
 *
 * 差分测试挖出来的方言差异（实测 ripgrep 15.0.0）：
 *
 * | 模式 | ripgrep | `path.matchesGlob` |
 * | --- | --- | --- |
 * | `*.ts` | 任意深度的所有 .ts | 只匹配根层 |
 * | `src/*.ts` | 锚定到根 | 锚定到根 |
 *
 * gitignore 的规则是：**不含 `/` 的模式在任意深度匹配**，含 `/` 的锚定到根。
 * 而 `*.ts` 正是模型最常写的那个——不归一化的话，一个 naive 实现会对最常见
 * 的用法静默返回错误结果（少一大半文件），而且看不出哪里错了。
 */
export function normalizeGlob(pattern: string): string {
  const body = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
  return body.includes('/') ? pattern : `**/${pattern}`
}

/** 判定二进制：前若干字节里有 NUL 就当二进制（ripgrep 同样的启发式）。 */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0)
}

/**
 * glob：返回相对 `root` 的匹配路径，字典序。
 *
 * 匹配用 Node 内置的 `path.matchesGlob`（Node 22.5+，已验证在 `--jitless`
 * 下可用），而不是 `fs.globSync`——后者是 `node:fs` API，绕开了注入的 fs 面。
 */
export async function globSearch(
  fs: SearchFs,
  root: string,
  pattern: string,
  options: WalkOptions,
): Promise<{ paths: string[]; stats: WalkStats }> {
  const stats = emptyStats()
  const hits: string[] = []
  for await (const rel of walkFiles(fs, root, options, stats)) {
    if (path.matchesGlob(rel, normalizeGlob(pattern))) hits.push(rel)
  }

  // dsh 传给 ripgrep 的是 `--sort=modified`，**不是按路径排**。
  // 这不是细节：最近改过的文件排在前面，配合 GLOB_MAX_RESULTS=100 的截断，
  // 决定了模型在结果被截断时看到的是哪一批文件。按路径排会把"我刚改的那个"
  // 排到一百名开外。同 mtime 时按路径排以保证确定性。
  const withTime = await Promise.all(
    hits.map(async (rel) => ({ rel, mtime: await fs.mtimeMs(path.join(root, rel)).catch(() => 0) })),
  )
  withTime.sort((a, b) => (b.mtime - a.mtime) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { paths: withTime.map((x) => x.rel), stats }
}

export interface GrepOptions extends WalkOptions {
  /** 只搜匹配这个 glob 的文件。 */
  include?: string
  /** 命中这么多条就停止遍历。 */
  maxMatches: number
}

/**
 * grep：按行匹配正则，返回 `GrepMatch[]`。
 *
 * **ReDoS 说明**：`pattern` 来自模型，正则匹配是同步的，一个病态正则配上
 * 长行可以把主线程卡住。这里用 `limits.maxMatchLineChars` 截断参与匹配的
 * 行长作为有界化手段——不是完备防护，但把最坏情况从"文件多长就多糟"
 * 压到了一个常数上界。真正的隔离需要 worker，属于后续工作。
 */
export async function grepSearch(
  fs: SearchFs,
  root: string,
  pattern: string,
  options: GrepOptions,
): Promise<{ matches: GrepMatch[]; stats: WalkStats; truncated: boolean }> {
  const stats = emptyStats()
  const matches: GrepMatch[] = []
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (error) {
    throw new TypeError(`不是合法的正则表达式: ${pattern}（${(error as Error).message}）`)
  }

  const done = () => matches.length >= options.maxMatches
  for await (const rel of walkFiles(fs, root, options, stats, done)) {
    if (done()) break
    if (options.include !== undefined && !path.matchesGlob(rel, normalizeGlob(options.include))) continue

    let bytes: Uint8Array
    try {
      bytes = await fs.readBytes(path.join(root, rel), options.limits.maxFileBytes + 1)
    } catch {
      continue
    }
    if (bytes.length > options.limits.maxFileBytes) {
      stats.skippedTooLarge += 1
      continue
    }
    if (looksBinary(bytes.subarray(0, options.limits.binarySniffBytes))) {
      stats.skippedBinary += 1
      continue
    }

    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (done()) break
      const raw = lines[i]!
      // 去掉 CRLF 的 \r，与 ripgrep 的行为一致。
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      const probe = line.length > options.limits.maxMatchLineChars
        ? line.slice(0, options.limits.maxMatchLineChars)
        : line
      if (regex.test(probe)) {
        matches.push({ path: rel, lineNumber: i + 1, line })
      }
      regex.lastIndex = 0
    }
  }
  return { matches, stats, truncated: matches.length >= options.maxMatches }
}
