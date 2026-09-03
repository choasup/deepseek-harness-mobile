// 装配一个真的 cordis Context 跑本包的接线：dsh 的存储三层栈（storage 中枢
// + json 文件后端 + storage-domain）走真实实现，凭据侧用内存替身——参考
// /Users/choas/Solution/Tencent-ADP-dsh-plugin/tests/mock/harness.ts 的
// MemoryCredentials 写法，但补全了这个仓库锁定的
// @deepseek-ai/dsh-credentials@0.1.1-rc.2 才有的 record 半区抽象方法
// （ADP 锁的是更老的 rc.6，还没有 readRecord/describeRecord/listRecords/
// modifyRecord/deleteRecord 这几个）。
//
// 存储侧不用内存替身，是因为 Task 8 交接项 2（"适配层不得返回缓存对象引用"）
// 本质是个序列化问题——只有真的走一遍"写 json 文件 -> 重新打开读反序列化"
// 才测得出来；纯内存 Map 双份引用永远测不出这类 bug。
//
// cordis 接线在 ../../src/plugin.ts（不是 index.ts barrel）——见 index.ts
// 顶部注释与 Task 10 复审 I2。这里直接从 plugin.ts 拿 name/inject/apply。
//
// Task 7 会复用这个夹具（在同一个 ctx 上再插 shell-ssh 的插件）。
// `bootStorageStack()` 单独导出，正是为了让 Task 7 能只借用底层存储栈、
// 自己接别的插件，不必话再重新装配一遍 Storage/json 后端/domain 表单。
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as jsonBackend from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import * as remoteRegistryPlugin from '../../src/plugin.ts'

/**
 * 内存凭据替身。两个测试专用的控制口，分别模拟 dsh-credentials-local 里两种
 * "这个引用其实不是你能改的"的只读层：
 *
 * - `shadowRef(ref, value)`：模拟 `env` 层——启动 dsh 的 shell 继承的进程
 *   环境变量。真实实现里 `describe()` 对这种引用会报 `writable: false`，
 *   `set`/`unset` 都会在写之前就拒绝（`assertUnshadowed`）。
 * - `dotenvRef(ref, value)`：模拟 `project-env`/`user-env` 兜底层——dotenv
 *   文件供的值。真实实现里 `describe()` 对这种引用照样报 `writable: true`
 *   （这一层"看起来"能写），`unset()` 也不会报错，但它只会去清管理态存储
 *   自己的文件，对 dotenv 层完全无效——`unset()` 之后再 `describe()` 一次，
 *   这个 ref 依然 `configured: true`。这正是 Task 10 复审 C1 指出的那条
 *   "适配层以为清空了、其实什么都没清掉"的路径，也是本文件存在的原因之一：
 *   真实的本地 provider 读的是进程环境和磁盘上的 .env 文件，测试没法直接
 *   摆布；这个替身把两种层都暴露成显式的方法调用。
 */
export class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<string, string>()
  private readonly shadow = new Map<string, string>()
  private readonly dotenv = new Map<string, string>()
  private readonly records = new Map<string, CredentialRecord>()

  /** 测试专用：把 ref 标成被只读环境变量遮蔽，遮蔽值为 value。 */
  shadowRef(ref: string, value: string): void {
    this.shadow.set(ref, value)
  }

  /**
   * 测试专用：把 ref 标成由 dotenv 兜底层供值——`describe()` 报
   * `writable: true`，但 `unset()` 清不掉它（对齐 dsh-credentials-local
   * 的 `dotenvFallback` 语义：它只在 `resolve`/`describe` 里参与读，从不
   * 出现在 `write()` 触碰的路径上）。
   */
  dotenvRef(ref: string, value: string): void {
    this.dotenv.set(ref, value)
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const shadowed = this.shadow.get(ref)
    if (shadowed !== undefined) return { value: shadowed, source: 'env' }
    const value = this.values.get(ref)
    if (value !== undefined && value.length > 0) return { value, source: 'memory' }
    const fromDotenv = this.dotenv.get(ref)
    if (fromDotenv !== undefined) return { value: fromDotenv, source: 'project-env' }
    return undefined
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.shadow.has(ref)) return { configured: true, source: 'env', writable: false }
    const value = this.values.get(ref)
    if (value !== undefined && value.length > 0) return { configured: true, source: 'memory', writable: true }
    if (this.dotenv.has(ref)) return { configured: true, source: 'project-env', writable: true }
    return { configured: false, writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (this.shadow.has(ref)) {
      throw new Error(`memory-credentials: "${ref}" 当前被只读环境变量遮蔽；请在启动 dsh 的 shell 里 unset ${ref} 后重试`)
    }
    if (value.length === 0) throw new Error(`memory-credentials: 不能给 "${ref}" 存一个空值；请用 unset`)
    this.values.set(ref, value)
    this.notifyUpdated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    if (this.shadow.has(ref)) {
      throw new Error(`memory-credentials: "${ref}" 当前被只读环境变量遮蔽；请在启动 dsh 的 shell 里 unset ${ref} 后重试`)
    }
    // 故意不碰 this.dotenv——真实的 dsh-credentials-local 的 unset() 只
    // write() 管理态那份文件，对 dotenv 兜底层没有任何效力，这里如实复现。
    this.values.delete(ref)
    this.notifyUpdated(ref)
  }

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    if (!record) return { configured: false, writable: true }
    return { configured: true, kind: record.kind, writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...this.records.entries()].map(([key, record]) => ({
      key: key as CredentialKey,
      kind: record.kind,
    }))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next !== undefined) {
      this.records.set(key, next)
      this.notifyRecordUpdated(key)
    }
    return this.records.get(key)
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    if (this.records.delete(key)) this.notifyRecordUpdated(key)
  }
}

export interface StorageStack {
  ctx: Context
  /** 按挂载的反序依次 dispose 这三个插件（storage-domain → json 后端 → storage 中枢）。 */
  dispose(): Promise<void>
}

/**
 * 起一个真的 cordis Context，挂上 dsh 的存储三层栈：`Storage` 中枢 +
 * `dsh-storage-json`（json 文件后端，指向 root 目录）+ `dsh-storage-domain`
 * （路由到 json 后端）。不挂凭据、不挂本包插件——单独导出正是为了让 Task 7
 * 能只借用这一段，自己在上面接别的东西（比如 shell-ssh 的插件），也能拿到
 * 一个真正拆得干净的 dispose()，而不必重新猜怎么拆这三层。
 */
export async function bootStorageStack(root: string): Promise<StorageStack> {
  const ctx = new Context()
  const storageFiber = ctx.plugin(Storage)
  await storageFiber
  const jsonFiber = ctx.plugin(jsonBackend, { root })
  await jsonFiber
  const domainFiber = ctx.plugin(storageDomain, { backend: 'json' })
  await domainFiber

  return {
    ctx,
    async dispose() {
      await domainFiber.dispose()
      await jsonFiber.dispose()
      await storageFiber.dispose()
    },
  }
}

export interface RemoteRegistryHarness {
  ctx: Context
  creds: MemoryCredentials
  root: string
  /**
   * 只重启 remote-registry 这一个插件：dispose 掉它的 fiber（触发 apply()
   * 里注册的 `domain.close()` effect），再重新 ctx.plugin() 一次（重新
   * ctx.storageDomain.open() 同一个域，从磁盘上的 json 文件重新载入）。
   * storage/backend/credentials 这些底层服务不动。用来验证"机器记录真的
   * 落盘持久化了"，而不是"只是同一个内存 Map 还没被回收"。
   */
  remount(): Promise<void>
  /** 只 dispose 本包这一个插件的 fiber；storage 三层栈和凭据替身仍然挂着。 */
  disposeRegistry(): Promise<void>
  /**
   * 完整拆掉这次 boot 挂的全部五个插件：remote-registry → 凭据替身 →
   * storage-domain → json 后端 → storage 中枢，严格按挂载的反序逐个
   * dispose。`disposeRegistry()` 只拆最上面那一个，今天够用是因为下面几层
   * 都没有需要主动释放的外部资源；Task 7 会在同一个 ctx 上再插 ssh2 连接，
   * 那时候"只拆 remote-registry、底下全留着"就不再是良性的了，所以这里把
   * 两种 dispose 都准备好、含义也分开命名，而不是只给一个语义模糊的
   * dispose()。
   */
  disposeAll(): Promise<void>
}

/**
 * 起一个真的 cordis Context，挂上 dsh 的存储三层栈（json 后端指向 root 这个
 * 目录）、内存凭据替身，再挂上本包的 cordis 插件。
 */
export async function bootRemoteRegistry(root: string): Promise<RemoteRegistryHarness> {
  const stack = await bootStorageStack(root)
  const { ctx } = stack

  const credsFiber = ctx.plugin(MemoryCredentials)
  await credsFiber

  let registryFiber = ctx.plugin(remoteRegistryPlugin)
  await registryFiber

  const creds = ctx.credentials as MemoryCredentials

  return {
    ctx,
    creds,
    root,
    async remount() {
      await registryFiber.dispose()
      registryFiber = ctx.plugin(remoteRegistryPlugin)
      await registryFiber
    },
    async disposeRegistry() {
      await registryFiber.dispose()
    },
    async disposeAll() {
      // 反序：先拆最上层（依赖别人的），再拆底层（被依赖的）。
      await registryFiber.dispose()
      await credsFiber.dispose()
      await stack.dispose()
    },
  }
}
