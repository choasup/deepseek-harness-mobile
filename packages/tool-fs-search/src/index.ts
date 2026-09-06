/**
 * `@dsh-mobile/tool-fs-search` —— 纯 JS 的 glob / grep。
 *
 * 这是个**纯 barrel**：只导出类型与纯函数，不带加载期副作用，也不值导入
 * dsh 的运行时。cordis 接线在 `./plugin` 子路径——消费者只为取一个纯函数
 * 不该被迫解析整个插件栈。两个兄弟包（remote-registry / shell-ssh）同此规矩。
 */
export {
  DEFAULT_LIMITS, emptyStats, globSearch, grepSearch, looksBinary, normalizeGlob, walkFiles,
} from './search.ts'
export { isIgnored, parseGitignore } from './gitignore.ts'
export type { IgnoreLayer, IgnoreRule } from './gitignore.ts'
export type {
  GrepMatch, GrepOptions, SearchDirEntry, SearchFs, SearchLimits, WalkOptions, WalkStats,
} from './search.ts'
