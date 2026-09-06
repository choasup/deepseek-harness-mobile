/**
 * `.gitignore` 解析与匹配。
 *
 * 为什么需要：dsh 的 `grep` 走 ripgrep 默认行为，**是遵守 `.gitignore` 的**
 * （它的 argv 里没有 `--no-ignore`）。在真实仓库上这个差别很大——不遵守的话
 * 一次 grep 会把 `node_modules` 整个搜一遍，在手机上尤其致命。
 *
 * ## 支持到什么程度
 *
 * 覆盖 gitignore 的常用语义，不是完整实现：
 *
 * | 支持 | 不支持 |
 * | --- | --- |
 * | `#` 注释、空行 | `\\` 转义（`\\#foo`、行尾空格保护） |
 * | `!` 否定，后出现的规则覆盖先出现的 | 全局 `~/.gitignore`、`.git/info/exclude` |
 * | `foo/` 只匹配目录 | `.ignore` / `.rgignore`（ripgrep 也读这些） |
 * | `/foo` 锚定到该 `.gitignore` 所在目录 | git 的"已跟踪文件不受 ignore 影响"语义 |
 * | 不含 `/` 的模式在任意深度匹配 | |
 * | 嵌套 `.gitignore` 作用于自己的子树 | |
 *
 * 最后两条"不支持"值得说明：这里没有 git 索引，无从知道哪些文件已被跟踪；
 * 而 `.ignore` / `.rgignore` 是 ripgrep 特有的，用的人远少于 `.gitignore`。
 * 两者都在 README 里如实写明。
 */
import { matchesGlobLikeRipgrep } from './search.ts'

export interface IgnoreRule {
  /** `!` 前缀：命中时反而**不**忽略。 */
  negated: boolean
  /** 以 `/` 结尾：只匹配目录。 */
  dirOnly: boolean
  /** 已归一化成可交给 `path.matchesGlob` 的形式，相对规则层的 base。 */
  glob: string
}

/** 一层规则：一个 `.gitignore` 文件及其所在目录（相对搜索根）。 */
export interface IgnoreLayer {
  /** 相对搜索根的目录路径；根层为 `''`。 */
  base: string
  rules: readonly IgnoreRule[]
}

/**
 * 解析一个 `.gitignore` 的内容。
 *
 * 归一化的关键是 gitignore 的锚定规则：**模式里（除结尾外）含 `/` 就锚定到
 * 该文件所在目录，否则在任意深度匹配**。后者要转成 `**\/x` 才能交给
 * `path.matchesGlob`——这与 `search.ts` 里 `normalizeGlob` 处理的是同一件事，
 * 但规则不同（那边是 ripgrep 的 `--glob`，这边是 gitignore），所以没有复用。
 */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/, '')
    // 行尾空格被忽略（真 git 允许用 `\` 保护，这里不支持——见文件头的表格）。
    line = line.replace(/\s+$/, '')
    if (line === '' || line.startsWith('#')) continue

    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    }

    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (line === '') continue

    // 锚定判断要在去掉结尾 `/` **之后**做：`foo/` 是"任意深度的 foo 目录"，
    // 而 `a/b` 才是锚定的。
    const anchored = line.includes('/')
    if (anchored && line.startsWith('/')) line = line.slice(1)
    rules.push({ negated, dirOnly, glob: anchored ? line : `**/${line}` })
  }
  return rules
}

/** 某条规则是否命中这个（相对该层 base 的）路径。 */
function ruleMatches(rule: IgnoreRule, relToBase: string, isDir: boolean): boolean {
  // 直接命中：`dirOnly` 在这里生效——`build/` 不该匹配一个叫 build 的文件。
  if (matchesGlobLikeRipgrep(relToBase, rule.glob) && (!rule.dirOnly || isDir)) return true

  // 子树命中：一个被忽略的**目录**，其下所有内容都一并被忽略。
  // 这里**不能**再看 `dirOnly`——`node_modules/` 命中的是那个目录，
  // 而我们正在判断的是 `node_modules/pkg/x.js` 这个**文件**；
  // 用 dirOnly 卡掉它的话，只有目录项被过滤、里面的文件照样被搜。
  // 反过来说，能匹配上 `<glob>/**` 就已经蕴含了父级是目录。
  return matchesGlobLikeRipgrep(relToBase, `${rule.glob}/**`)
}

/**
 * 判断一个路径是否被忽略。
 *
 * 层按从外到内的顺序给出；同一层内**后出现的规则覆盖先出现的**（gitignore
 * 的语义就是"最后一条命中的说了算"），所以要遍历完而不是命中即返回。
 */
export function isIgnored(
  relPath: string,
  isDir: boolean,
  layers: readonly IgnoreLayer[],
): boolean {
  let ignored = false
  for (const layer of layers) {
    if (layer.base !== '' && !relPath.startsWith(`${layer.base}/`)) continue
    const relToBase = layer.base === '' ? relPath : relPath.slice(layer.base.length + 1)
    for (const rule of layer.rules) {
      if (ruleMatches(rule, relToBase, isDir)) ignored = !rule.negated
    }
  }
  return ignored
}
