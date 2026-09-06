import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 补丁按**行 id** 定位，不是按包名。写错时 dsh 只打一条
 * `entry "xxx" not found` 的 warning，然后**静默无效**——补丁看起来配好了，
 * 实际那一行从没被禁用。
 *
 * 这不是假想：`@deepseek-ai/dsh-permission-presets` 的行 id 是 `permission`，
 * 而错误消息里显示的是**包名**，所以照着报错去写 id 就会踩中。
 * 当时补丁里写的 `- id: permission-presets` 全绿通过了所有既有测试，
 * 直到真的启动 dsh 才发现整棵树仍然起不来。
 *
 * 这组用例把每个禁用 id 拿去和 dsh 自己的组合对账。
 */
const DSH_ROOT = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const patchPath = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
const patchText = readFileSync(patchPath, 'utf8')

/** 我们禁用的所有行 id。 */
function disabledIds(): string[] {
  return [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*\n\s*disabled:\s*true/gm)].map((m) => m[1]!)
}

/** dsh 自己各 bundle 的 patch 里出现过的所有行 id。 */
function dshRowIds(): Map<string, string> {
  const found = new Map<string, string>()
  for (const bundle of ['dsh-base', 'dsh-headless', 'dsh-web-app']) {
    const p = `${DSH_ROOT}/${bundle}/cordis.patch.yml`
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const m of text.matchAll(/-\s*id:\s*(\S+)\s*\n\s*name:\s*'([^']+)'/g)) {
      if (!found.has(m[1]!)) found.set(m[1]!, m[2]!)
    }
  }
  return found
}

const available = dshRowIds()
const ready = available.size > 0

/** 已知在 dsh-base+headless 组合里并未挂载、我们防御性禁用的行。 */
const KNOWN_INERT = new Set(['terminal-bash', 'tmux-context'])

describe.skipIf(!ready)('禁用的行 id 必须真实存在于 dsh 的组合中', () => {
  it('每个禁用 id 都能在 dsh 的 bundle patch 里找到（惰性行除外）', () => {
    const unknown = disabledIds().filter((id) => !available.has(id) && !KNOWN_INERT.has(id))
    expect(
      unknown,
      `这些 id 在 dsh 的任何 bundle 里都不存在，禁用会静默无效：${unknown.join(', ')}\n` +
        `提示：错误消息显示的是包名，行 id 往往不同（如包 dsh-permission-presets 的行 id 是 permission）。`,
    ).toEqual([])
  })

  it('反向对照：一个编造的 id 会被这条检查抓到', () => {
    // 证明上面那条不是恒真。
    const fake = 'permission-presets' // 真实存在的包名，但**不是**行 id
    expect(available.has(fake)).toBe(false)
    expect(available.has('permission')).toBe(true)
    expect(available.get('permission')).toBe('@deepseek-ai/dsh-permission-presets')
  })

  it('权限强制链仍在（只禁了那个设置界面的下拉框）', () => {
    const disabled = new Set(disabledIds())
    for (const id of ['fs-sandbox', 'sandbox-policy', 'approval']) {
      expect(disabled.has(id), `${id} 是权限强制链的一环，不能禁`).toBe(false)
    }
  })
})

/**
 * 上面一组防的是"禁用了一个不存在的 id"（静默无效）。
 * 这一组防的是反向的错误："插入了一个 dsh 已经插过的 id"——
 * `insert` 列表是拼接的，重复 id 会抛 `duplicate loader entry id: X`，
 * 让整棵插件树起不来。storage 三层就是这么栽的：它们本来写在这个 bundle 里，
 * 单独用 dsh-headless 时没事，一跟 dsh-web-app 叠起来就崩。
 */
describe.skipIf(!ready)('插入的行 id 不能与 dsh 自己的行冲突', () => {
  /** 本补丁 insert 块里新增的所有行 id。 */
  function insertedIds(): string[] {
    const block = patchText.slice(patchText.indexOf('- insert:'))
    return [...block.matchAll(/^\s{4}-\s*id:\s*(\S+)/gm)].map((m) => m[1]!)
  }

  it('没有一个新增 id 已经存在于 dsh 的 bundle 里', () => {
    const clashes = insertedIds().filter((id) => available.has(id))
    expect(
      clashes,
      `这些 id 在 dsh 的 bundle 里已经有了：${clashes.join(', ')}\n` +
        `insert 是拼接不是覆盖，重复会抛 duplicate loader entry id，整棵树起不来。\n` +
        `如果这一层确实是本组合缺的（如 dsh-headless 没有 storage），它属于 profile 级补丁，不属于 bundle。`,
    ).toEqual([])
  })

  it('反向对照：storage 确实是 dsh 自己插过的 id', () => {
    // 证明上面那条不是恒真——storage 正是当初造成 duplicate 的那个 id。
    expect(available.has('storage')).toBe(true)
  })
})

/**
 * `mobile-app` 只是一个"带 YAML 补丁的 bundle"，不能把另外三个包声明成自己的
 * 依赖——两个理由，第二个是硬的：
 *
 * 1. 补丁里的插件路径是 `./node_modules/@dsh-mobile/…`，由 loader 相对
 *    **profile 的 baseUrl** 解析。装在 `mobile-app` 自己 node_modules 里的
 *    嵌套副本永远不会被加载，纯属误导。
 * 2. 这三个包在仓库里是 `workspace:*`。一旦这么写进 dependencies，用户在自己
 *    的 profile 目录里跑 `pnpm install` 就会失败：
 *    `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND: "@dsh-mobile/tool-fs-search@workspace:*"
 *    is in the dependencies but no package named ... is present in the workspace`
 *    ——profile 目录不是这个 workspace 的一部分。已经真的踩过一次。
 *
 * 依赖关系归 profile：README 的安装步骤要求四个包都列为 profile 的直接依赖。
 */
describe('mobile-app 不声明任何 @dsh-mobile 运行时依赖', () => {
  it('package.json 里没有 dependencies 指向兄弟包', () => {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const siblings = Object.keys(pkg.dependencies ?? {}).filter((n) => n.startsWith('@dsh-mobile/'))
    expect(
      siblings,
      `这些依赖会让用户 profile 里的 pnpm install 失败（workspace:* 在 profile 目录解析不到），\n` +
        `而且嵌套副本根本不会被加载——补丁走的是 profile 的 node_modules：${siblings.join(', ')}`,
    ).toEqual([])
  })
})
