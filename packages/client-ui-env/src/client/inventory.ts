/**
 * 读宿主当前**真正挂着**哪些插件。
 *
 * ## 为什么走裸 fetch
 *
 * dsh 客户端的 `ctx.remote.<命名空间>` 要求那个命名空间的 typert 生成产物在
 * 浏览器侧被 mount 过；`pluginInventory` 的生成产物并不在 web shell 的挂载
 * 清单里。而它的网关端点本身是通的——`POST /api/pluginInventory/list`，
 * 同源、无鉴权（实测 200，147 条）。用的是 dsh 自己的线上格式，不是绕路。
 *
 * 代价写在这里：**如果哪天 dsh 给 /api 加了鉴权或改了帧格式，这里会先坏。**
 * 坏法是明确的（HTTP 非 200 或 ok:false），不会静默返回空列表。
 */

/** 一条 Loader 条目。字段名与宿主的 PluginInventoryEntry 对齐。 */
export interface InventoryEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  /** 'active' | 'pending' | 'loading' | 'failed' | 'unloading'，未挂载时为 null。 */
  fiberPhase: string | null
}

/** 读取失败时带上**能推进排查的信息**，不是一句"加载失败"。 */
export class InventoryError extends Error {}

export async function fetchInventory(signal?: AbortSignal): Promise<InventoryEntry[]> {
  let response: Response
  try {
    response = await fetch('/api/pluginInventory/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `env-${Date.now()}`,
        method: 'pluginInventory/list',
        // 空参也必须带 args：网关对缺少它的请求报
        // "Remote payload must contain exactly one plain-object args field"。
        payload: { args: {} },
      }),
      signal,
    })
  } catch (error) {
    throw new InventoryError(`连不上宿主：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new InventoryError(`宿主返回 HTTP ${response.status}`)

  const frame = await response.json() as {
    result?: { ok?: boolean, value?: { entries?: InventoryEntry[] }, error?: { code?: string, message?: string } }
  }
  if (frame.result?.ok !== true) {
    const error = frame.result?.error
    throw new InventoryError(`${error?.code ?? 'unknown'}: ${error?.message ?? '宿主没有说明原因'}`)
  }
  return frame.result.value?.entries ?? []
}
