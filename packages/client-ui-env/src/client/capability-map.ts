import type { InventoryEntry } from './inventory.ts'

/**
 * 把 147 条 Loader 记录折成**几句人话**。
 *
 * ## 措辞上的一条硬规矩
 *
 * 这些结论只能说插件清单真的能证明的事。`shell-ssh` 处于 active，证明的是
 * "这个插件挂上了"，**不等于** SSH 握得上手、认证过得去、命令跑得动——今天
 * 刚为这个区别付过代价：poly1305 补丁写好、测过、就是没被调用，日志里一切
 * 正常，症状要等用户按下发送键才出现。
 *
 * 所以下面一律用"已挂载 / 未挂载"这种能被清单证实的说法，绝不写"已连接"。
 * 真正的连通性只有启动日志里的 [remote-smoke] 那一行能回答。
 */

/** 一组能力的判定结果。 */
export interface CapabilityGroup {
  id: string
  title: string
  /** 这一组算不算"齐了"。 */
  ready: boolean
  /** 一句话说明——齐了说明它现在能干什么，缺了说明缺哪一条。 */
  detail: string
  /** 参与判定的条目，展开时显示。 */
  members: InventoryEntry[]
}

/** 判定一条：必须 enabled 且 fiber 处于 active。 */
function live(entry: InventoryEntry | undefined): boolean {
  return entry?.enabled === true && entry.fiberPhase === 'active'
}

interface GroupSpec {
  id: string
  title: string
  /** entryId 结尾匹配（真实 id 带 `include:` 前缀）。 */
  ids: string[]
  /** 全部就位时的说明。 */
  readyDetail: string
  /** 缺件时的说明，`{missing}` 会被换成缺的那几条。 */
  missingDetail: string
}

const GROUPS: GroupSpec[] = [
  {
    id: 'remote',
    title: '远程执行',
    ids: ['shell-ssh', 'remote-registry', 'remote-bootstrap', 'tool-bash'],
    // 措辞见文件头：清单只能证明"挂上了"。
    readyDetail: '远程 shell 已挂载，bash 工具已开。真正连没连上，看启动日志里的 remote-smoke 那一行。',
    missingDetail: '缺 {missing}。缺任意一条，模型都拿不到可用的 bash。',
  },
  {
    id: 'device',
    title: '手机能力',
    ids: ['tool-camera', 'tool-sensors'],
    readyDetail: '相机与传感器可用。在输入条上点"手机能力"那个图标就能用。',
    missingDetail: '缺 {missing}。',
  },
  {
    id: 'files',
    title: '文件与检索',
    ids: ['tool-fs', 'tool-str-replace-editor', 'tool-fs-search-js', 'tool-web'],
    readyDetail: '读写文件、按内容检索、抓网页都可用。',
    missingDetail: '缺 {missing}。',
  },
]

/**
 * 按 entryId 精确取一条。真实 id 形如 `include:shell-ssh`，
 * 但这个前缀是 Loader 的分组路径，不该写死在业务判定里。
 */
function pick(entries: InventoryEntry[], id: string): InventoryEntry | undefined {
  return entries.find((entry) => entry.entryId === id || entry.entryId.endsWith(`:${id}`))
}

export function summarize(entries: InventoryEntry[]): CapabilityGroup[] {
  return GROUPS.map((spec) => {
    const members = spec.ids
      .map((id) => pick(entries, id))
      .filter((entry): entry is InventoryEntry => entry !== undefined)
    const missing = spec.ids.filter((id) => !live(pick(entries, id)))
    // 清单里**根本没有**这一行，也算缺——而且要能看出来是"没有"而不是"关着"。
    return {
      id: spec.id,
      title: spec.title,
      ready: missing.length === 0,
      detail: missing.length === 0
        ? spec.readyDetail
        : spec.missingDetail.replace('{missing}', missing.join('、')),
      members,
    }
  })
}
