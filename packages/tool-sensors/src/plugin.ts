import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * `list_device_sensors` / `read_device_sensors`：把手机的传感器交给模型。
 *
 * ## 为什么需要它
 *
 * 这个形态的说法是「手机是大脑和感官」，但在此之前"感官"只有相机。模型被问到
 * "你能感知到手机上有哪些传感器"时，答的是"感知不到，我运行在文件沙盒里"。
 * **那句话本身没说错**：Node 侧确实没有任何硬件接口。缺的是一座桥。
 *
 * ## 为什么是两个工具而不是一个
 *
 * "有哪些传感器"应该能**便宜地**回答：不采样、不弹权限框、不耗电。
 * 把它和"读数"合成一个工具，模型为了回答前一个问题就得触发后一个的全部代价
 * ——包括一个本来不必弹的定位授权框。
 *
 * ## 定位不在默认集合里
 *
 * `read_device_sensors` 不点名时读的是设备信息、电池、运动、气压、活动状态：
 * 都不弹框、也不涉及位置。精确坐标要模型**显式**写进 `sensors` 才会去取，
 * 那一步会弹系统授权框，由用户决定。
 */
export const inject = ['tools']

/** 桥的地址由原生侧通过环境变量给出；没有它就说明这一版没带原生桥。 */
const BRIDGE = process.env.DSH_NATIVE_BRIDGE

/**
 * 就地写一份 JSON 值的类型，而不是从 `@deepseek-ai/dsh-session` 导入。
 * 那样要为一个纯类型加一条运行时依赖，而这个包在设备上是**实体拷贝**进
 * bundle 的——多一条依赖就多一份可能没被拷进去的东西。
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export function apply(ctx: Context): void {
  // 没有桥就**不注册**这两个工具，而不是注册必然失败的。
  // 模型的工具目录里出现每次都报错的工具，比没有这个工具更糟。
  if (BRIDGE === undefined) {
    ctx.logger?.info?.('tool-sensors: 未设置 DSH_NATIVE_BRIDGE，跳过传感器工具注册')
    return
  }

  const listTool = defineTool({
    name: 'list_device_sensors',
    description:
      'List which sensors this phone has and which are readable, without ' +
      'sampling anything or triggering any permission prompt. Returns each ' +
      "sensor's name, what it measures, whether it is available, and — when it " +
      'is not — why. Call this before read_device_sensors when you need to know ' +
      'what the device can sense.',
    parameters: {},
    output: {
      schema: { type: 'json' } as const,
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: JSON.stringify(value, null, 2) },
      ],
    },
    async execute() {
      return await request('/sensors/inventory')
    },
    presentCall() {
      return { card: 'generic' as const, title: '查看设备传感器清单', kind: 'read' as const }
    },
  })

  const readTool = defineTool({
    name: 'read_device_sensors',
    description:
      'Take a one-shot reading from the phone sensors. Each reading is a single ' +
      'snapshot, not a stream — call again later to see how a value changed. ' +
      'Names: device (model, OS, screen, brightness, thermal, memory, disk), ' +
      'battery, motion (accelerometer, gyroscope, magnetometer, attitude, heading), ' +
      'barometer, pedometer (steps today), activity (stationary/walking/running/' +
      'cycling/automotive), location, proximity. Omit `sensors` to read ' +
      'device, battery, motion, barometer and activity. ' +
      'location asks the user for permission the first time and returns precise ' +
      'coordinates, so request it only when the task actually needs where the ' +
      'user is. proximity may briefly blank the screen. Unavailable sensors come ' +
      'back with available:false and a reason rather than a fabricated value.',
    parameters: {
      sensors: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description:
          'Sensor names to read. Omit for the default set (no location, no proximity).',
      },
    },
    output: {
      schema: { type: 'json' } as const,
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: JSON.stringify(value, null, 2) },
      ],
    },
    async execute(args: { sensors?: string[] }) {
      const kinds = (args.sensors ?? []).join(',')
      return await request(`/sensors/read?kinds=${encodeURIComponent(kinds)}`)
    },
    presentCall(args: { sensors?: string[] }) {
      const named = args.sensors?.length ? args.sensors.join('、') : '默认一组'
      return { card: 'generic' as const, title: `读取传感器：${named}`, kind: 'read' as const }
    },
  })

  async function request(path: string): Promise<JsonValue> {
    const response = await fetch(`${BRIDGE}${path}`, { method: 'POST' })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      // 原因写进 host 日志：否则它只出现在模型的对话里，而排查的人在另一头。
      const message = `读取传感器失败（HTTP ${response.status}）：${detail.slice(0, 200)}`
      console.log(`[tool-sensors] ${message}`)
      throw new Error(message)
    }
    return (await response.json()) as JsonValue
  }

  ctx.effect(() => ctx.tools.register(listTool))
  ctx.effect(() => ctx.tools.register(readTool))
}
