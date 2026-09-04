// 只做静态断言：解析 cordis.patch.yml 本身（不起真的 dsh/cordis Context——
// 端到端组合验证是 Task 13 的 `dump-config.test.ts`，需要本机装好真的 dsh
// 才跑）。用跟 `@deepseek-ai/dsh-app-boot` 完全一致的 YAML 方言解析这份
// 文件——同一个自定义 `!!js` scalar 类型、同一个 `JSON_SCHEMA.extend()`
// 基底（见该包 `lib/index.js` 里的 `entryListSchema`）——这样"这份文件能被
// js-yaml 用生产环境实际使用的 schema 解析成功"本身也是一条断言，不只是
// 图方便的巧合。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'

const patchPath = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
const patchText = readFileSync(patchPath, 'utf8')

/** 跟 dsh-app-boot 的 `entryListSchema` 同一个 `!!js` scalar 类型定义。 */
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
})
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)

interface PatchRow {
  id?: string
  name?: string
  disabled?: unknown
  config?: unknown
  insert?: PatchRow[]
  [key: string]: unknown
}

const patch = yaml.load(patchText, { schema: entryListSchema }) as PatchRow[]

/** 顶层数组里 `disabled: true` 的条目——覆盖既有行用的形状，不是 insert。 */
function disabledIds(): string[] {
  return patch.filter((entry) => entry.disabled === true).map((entry) => entry.id as string)
}

/** 所有 `insert:` 块里新增的行，跨多个顶层 insert 条目拍平。 */
function insertedRows(): PatchRow[] {
  return patch.flatMap((entry) => (Array.isArray(entry.insert) ? entry.insert : []))
}

/** 递归找一个键名——用来断言解析后的结构里完全没有 `isolate`，而不是抠字符串。 */
function findKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => findKeyDeep(item, key))
  if (value && typeof value === 'object') {
    if (key in (value as Record<string, unknown>)) return true
    return Object.values(value as Record<string, unknown>).some((v) => findKeyDeep(v, key))
  }
  return false
}

/** `- id: <id>` 那一行前面、跳过空行后的第一行是不是注释。 */
/**
 * 严格相邻：`- id: <id>` 正上方那一行本身必须是注释，中间不允许隔一个空行。
 *
 * 原来的版本会跳过空行去找"最近的非空行"，结果一段跟这个 id 毫无关系的
 * 分组标题注释（比如"── A''. ……──"）只要离得够近、中间只隔了一个空行，
 * 也会被当成"有说明"——用一次真实变异验证过这个漏洞：把 tmux-context
 * 那条具体说明整段删空、只留上面隔着一个空行的分组标题，旧版本的检查
 * 仍然判定"有注释"。这条测试要的是"每一个禁用条目自己带着专门的理由"，
 * 不是"这附近某处曾经出现过一个 #"，所以改成零容忍的相邻检查。
 */
function hasPrecedingComment(id: string): boolean {
  const lines = patchText.split('\n')
  const target = lines.findIndex((line) => line.trim() === `- id: ${id}`)
  if (target === -1 || target === 0) return false
  return lines[target - 1].trim().startsWith('#')
}

const MUST_DISABLE = [
  'subprocess',
  'bash-sandbox',
  'pwsh-sandbox',
  'terminal-bash',
  'tool-bash',
  'tool-pwsh',
  'tmux-context',
  'sandbox',
]

const MUST_STAY_ENABLED = [
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
  'tool-todo',
  'tool-web',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'skill',
  'jobs',
]

describe('mobile profile 补丁：cordis.patch.yml 能被生产环境的 !!js 方言解析', () => {
  it('顶层是一个数组', () => {
    expect(Array.isArray(patch)).toBe(true)
  })
})

describe('A. 禁用所有依赖本地进程的行', () => {
  const disabled = disabledIds()

  it.each(MUST_DISABLE)('%s 被禁用', (id) => {
    expect(disabled).toContain(id)
  })

  it('禁用清单里没有多余或拼写错误的 id', () => {
    // 每个禁用条目都必须落在任务给的清单里——防止将来有人手滑改错 id
    // 却因为测试只做"contains"检查而测不出来。
    expect(disabled.sort()).toEqual([...MUST_DISABLE].sort())
  })
})

describe('B. storage 三层已插入，且行 id 与 dsh-web-app 保持一致', () => {
  const inserted = insertedRows()
  const byId = (id: string) => inserted.find((row) => row.id === id)

  it('storage / storage-json / storage-domain 都被插入', () => {
    expect(byId('storage')?.name).toBe('@deepseek-ai/dsh-storage')
    expect(byId('storage-json')?.name).toBe('@deepseek-ai/dsh-storage-json')
    expect(byId('storage-domain')?.name).toBe('@deepseek-ai/dsh-storage-domain')
  })

  it('storage-json 的 root 用 !!js dshHomePath(...) 表达式，不是写死的字符串', () => {
    const config = byId('storage-json')?.config as { root?: { __jsExpr?: string } } | undefined
    expect(config?.root?.__jsExpr).toContain('dshHomePath')
  })

  it('storage-domain 的 backend 是 json', () => {
    const config = byId('storage-domain')?.config as { backend?: string } | undefined
    expect(config?.backend).toBe('json')
  })
})

describe('C. 挂上 remote-registry 与 shell-ssh，且用 /plugin 子路径', () => {
  const inserted = insertedRows()
  const byId = (id: string) => inserted.find((row) => row.id === id)

  it('remote-registry 用 @dsh-mobile/remote-registry/plugin', () => {
    expect(byId('remote-registry')?.name).toBe('@dsh-mobile/remote-registry/plugin')
  })

  it('shell-ssh 用 @dsh-mobile/shell-ssh/plugin', () => {
    expect(byId('shell-ssh')?.name).toBe('@dsh-mobile/shell-ssh/plugin')
  })

  it('两行的 name 都不是裸包名（不能没有 /plugin 后缀）', () => {
    expect(byId('remote-registry')?.name).not.toBe('@dsh-mobile/remote-registry')
    expect(byId('shell-ssh')?.name).not.toBe('@dsh-mobile/shell-ssh')
  })

  it('shell-ssh 默认启用——查不到机器时它自己不再 throw，不需要靠 disabled 兜底', () => {
    // shell-ssh 的 apply() 改过：machine 查不到时记一条 warn、正常返回，
    // 不注册 ctx.shell，不再 throw SSH_NO_MACHINE。挂载这一行本身永远
    // 成功，所以不需要像之前那样默认 disabled 来防止拖垮整棵插件树。
    // 见 cordis.patch.yml 里这一行上方的大段注释。
    expect(byId('shell-ssh')?.disabled).toBeUndefined()
  })

  it('remote-registry 默认不禁用——挂着一个空注册表本身不会报错，需要它随时可用', () => {
    expect(byId('remote-registry')?.disabled).toBeUndefined()
  })
})

describe('保留纯 JS 的工具行——不出现在禁用清单里', () => {
  const disabled = disabledIds()

  it.each(MUST_STAY_ENABLED)('%s 没有被禁用', (id) => {
    expect(disabled).not.toContain(id)
  })
})

describe('每个禁用条目前面都有说明为什么的注释', () => {
  it.each(MUST_DISABLE)('%s 前面紧跟着一行注释', (id) => {
    expect(hasPrecedingComment(id)).toBe(true)
  })
})

describe('补丁里完全没有声明 isolate', () => {
  it('解析后的结构里找不到任何 isolate 键', () => {
    // Task 7 的结论：隔离严格 opt-in，对 remotes/credentials/shell/
    // systemPrompt 这些共享服务名声明 isolate 会把它们意外隔离出这棵树。
    // 用解析后的结构而不是原始文本找——本文件的说明性注释里大量出现了
    // "isolate" 这个词本身，纯文本搜索会被自己的注释误伤。
    expect(findKeyDeep(patch, 'isolate')).toBe(false)
  })
})
