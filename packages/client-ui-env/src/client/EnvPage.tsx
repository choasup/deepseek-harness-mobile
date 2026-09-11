import { useCallback, useEffect, useMemo, useState } from 'react'
import { cls } from './styles.ts'
import { fetchInventory, type InventoryEntry } from './inventory.ts'
import { summarize } from './capability-map.ts'

/**
 * 「环境」Tab 的内容：**这台 harness 现在到底挂着什么**。
 *
 * ## 为什么是这一屏
 *
 * 在此之前这个 Tab 是一片纯白。而"这个 app 能干什么"恰恰是反复出问题的地方
 * ——工具被整段禁掉过（用户当时的原话是"感觉很弱啊"）、tool-bash 开不开取决于
 * 有没有机器、插件装载失败时界面上没有任何提示。这些事实此前只存在于启动
 * 日志里，而手机上看日志要接电脑。
 *
 * ## 数据只有一个来源，不做任何推断
 *
 * 全部来自宿主的 `pluginInventory/list`（147 条 Loader 记录）。上面那三张卡片
 * 是对这份清单的折叠，不掺任何别的信息；下面的全量列表是**逃生口**——
 * 折叠规则哪天过时了，原始记录还在那儿，不会因为我的分组而看不见。
 */
export function EnvPage() {
  const [entries, setEntries] = useState<InventoryEntry[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(undefined)
    try {
      const next = await fetchInventory(signal)
      setEntries(next)
    } catch (failure) {
      if (signal?.aborted === true) return
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [load])

  const groups = useMemo(() => (entries === undefined ? [] : summarize(entries)), [entries])

  const filtered = useMemo(() => {
    if (entries === undefined) return []
    const needle = query.trim().toLowerCase()
    if (needle === '') return entries
    return entries.filter((entry) =>
      entry.entryId.toLowerCase().includes(needle) || entry.moduleName.toLowerCase().includes(needle))
  }, [entries, query])

  if (error !== undefined) {
    return (
      <div className={cls.page}>
        <div className={cls.center}>
          <p className={cls.errorTitle}>读不到环境信息</p>
          {/* 具体错误，不是"加载失败"。这条在这个项目里反复付过代价。 */}
          <p className={cls.errorBody}>{error}</p>
          <button type="button" className={cls.button} onClick={() => { void load() }}>重试</button>
        </div>
      </div>
    )
  }

  if (entries === undefined) {
    return (
      <div className={cls.page}>
        <div className={cls.center}>
          <p className={cls.errorBody}>正在读取…</p>
        </div>
      </div>
    )
  }

  return (
    <div className={cls.page}>
      <div className={cls.scroll}>
        <section className={cls.section}>
          <h2 className={cls.sectionTitle}>能力</h2>
          {groups.map((group) => (
            <div key={group.id} className={cls.card}>
              <div className={cls.cardHead}>
                <span className={cls.cardTitle}>{group.title}</span>
                <span className={cls.badge} data-ready={group.ready ? 'true' : undefined}>
                  {group.ready ? '就绪' : '缺件'}
                </span>
              </div>
              <p className={cls.cardDetail}>{group.detail}</p>
              <div className={cls.members}>
                {group.members.map((member) => (
                  <div key={member.entryId} className={cls.member}>
                    <span className={cls.memberId}>{member.entryId.replace(/^include:/, '')}</span>
                    <span className={cls.memberState}>{stateLabel(member)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className={cls.section}>
          <h2 className={cls.sectionTitle}>全部插件</h2>
          <input
            className={cls.search}
            value={query}
            placeholder="搜索插件"
            onChange={(event) => { setQuery(event.target.value) }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className={cls.count}>
            {query.trim() === ''
              ? `${entries.length} 条，其中 ${entries.filter((entry) => entry.fiberPhase === 'active').length} 条在运行`
              : `匹配 ${filtered.length} 条`}
          </p>
          {filtered.map((entry) => (
            <div key={entry.entryId} className={cls.member}>
              <span className={cls.memberId}>{entry.entryId.replace(/^include:/, '')}</span>
              <span className={cls.memberState}>{stateLabel(entry)}</span>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}

/**
 * 一条记录的状态。
 *
 * **"关着"和"装载失败"必须分开**：前者是这个 profile 的有意选择（iOS 上
 * 起不了本地进程，一串工具是明确禁掉的），后者是真的出事了。混成一个
 * "不可用"会让唯一值得注意的那种情况淹没在二十多条正常的禁用里。
 */
function stateLabel(entry: InventoryEntry): string {
  if (!entry.enabled) return '已关闭'
  switch (entry.fiberPhase) {
    case 'active': return '运行中'
    case 'failed': return '装载失败'
    case 'pending': return '等待依赖'
    case 'loading': return '装载中'
    case 'unloading': return '卸载中'
    default: return '未挂载'
  }
}
