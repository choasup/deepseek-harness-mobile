// 包的公开入口。package.json 的 main/exports 都指向这个文件——之前只有
// types.ts 和 url.ts 存在，没有汇总导出，下游包（如 shell-ssh）没法
// `import type { RemoteMachine, SshCredentials } from '@dsh-mobile/remote-registry'`。
export type { RemoteMachine, SshCredentials } from './types.ts'
export {
  REMOTE_URL_SCHEME,
  RemoteUrlError,
  formatRemoteUrl,
  keyRefForName,
  normalizeFingerprint,
  normalizeMachine,
  parseRemoteUrl,
} from './url.ts'
export type { RemoteUrlErrorCode } from './url.ts'
export {
  DuplicateKeyRefError,
  DuplicateMachineError,
  isMissingCredentialError,
  MissingCredentialError,
  RemoteRegistry,
  UnknownMachineError,
} from './registry.ts'
export type { RegistryStore } from './registry.ts'
export { PROBE_STAGES, probeMachine } from './probe.ts'
export type {
  FingerprintStatus,
  ProbeDeps,
  ProbeOptions,
  ProbeReport,
  ProbeStage,
  ProbeStageResult,
} from './probe.ts'

// ---------------------------------------------------------------------------
// cordis 接线（Task 10）。上面全是纯 barrel re-export；从这里开始才是把
// RemoteRegistry 接到 dsh 真实存储/凭据服务的插件定义。
// ---------------------------------------------------------------------------

import type { Context } from '@deepseek-ai/cordis'
import z from 'zod'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
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
const machineSchema = z.object({
  name: z.string(), host: z.string(), port: z.number(), user: z.string(),
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
 * `CredentialProvider.set`/`unset` 拒绝对着一个被启动环境只读遮蔽的引用写入
 * （见 dsh-credentials-local 的 `assertUnshadowed`：真实实现在这种情况下抛的
 * 是一句私有实现细节的 `Error`，消息文本不是这个包的契约，不该在这里靠字符串
 * 匹配去识别它）。改用 `describe(ref).writable` 在写之前判断——这正是
 * dsh-credentials 文档里说的用途："describe().writable 让 UI 提前把这个引用
 * 渲染成只读"——判断为 false 时直接抛一个具名错误，把补救办法（去启动 dsh 的
 * 那个 shell 里 unset 掉这个环境变量）说清楚，而不是把 provider 的内部报错
 * 原样透传给调用方。
 *
 * Task 8 交接项 1：registry.remove() 是"先删密钥、再删机器记录"，遮蔽存在时
 * deleteSecret 会在 deleteMachine 之前抛出——那是刻意的安全取舍（宁可留一条
 * 删不掉密钥的机器记录，也不留一把可能被张冠李戴的孤儿密钥），这里不去绕开
 * 这个顺序，只是把抛出的错误换成能看懂、能照着做的。
 */
export class CredentialShadowedError extends Error {
  readonly ref: string

  constructor(ref: string) {
    super(
      `凭据引用 '${ref}' 当前由启动 dsh 时继承的环境变量提供（只读），无法在这里修改；`
      + `请在启动 dsh 的那个 shell 里 unset ${ref} 后重试`,
    )
    this.name = 'CredentialShadowedError'
    this.ref = ref
  }
}

/** 与 RemoteRegistry/shell-ssh 里的 isMissingCredentialError 对齐的类型守卫写法。 */
export function isCredentialShadowedError(value: unknown): value is CredentialShadowedError {
  return value instanceof CredentialShadowedError
}

function cloneMachine(machine: RemoteMachine): RemoteMachine {
  // Task 8 交接项 2：dsh-storage-domain 的 KvTableImpl.get()/entries() 直接把
  // 内存里那份 Map 存的对象原样交出来（见 dsh-storage-domain/lib/index.js 里
  // `get(key) { return this.records.get(key) }`）——不是每次读都反序列化一份
  // 新对象。RemoteRegistry.list()/get() 会把这个对象原样交给调用方；调用方
  // 对返回值的任何字段赋值都会直接改到域运行时的权威内存状态，下一次读到的
  // 就是被污染的数据，且完全不经过 put() 的写链、不落盘、不触发 change 事件
  // ——一次静默的、脱离一切校验与持久化路径的状态篡改。structuredClone 在这
  // 一层切断引用；RemoteMachine 的字段都是普通字符串/数字/字符串数组，可以
  // 安全地整体克隆。
  return structuredClone(machine)
}

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(REMOTE_DOMAIN)
  // Domain.close() 的生命周期文档写明"调用方拥有这个 handle，通常在自己的
  // ctx.effect disposer 里关掉它"——facility 不会替任何消费者 fiber 兜底
  // （只有 facility 自己 unmount 时才会 closeAll 兜底）。不注册这个 effect
  // 的话，这个插件被重载（比如配置热更）时 domain 永远关不掉，下次
  // ctx.storageDomain.open() 会因为"already-open"直接炸。
  ctx.effect(() => () => domain.close())
  const machines = domain.table('machines')

  const store: RegistryStore = {
    // KvTable 的读是同步的（整个域在 open 时全量载入内存）；
    // 包成 Promise 只为对齐 RegistryStore 的契约。
    listMachines: async () => [...machines.entries()].map(([, m]) => cloneMachine(m)),
    putMachine: async (m) => { await machines.put(m.name, m) },
    deleteMachine: async (name) => { await machines.delete(name) },
    // readSecret 原样把 resolve() 的 undefined 传上去——RemoteRegistry.credentialsFor()
    // 靠这个 undefined 才能抛出 MissingCredentialError，shell-ssh 的连接池再靠
    // isMissingCredentialError() 把它区分映射成 SSH_NO_CREDENTIAL（不同于真正
    // 认证被拒的 SSH_AUTH_FAILED）。这里不能把 resolve() 包一层 try/catch 再
    // 抛别的错误类型，否则这条跨包的错误区分链就在这一层被压扁了。
    readSecret: async (ref) => (await ctx.credentials.resolve(credentialRef(ref)))?.value,
    writeSecret: async (ref, value) => {
      const key = credentialRef(ref)
      const info = await ctx.credentials.describe(key)
      if (!info.writable) throw new CredentialShadowedError(ref)
      await ctx.credentials.set(key, value)
    },
    deleteSecret: async (ref) => {
      const key = credentialRef(ref)
      const info = await ctx.credentials.describe(key)
      if (!info.writable) throw new CredentialShadowedError(ref)
      await ctx.credentials.unset(key)
    },
  }

  // ctx.set() 要求这个属性此前已经用 ctx.provide() 声明过，否则抛
  // `cannot set property "remotes" without provide`（cordis/lib/index.js
  // 的 ReflectService#set：`if (!impl) throw new Error(...)`；对着一个从没
  // provide 过的 Context 实测过，确实炸）。`remotes` 是这个插件第一次把它
  // 挂到 ctx 上，该用 provide，不是 set——storage-domain 自己注册
  // `storageDomain` 服务时也是 `ctx.provide('storageDomain', facility)`
  // 这个写法，不是 set。
  ctx.provide('remotes', new RemoteRegistry(store))
}
