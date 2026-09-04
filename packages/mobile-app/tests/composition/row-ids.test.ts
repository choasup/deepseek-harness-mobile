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
