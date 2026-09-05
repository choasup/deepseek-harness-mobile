import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 漂移检测。
 *
 * 我们没有复用 dsh 的 `applyGlobTool`/`applyGrepTool`（它们内部直接
 * `runRipgrep`，没有可注入执行器的缝），也刻意没有伪造 `ctx.subprocess`
 * 来骗过它们——那等于声称一个 iOS 上不存在的能力。代价是我们自己写了一份
 * 工具定义，可能与 dsh 漂移。
 *
 * 这组用例把两边的定义拿去逐字段比对：工具名、参数名、必填性、输出 schema。
 * dsh 升级后如果改了这些，这里会红——而不是等到模型收到一个形状不同的工具。
 *
 * 注意**不比对 description 文本**：它带着 maxResults 之类的数字，而我们的
 * 上限是可配置的。比名字和 schema 才是真正影响模型调用的部分。
 */
const DSH = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const ready = existsSync(`${DSH}/dsh-tool-fs-search/lib/index.js`)

/** 用一个最小的假 ctx 收集某个 apply 注册出的工具定义。 */
async function collectTools(
  applyFn: (ctx: unknown, caps: unknown) => void,
  caps: unknown,
): Promise<Map<string, Record<string, unknown>>> {
  const tools = new Map<string, Record<string, unknown>>()
  const ctx = {
    systemPrompt: { section: () => {} },
    tools: {
      register(def: Record<string, unknown>) {
        tools.set(def.name as string, def)
        return () => {}
      },
    },
    effect: (fn: () => unknown) => { fn() },
    on: () => () => {},
    get: () => undefined,
    fs: {
      listDir: async () => [],
      readBytes: async () => new Uint8Array(),
      stat: async () => ({ mtimeMs: 0 }),
    },
  }
  await applyFn(ctx, caps)
  return tools
}

/** 只取影响模型调用的部分：名字、参数、输出 schema。 */
function callShape(def: Record<string, unknown>): unknown {
  const params = (def.parameters ?? {}) as Record<string, { type: string; required?: boolean }>
  return {
    name: def.name,
    parameters: Object.fromEntries(
      Object.entries(params)
        .map(([k, v]) => [k, { type: v.type, required: v.required === true }])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    output: (def.output as { schema?: unknown } | undefined)?.schema,
  }
}

describe.skipIf(!ready)('与 dsh 的工具定义对齐', () => {
  it('glob 与 grep 的调用形状与 dsh 逐字段一致', async () => {
    const dsh = await import(`${DSH}/dsh-tool-fs-search/lib/index.js`) as {
      applyGlobTool: (ctx: unknown, caps: unknown) => void
      applyGrepTool: (ctx: unknown, caps: unknown) => void
      GLOB_MAX_RESULTS: number
      GREP_MAX_MATCHES: number
      GREP_MAX_LINE_BYTES: number
    }
    const capsCommon = {
      maxMetaBytes: 4096, rawOutputMaxBytes: 1 << 20,
      graceMs: 100, stderrMaxBytes: 4096, timeoutMs: 30_000,
    }
    const theirs = new Map([
      ...(await collectTools(dsh.applyGlobTool, {
        ...capsCommon, sampleOverCapGlobResults: false, maxResults: dsh.GLOB_MAX_RESULTS,
      })),
      ...(await collectTools(dsh.applyGrepTool, {
        ...capsCommon, maxMatches: dsh.GREP_MAX_MATCHES, maxLineBytes: dsh.GREP_MAX_LINE_BYTES,
      })),
    ])

    const mine = await collectTools(
      (await import('../../src/plugin.ts')).apply as (c: unknown, k: unknown) => void,
      {},
    )

    expect([...mine.keys()].sort()).toEqual(['glob', 'grep'])
    for (const toolName of ['glob', 'grep']) {
      expect(callShape(mine.get(toolName)!), `${toolName} 的调用形状与 dsh 不一致`)
        .toEqual(callShape(theirs.get(toolName)!))
    }
  })

  it('反向对照：改掉一个参数名会被这条检查抓到', async () => {
    // 证明上面那条不是恒真。
    const a = callShape({ name: 'glob', parameters: { pattern: { type: 'string', required: true } } })
    const b = callShape({ name: 'glob', parameters: { patern: { type: 'string', required: true } } })
    expect(a).not.toEqual(b)
  })

  it('系统提示词的 order 与 dsh 一致（103 / 104）', async () => {
    const sections: Array<{ name: string; order: number }> = []
    const ctx = {
      systemPrompt: { section: (s: { name: string; order: number }) => sections.push(s) },
      tools: { register: () => () => {} },
      effect: (fn: () => unknown) => { fn() },
      on: () => () => {},
      get: () => undefined,
      fs: { listDir: async () => [], readBytes: async () => new Uint8Array(), stat: async () => ({}) },
    }
    const { apply } = await import('../../src/plugin.ts')
    ;(apply as (c: unknown, k: unknown) => void)(ctx, {})
    expect(sections.find((s) => s.name === 'tool:glob')?.order).toBe(103)
    expect(sections.find((s) => s.name === 'tool:grep')?.order).toBe(104)
  })
})
