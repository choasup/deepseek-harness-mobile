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
// Task 7 会复用这个夹具（在同一个 ctx 上再插 shell-ssh 的插件），所以
// bootRemoteRegistry 之外把 Storage/json 后端/domain 表单这几步也各自导出，
// 方便 Task 7 只借用底层存储栈、自己接别的插件。
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
import * as remoteRegistry from '../../src/index.ts'

/**
 * 内存凭据替身。`shadowRef()` 是测试专用的控制口：模拟"这个引用被启动 dsh
 * 的 shell 继承的环境变量遮蔽、只读"——真实的 dsh-credentials-local 读的是
 * 进程环境变量，测试没法直接摆布它；这个替身让测试直接把某个 ref 标成
 * 被遮蔽，从而能覆盖 Task 8 交接项 1（`unset` 在遮蔽存在时拒绝写入）的路径。
 * `set`/`unset` 在被遮蔽时也真的抛错，与 dsh-credentials-local 的
 * `assertUnshadowed` 行为对齐，而不是只在 `describe()` 上做样子。
 */
export class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<string, string>()
  private readonly shadow = new Map<string, string>()
  private readonly records = new Map<string, CredentialRecord>()

  /** 测试专用：把 ref 标成被只读环境变量遮蔽，遮蔽值为 value。 */
  shadowRef(ref: string, value: string): void {
    this.shadow.set(ref, value)
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const shadowed = this.shadow.get(ref)
    if (shadowed !== undefined) return { value: shadowed, source: 'env' }
    const value = this.values.get(ref)
    if (value === undefined || value.length === 0) return undefined
    return { value, source: 'memory' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.shadow.has(ref)) return { configured: true, source: 'env', writable: false }
    const value = this.values.get(ref)
    if (value !== undefined && value.length > 0) return { configured: true, source: 'memory', writable: true }
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
  dispose(): Promise<void>
}

/**
 * 起一个真的 cordis Context，挂上 dsh 的存储三层栈（json 后端指向 root 这个
 * 目录）、内存凭据替身，再挂上本包的 cordis 插件。
 */
export async function bootRemoteRegistry(root: string): Promise<RemoteRegistryHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(jsonBackend, { root })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(MemoryCredentials)

  let fiber = ctx.plugin(remoteRegistry)
  await fiber

  const creds = ctx.credentials as MemoryCredentials

  return {
    ctx,
    creds,
    root,
    async remount() {
      await fiber.dispose()
      fiber = ctx.plugin(remoteRegistry)
      await fiber
    },
    async dispose() {
      await fiber.dispose()
    },
  }
}
