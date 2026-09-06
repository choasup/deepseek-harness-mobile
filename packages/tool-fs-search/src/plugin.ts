/**
 * 把纯 JS 的 glob / grep 注册成 dsh 工具。
 *
 * ## 为什么不复用 dsh 的插件
 *
 * `@deepseek-ai/dsh-tool-fs-search` 的 `applyGlobTool` / `applyGrepTool` 是导出的，
 * 但它们内部直接 `runRipgrep(ctx, ...)`，没有可注入执行器的缝。
 *
 * ## 为什么不伪造 `ctx.subprocess`
 *
 * 技术上可行——伪造一个只认 ripgrep 的 `subprocess` 服务，就能原样复用 dsh 的
 * 全部定义、零重复。但那等于**声称一个 iOS 上根本不存在的能力**：任何别的
 * 消费者拿到这个服务都会真的去起进程然后失败。本项目已经就同一类问题做过
 * 两次相反方向的裁决（不填 `ShellRunResult.sandbox`、`kill()` 如实说明只是
 * 关闭通道），这里保持一致：**宁可自己重写定义，也不提供一个假的能力**。
 *
 * 代价是定义可能与 dsh 漂移。用 `tests/composition/parity.test.ts` 兜底——
 * 它把我们的工具定义和 dsh 的逐字段比对。
 */
import type { Context } from '@deepseek-ai/cordis'
// 仅为把 `ctx.fs` 的 Context 增广引进来——`declare module` 是模块级副作用，
// 不显式 import 就不生效。运行时不产生任何导入（类型导入会被擦除）。
import type {} from '@deepseek-ai/dsh-fs'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ItemRetainer } from '@deepseek-ai/dsh-output-retention'
import {
  GLOB_MAX_RESULTS, GLOB_VCS_EXCLUDES, GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES,
  formatGlobOutput, formatGrepOutput, parseGlobArgs, parseGrepArgs, sampleAcrossTopLevel,
} from '@deepseek-ai/dsh-tool-fs-search'
import {
  DEFAULT_LIMITS, globSearch, grepSearch, type GrepMatch, type SearchFs, type SearchLimits,
} from './search.ts'

export const name = 'tool-fs-search-js'
export const inject = ['tools', 'systemPrompt', 'fs']

export interface JsFsSearchConfig {
  globMaxResults?: number
  grepMaxMatches?: number
  grepMaxLineBytes?: number
  /** 超过这个字节数的文件跳过；手机上不该整个读进内存。 */
  maxFileBytes?: number
  /** 遍历条目上限，防病态目录树。 */
  maxWalkEntries?: number
}

export const Config: z<JsFsSearchConfig> = z.object({
  globMaxResults: z.number().default(GLOB_MAX_RESULTS),
  grepMaxMatches: z.number().default(GREP_MAX_MATCHES),
  grepMaxLineBytes: z.number().default(GREP_MAX_LINE_BYTES),
  maxFileBytes: z.number().default(DEFAULT_LIMITS.maxFileBytes),
  maxWalkEntries: z.number().default(DEFAULT_LIMITS.maxWalkEntries),
})

/**
 * 把 `ctx.fs` 适配成引擎需要的最小面。
 *
 * 用 `ctx.fs` 而不是 `node:fs`，是因为 iOS 宿主提供的实现未必由 `node:fs`
 * 支撑（可能桥接到 app 容器或 security-scoped bookmark）。
 * 注意这**不是**读安全上的收益——`dsh-fs-sandbox` 的描述明写它只
 * "fences write/edit ... while reads pass through"。
 */
export function searchFsFromContext(ctx: Context): SearchFs {
  const fs = ctx.fs as unknown as {
    listDir(target: string): Promise<readonly { name: string; kind?: string; isDirectory?: boolean; isSymbolicLink?: boolean }[]>
    readBytes(target: string, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
    stat(target: string): Promise<{ mtimeMs?: number } | undefined>
  }
  return {
    async listDir(dir) {
      const entries = await fs.listDir(dir)
      return entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory ?? e.kind === 'directory',
        isSymbolicLink: e.isSymbolicLink ?? e.kind === 'symlink',
      }))
    },
    readBytes: (file, maxBytes) => fs.readBytes(file, undefined, maxBytes),
    async mtimeMs(file) {
      return (await fs.stat(file))?.mtimeMs ?? 0
    },
  }
}

function limitsFrom(config: Required<JsFsSearchConfig>): SearchLimits {
  return {
    ...DEFAULT_LIMITS,
    maxFileBytes: config.maxFileBytes,
    maxWalkEntries: config.maxWalkEntries,
  }
}

export function apply(ctx: Context, config: JsFsSearchConfig): void {
  const resolved = Config(config) as Required<JsFsSearchConfig>
  const limits = limitsFrom(resolved)
  const fs = searchFsFromContext(ctx)

  // 系统提示词照抄 dsh 的措辞与 order——模型读到的必须是同一段话，
  // 尤其是那句"不含 / 的模式在任意深度匹配"，它正是我们实现里
  // normalizeGlob 要还原的方言。
  ctx.systemPrompt.section({
    name: 'tool:glob',
    order: 103,
    text:
      'Use the glob tool — not shell find — to discover files by path pattern. ' +
      'A pattern with no "/" matches basenames at any depth, so "*" matches every file ' +
      'in the tree rather than its top level. Results are files only, never directories, ' +
      'and include hidden and ignored files: a result that fits comes back in ' +
      'modification-time order, while a larger one keeps the modification-time-ordered head.',
  })
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: 104,
    text:
      'Use the grep tool — not shell grep or rg — to search file contents. ' +
      'Use read on a matched file when you need surrounding context.',
  })

  const globTool = defineTool({
    name: 'glob',
    description:
      'Find files whose paths match a glob pattern. Returns matching file paths — never ' +
      'directories — including hidden and ignored files (VCS metadata directories are ' +
      `excluded). Up to ${resolved.globMaxResults} paths come back in modification-time order; ` +
      `a larger result returns the first ${resolved.globMaxResults} paths in modification-time ` +
      'order, says so, and reports where the complete sorted list was saved. This tool does ' +
      'not enumerate directory entries.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description:
          'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). ' +
          'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both ' +
          'search the whole tree; include a separator to anchor the depth.',
      },
      path: {
        type: 'string',
        description:
          'Directory to search in. Defaults to the session workspace; a relative path ' +
          'resolves against it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: { root: string; paths: string[] }) => [{
        type: 'text' as const,
        text: formatGlobOutput(
          sampleAcrossTopLevel(value.paths, resolved.globMaxResults, value.root),
          value.paths.length,
          undefined,
        ),
      }],
    },
    async execute(args: { pattern: string; path?: string }, exec: { signal?: AbortSignal }) {
      const input = parseGlobArgs(args)
      const root = input.path ?? process.cwd()
      const { paths } = await globSearch(fs, root, input.pattern, {
        // glob 传 --no-ignore --hidden：既搜隐藏文件，也**不**遵守 .gitignore。
        // 与 grep 完全相反，见下——这是从 dsh 实际传给 ripgrep 的 argv 读出来的。
        excludeDirs: GLOB_VCS_EXCLUDES,
        skipHidden: false,
        respectGitignore: false,
        limits,
        signal: exec.signal,
      })
      return { root, paths }
    },
  })

  const grepTool = defineTool({
    name: 'grep',
    description:
      'Search file contents with a ripgrep regular expression. Returns matching lines with ' +
      `line numbers, grouped by file. Returns the first ${resolved.grepMaxMatches} matches ` +
      'inline; a capped result reports where the complete match list was saved. Use read on ' +
      'a matched file for surrounding context.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Regular expression to search for (ripgrep syntax).',
      },
      path: {
        type: 'string',
        description:
          'File or directory to search. Defaults to the session workspace; a relative path ' +
          'resolves against it.',
      },
      include: {
        type: 'string',
        description:
          'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a ' +
          'list; negation is not supported.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: { matches: GrepMatch[] }) => {
        const retainer = new ItemRetainer<GrepMatch>({ kind: 'head', maxItems: resolved.grepMaxMatches })
        for (const m of value.matches) retainer.push(m)
        return [{ type: 'text' as const, text: formatGrepOutput(retainer.finish(), undefined) }]
      },
    },
    async execute(args: { pattern: string; path?: string; include?: string }, exec: { signal?: AbortSignal }) {
      const input = parseGrepArgs(args)
      const root = input.path ?? process.cwd()
      const { matches } = await grepSearch(fs, root, input.pattern, {
        // grep 什么忽略相关的 flag 都不传，走 ripgrep 默认：跳过隐藏文件
        // **且遵守 .gitignore**。与 glob 完全相反。
        excludeDirs: GLOB_VCS_EXCLUDES,
        skipHidden: true,
        respectGitignore: true,
        limits,
        signal: exec.signal,
        include: input.include,
        maxMatches: resolved.grepMaxMatches,
      })
      return { matches }
    },
  })

  ctx.effect(() => ctx.tools.register(globTool))
  ctx.effect(() => ctx.tools.register(grepTool))
}
