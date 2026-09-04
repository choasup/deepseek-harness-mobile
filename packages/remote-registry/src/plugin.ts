// cordis 接线（Task 10）。这是唯一对 zod、dsh-storage-domain、
// dsh-credentials 有硬运行时依赖的文件——特意不从 index.ts re-export，
// 走 `@dsh-mobile/remote-registry/plugin` 这个独立子路径导出。见
// index.ts 顶部注释与 Task 10 复审 I2：shell-ssh/src/connection.ts 只
// 需要 index.ts barrel 里的 isMissingCredentialError/normalizeFingerprint
// 这两个纯类型守卫/纯函数，不该被迫连带加载这个文件的依赖链。
import type { Context } from '@deepseek-ai/cordis'
import z from 'zod'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteRegistry, type RegistryStore } from './registry.ts'
import type { RemoteMachine } from './types.ts'

export const name = 'remote-registry'
export const inject = ['storageDomain', 'credentials']

declare module '@deepseek-ai/cordis' {
  interface Context {
    remotes: RemoteRegistry
  }
}

/**
 * 机器记录的 zod schema。dsh 的 storage-domain 用 zod 4 校验表值
 * （它自己的 Config 才用 schemastery，别混）。
 */
// Task 7 复审 I3：`port: z.number()` 单独放着没有范围/整数约束时，一条
// 绕开 normalizeMachine（手改磁盘 json、未来的迁移脚本、直接调用
// putMachine）到达这里的记录可以带一个非法端口（0、负数、非整数、超过
// 65535）——`RemoteRegistry.add()`/`importUrl()` 这两条正常入口都会先过
// `normalizeMachine()`（url.ts 已经在做同样的 int + [1, 65535] 校验），
// 但域在 open() 时重新载入快照走的是这份 schema，不是 normalizeMachine。
// 一个这样的记录会一路撑到 shell-ssh 的 `client.connect()`，在那里同步
// 抛出 `ERR_SOCKET_BAD_PORT`——收紧到跟 normalizeMachine 完全一致的范围，
// 把这类记录挡在域重新载入快照（或任何绕开 add() 的写入）的那一刻。
const machineSchema = z.object({
  name: z.string(), host: z.string(), port: z.number().int().min(1).max(65535), user: z.string(),
  keyRef: z.string(), tags: z.array(z.string()),
  hostFingerprint: z.string().optional(), defaultWorkdir: z.string().optional(),
})

// 域名同时也是 backend unit 名（json 后端会拿它当文件名），dsh-storage 的
// UNIT_NAME_RE 是 /^[a-z][a-z0-9_]*$/——不允许连字符。defineDomain 在模块
// 加载时就会校验并抛出（"fails loud at the owning package's module load,
// before any medium is touched"，见 dsh-storage-domain 的文档注释），
// 'remote-registry' 这个名字实测直接炸；换成下划线形式。
const REMOTE_DOMAIN = defineDomain({
  name: 'remote_registry',
  version: 1,
  tables: { machines: domainTable<string, RemoteMachine>(machineSchema) },
})

/**
 * `deleteSecret`/`writeSecret` 在两种情况下会拒绝：
 *
 * 1. 写之前：`describe(ref).writable` 为 false——某个只读来源（本地 provider
 *    的 `env`：继承自启动 dsh 的那个 shell 的进程环境变量）正遮蔽着这个
 *    引用，`set`/`unset` 根本没有机会生效。
 * 2. 删之后：`unset()` 只能清管理态存储自己那一层。清完之后再 `describe()`
 *    一次，如果依然 `configured: true`，说明底下还有一个 `unset()` 碰不到
 *    的只读层——本地 provider 的 dotenv 兜底（`project-env`/`user-env`）
 *    正是这种层：写之前 `describe()` 会报 `writable: true`（这一层看似能
 *    写），`unset()` 也不会报错，只有清完之后再 `describe()` 一次、发现它
 *    依然 `configured: true`，才揭穿"其实什么都没清掉"。
 *
 * 两种情况都映射成这一个具名错误，而不是把 provider 的原始报错原样上抛。
 * 不是因为 provider 的消息本身不好——dsh-credentials-local 那句"unset it in
 * the shell you start dsh from instead"其实说得很清楚——而是因为跨包边界上
 * 需要一个可以 `instanceof`/`isCredentialShadowedError()` 识别的**类型**：
 * shell-ssh 和未来的设置 UI 要能把"这台机器删不掉，因为凭据被遮蔽"从别的
 * 失败里摘出来单独处理，不能靠猜某个 provider 实现细节里的错误文案。
 *
 * 为什么这里选择"拒绝删除"而不是"忽略遮蔽、照样删掉机器记录"：
 * `describe()` 只报告当前**生效**（赢了）的那一层，看不透它下面还压着
 * 什么——一个被 `env` 或 dotenv 遮蔽的引用，管理态存储里完全可能仍然躺着
 * 一份真实密钥，只是暂时不生效而已；`describe()` 不是 X 光，没法证明
 * "管理态存储这一层确实是空的"。如果这种时候仍然放行删除机器记录，就会留下
 * `remove()` 那段注释想要避免的孤儿密钥：将来一台新机器用同名/派生名的
 * keyRef 撞上来，`credentialsFor()` 会安静地把这份旧密钥当成"已配置"发出去
 * ——用旧机器的私钥去连一台新机器。拒绝删除是保守的，但保守是对的，因为
 * `describe()` 看不透遮蔽层下面到底还有没有东西。
 */
export class CredentialShadowedError extends Error {
  readonly ref: string
  readonly source: string

  constructor(ref: string, source: string) {
    super(CredentialShadowedError.describe(ref, source))
    this.name = 'CredentialShadowedError'
    this.ref = ref
    this.source = source
  }

  private static describe(ref: string, source: string): string {
    if (source === 'env') {
      return `凭据引用 '${ref}' 当前由启动 dsh 时继承的环境变量提供（只读），无法在这里修改；`
        + `请在启动 dsh 的那个 shell 里 unset ${ref} 后重试`
    }
    return `凭据引用 '${ref}' 删不掉：'${source}' 这一层仍然提供着它，托管存储只能清自己那一层；`
      + `请直接从 '${source}' 对应的 .env 文件里移除 ${ref} 后重试`
  }
}

/** 与 RemoteRegistry/shell-ssh 里的 isMissingCredentialError 对齐的类型守卫写法。 */
export function isCredentialShadowedError(value: unknown): value is CredentialShadowedError {
  return value instanceof CredentialShadowedError
}

function cloneMachine(machine: RemoteMachine): RemoteMachine {
  // Task 8 交接项 2：dsh-storage-domain 的 KvTableImpl.get()/entries() 直接把
  // 内存里那份 Map 存的对象原样交出来（见 dsh-storage-domain/lib/index.js 里
  // `get(key) { return this.records.get(key) }`，以及 KvTable 的 .d.ts 原话：
  // "returned values are the stored objects themselves (no defensive copies)
  // and must not be mutated in place"）——不是每次读都反序列化一份新对象。
  // RemoteRegistry.list()/get() 会把这个对象原样交给调用方；调用方对返回值
  // 的任何字段赋值都会直接改到域运行时的权威内存状态，下一次读到的就是被
  // 污染的数据，且完全不经过 put() 的写链、不落盘、不触发 change 事件——
  // 一次静默的、脱离一切校验与持久化路径的状态篡改。structuredClone 在这
  // 一层切断引用；RemoteMachine 的字段都是普通字符串/数字/字符串数组，可以
  // 安全地整体克隆。put() 那边也要克隆一次，见 putMachine 的注释。
  return structuredClone(machine)
}

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(REMOTE_DOMAIN)
  // Domain.close() 的生命周期文档写明"调用方拥有这个 handle，通常在自己的
  // ctx.effect disposer 里关掉它"——facility 不会替任何消费者 fiber 兜底
  // （只有 facility 自己 unmount 时才会 closeAll 兜底）。
  //
  // 这里 try/catch 是因为 `ctx.storageDomain.open()` 那次 await 期间，这个
  // fiber 有可能被上游 dispose 掉——`inject: ['storageDomain', 'credentials']`
  // 意味着只要这两个依赖之一在这段时间内重新 provide，cordis 就会 dispose
  // 并重挂这个 fiber，不需要真的 HMR。fiber 一旦已经 disposed，
  // `ctx.effect()` 会直接抛 `INACTIVE_EFFECT`，而不是把这次 open() 拿到的
  // domain 句柄挂上去——不接住这个抛出的话，domain 永远不会被关闭：它的名字
  // 会一直留在 DomainFacility 的 `reserved` 集合里，这个进程剩下的生命周期
  // 里任何人再 `ctx.storageDomain.open(REMOTE_DOMAIN)` 都会踩到
  // `DomainError: domain 'remote_registry' is already open`，且这次 dispose
  // 本身不会报任何错——完全静默、且不可逆。接住之后手动 `domain.close()`
  // 再把原始错误抛回去，让这个 fiber 该失败还是失败，但至少不泄漏 domain。
  try {
    ctx.effect(() => () => domain.close())
  } catch (error) {
    await domain.close()
    throw error
  }
  const machines = domain.table('machines')

  const store: RegistryStore = {
    // KvTable 的读是同步的（整个域在 open 时全量载入内存）；
    // 包成 Promise 只为对齐 RegistryStore 的契约。
    listMachines: async () => [...machines.entries()].map(([, m]) => cloneMachine(m)),
    putMachine: async (m) => {
      // KvTableImpl.put() 本身不校验——校验只发生在 open() 载入快照的时候
      // （见 dsh-storage-domain/lib/index.js 的 parseRecord 调用点）。这意味着
      // 一条这里没拦住的坏记录会先"成功"落盘，直到*下一次*重开这个域才会以
      // `invalid-record` 报错——那时候已经不知道是哪次写入造成的了。在写入
      // 这一刻用同一份 zod schema 重新 parse 一次，把校验失败挪回造成它的
      // 那次调用；这也是第二道、独立于 registry.ts 里 normalizeMachine 的
      // 保险——确保任何"形状像密钥"的字段都不可能是靠绕过 normalizeMachine
      // 混进来（比如未来某次重构漏调了它）而落进这个 json 文件的。
      // structuredClone 再切一次引用：KvTable.put 会原样持有调用方传进来的
      // 对象引用（见 KvTable 类型上的原话），今天安全只是因为
      // normalizeMachine 总是构造一个带独立 tags 数组的新对象——这个不变量
      // 现在活在两个包之外，不该由调用方隐式维持。
      const validated = machineSchema.parse(m)
      await machines.put(validated.name, cloneMachine(validated))
    },
    deleteMachine: async (name) => { await machines.delete(name) },
    // readSecret 原样把 resolve() 的 undefined 传上去——RemoteRegistry.credentialsFor()
    // 靠这个 undefined 才能抛出 MissingCredentialError，shell-ssh 的连接池再靠
    // isMissingCredentialError() 把它区分映射成 SSH_NO_CREDENTIAL（不同于真正
    // 认证被拒的 SSH_AUTH_FAILED）。这里不能把 resolve() 包一层 try/catch 再
    // 抛别的错误类型，否则这条跨包的错误区分链就在这一层被压扁了。
    //
    // 但 ref 在到这里之前不一定走过 normalizeMachine/keyRefForName——手工改过
    // 磁盘上 json 文件的 keyRef 字段会绕开这条校验路径，直接从 domain 的
    // loadAll() 反序列化出来。credentialRef() 对不合法的名字抛的是一个裸
    // TypeError，跟 MissingCredentialError 完全是两回事，会在这里把上面那条
    // 错误区分链意外压扁成一个未分类的 TypeError。dsh-credentials 自己文档
    // 里给的方案就是 isCredentialRefName()：名字不合法时当成"从没配置过"处理
    // （返回 undefined），而不是抛出——对调用方（credentialsFor）来说这两种
    // 情况本来就应该得到同一个结果：MissingCredentialError。
    readSecret: async (ref) => {
      if (!isCredentialRefName(ref)) return undefined
      return (await ctx.credentials.resolve(credentialRef(ref)))?.value
    },
    writeSecret: async (ref, value) => {
      const key = credentialRef(ref)
      const info = await ctx.credentials.describe(key)
      if (!info.writable) throw new CredentialShadowedError(ref, info.source ?? 'unknown')
      await ctx.credentials.set(key, value)
    },
    deleteSecret: async (ref) => {
      const key = credentialRef(ref)
      const before = await ctx.credentials.describe(key)
      if (!before.writable) throw new CredentialShadowedError(ref, before.source ?? 'unknown')
      await ctx.credentials.unset(key)
      // unset() 只能清管理态存储自己那一层；dotenv 兜底层（project-env/
      // user-env）在写之前的 describe() 里会谎报 writable:true，且 unset()
      // 对它无效也不报错。清完之后再照一次镜子：如果这个 ref 仍然
      // configured，说明底下那层没被清掉，必须响亮地失败，而不是让调用方
      // （尤其是 registry.add() 里那次"清空新机器 keyRef 槽位"的调用）以为
      // 已经清空了。
      const after = await ctx.credentials.describe(key)
      if (after.configured) throw new CredentialShadowedError(ref, after.source ?? 'unknown')
    },
  }

  // ctx.set() 要求这个属性此前已经用 ctx.provide() 声明过，否则抛
  // `cannot set property "remotes" without provide`（cordis/lib/index.js
  // 的 ReflectService#set：`if (!impl) throw new Error(...)`；对着一个从没
  // provide 过的 Context 实测过，确实炸）。`remotes` 是这个插件第一次把它
  // 挂到 ctx 上，该用 provide，不是 set——storage-domain 自己注册
  // `storageDomain` 服务时也是 `ctx.provide('storageDomain', facility)`
  // 这个写法，不是 set。provide() 内部把注册包成这个 fiber 的一个 effect，
  // disposer 会在 unmount 时把 'remotes' 从 ctx 上摘掉；用裸 set 的话则会
  // 在这个插件被 dispose 之后留下一个指向已经失效的 RemoteRegistry 的僵尸
  // 属性，没有任何东西会把它清掉。
  ctx.provide('remotes', new RemoteRegistry(store))
}
