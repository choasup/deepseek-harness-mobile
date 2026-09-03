/**
 * 远程机器注册表：机器元数据与私钥物理上分两条通道存储（见 RegistryStore），
 * 本类负责把两者粘合成一个一致的、经过归一化/校验的视图。
 */
import { normalizeMachine, parseRemoteUrl } from './url.ts'
import type { RemoteMachine, SshCredentials } from './types.ts'

/**
 * 存储适配器。不是"读/写一个大 JSON blob"，而是按记录存取——这样设计
 * 是为了让它直接对应 dsh 实际提供的东西：`ctx.storageDomain.open(spec)`
 * 返回一个 `KvTable`（`get`/`put`/`delete`/`entries`），密钥则走
 * `ctx.credentials` 的 `resolve`/`set`/`unset`。机器与密钥分开两条通道，
 * 因为私钥绝不能落进会被同步或导出的设置文档。Task 10 写那个真实适配器；
 * 不要把这个接口改成看起来更方便（比如"整表读一次"）的形状——per-record
 * 是刻意对齐 dsh 的真实 API 形状，而不是随手选的。
 */
export interface RegistryStore {
  listMachines(): Promise<RemoteMachine[]>
  putMachine(machine: RemoteMachine): Promise<void>
  deleteMachine(name: string): Promise<void>
  readSecret(ref: string): Promise<string | undefined>
  writeSecret(ref: string, value: string): Promise<void>
  deleteSecret(ref: string): Promise<void>
}

export class DuplicateMachineError extends Error {
  constructor(name: string) {
    super(`机器 '${name}' 已存在`)
    this.name = 'DuplicateMachineError'
  }
}

export class UnknownMachineError extends Error {
  constructor(name: string) {
    super(`机器 '${name}' 不存在`)
    this.name = 'UnknownMachineError'
  }
}

/**
 * 两个不同的机器名可能推导出同一个 keyRef（`keyRefForName` 把 `-` `.` `_`
 * 都折成 `_`，如 `my-box` 与 `my_box`）。机器按 name 唯一，但密钥按 keyRef
 * 存——若放任碰撞，删掉一台会连带抹掉另一台的私钥。唯一性由注册表负责，
 * 不改 keyRefForName 的推导规则。
 */
export class DuplicateKeyRefError extends Error {
  constructor(name: string, conflictsWith: string, keyRef: string) {
    super(`机器 '${name}' 与已有的 '${conflictsWith}' 推导出同一个凭据引用名 ${keyRef}，请换一个名字`)
    this.name = 'DuplicateKeyRefError'
  }
}

/**
 * credentialsFor() 在 keyRef 从未写过密钥时抛出的可区分错误——而不是
 * 静默返回 `{}`。返回 `{}` 会让连接池落到"无认证材料"分支，最终从服务器
 * 那里收到一个和"密码/密钥真的错了"完全相同的认证拒绝，用户看到的只有
 * 一句语焉不详的认证失败，无从得知问题其实是"这台机器压根没配过密钥"。
 * shell-ssh 的连接池（connection.ts）用下面的 isMissingCredentialError()
 * 识别这个类型，映射成它自己的 `SSH_NO_CREDENTIAL`（区别于真正认证被拒的
 * `SSH_AUTH_FAILED`）——"去配一把密钥"和"你的密钥不对"是两种要求用户
 * 做完全不同的事的错误，混成一个 code 会让 Tasks 6/7 里靠 code 分流的
 * 处理逻辑对这两种情况给出同一个（错误的）指引。
 */
export class MissingCredentialError extends Error {
  readonly machineName: string
  readonly keyRef: string

  constructor(name: string, keyRef: string) {
    super(`机器 '${name}' 尚未配置密钥（keyRef=${keyRef}），请先调用 setPrivateKey`)
    this.name = 'MissingCredentialError'
    this.machineName = name
    this.keyRef = keyRef
  }
}

/**
 * shell-ssh（跨包）用它来判断 credentials() 抛出的是不是这一种，而不是
 * 对着从另一个包 import 进来的 class 做裸 `instanceof`——类型守卫是这个
 * 边界上更稳的契约，也让"怎么判断"这件事留在定义错误的包里维护。
 */
export function isMissingCredentialError(value: unknown): value is MissingCredentialError {
  return value instanceof MissingCredentialError
}

export class RemoteRegistry {
  // 不能用参数属性——根 tsconfig 开了 erasableSyntaxOnly，
  // 参数属性在 Node 类型剥离下是硬 SyntaxError，而 vitest 走 esbuild 抓不到。
  private readonly store: RegistryStore

  constructor(store: RegistryStore) { this.store = store }

  async list(): Promise<RemoteMachine[]> {
    const machines = await this.store.listMachines()
    // 显式钉住 'en' locale 的 localeCompare，而不是裸的 `<`/`>`：机器名
    // 大小写都合法（'gpu-h20' 与 'GPU-Backup' 可以同时存在），逐码点比较
    // 会把所有大写开头的名字排在所有小写名字前面（['Alpha','Zulu','beta']），
    // 这对着手动录入的机器列表看起来像是排序坏了。'en' 参数钉死 locale，
    // 不依赖运行环境的默认 locale，结果在任何机器上都一样。
    return [...machines].sort((a, b) => a.name.localeCompare(b.name, 'en'))
  }

  async get(name: string): Promise<RemoteMachine | undefined> {
    const machines = await this.store.listMachines()
    return machines.find((m) => m.name === name)
  }

  async byTag(tag: string): Promise<RemoteMachine[]> {
    const machines = await this.list()
    return machines.filter((m) => m.tags.includes(tag))
  }

  /**
   * 存进来的机器一律先过 normalizeMachine。手工录入表单不经过 parseRemoteUrl，
   * 若不归一化，`H.Test` 与 `h.test`、`SHA256:` 与 `sha256:` 会变成两条记录
   * ——这正是 url.ts 里花了几轮才关掉的那个 bug，只是搬到了注册表这一层。
   * normalizeMachine 同时负责校验，非法机器在这里就被拒。
   *
   * **安全相关**：判重通过之后、写入机器记录之前，先对新机器的 keyRef
   * 主动调用一次 deleteSecret()。一台刚 add() 出来的机器按定义没有密钥——
   * 只有 setPrivateKey() 才能给它一把。但 keyRef 这个字符串槽位本身可能
   * 已经有内容：要么是之前一台同名/同派生名的机器被 remove() 时留下的
   * 孤儿密钥（见 remove() 的注释），要么——到了 Task 10，凭据来自
   * `CredentialProvider.resolve`，它的数据源里包含裸的进程环境变量
   * （env/file/project-env/user-env 这一叠）——单纯是主机上恰好导出了
   * 一个叫 `REMOTE_KEY_GPU_H20` 的环境变量或在某个 `.env` 里配了同名项，
   * 跟这个注册表毫无关系。
   *
   * 这行 deleteSecret 试图清空这个槽位，但**只能清管理态存储自己那一层**
   * ——`env`（启动 dsh 的 shell 里继承的进程环境变量）和 `project-env`/
   * `user-env`（dotenv 兜底层）都清不掉，它们不受这次写入影响。Task 10
   * 的适配层因此在这两种"清不干净"的情况下都改为**抛出**而不是假装清空
   * 成功（`env` 层：`describe().writable` 为 false，写之前就能拦住；
   * dotenv 兜底层更隐蔽——`describe()` 照样报 `writable: true`，`unset()`
   * 也不会报错，只有清完之后再 `describe()` 一次、发现它依然
   * `configured: true` 才能揭穿）。也就是说：起一台新机器时若 keyRef 撞上
   * 了这类槽位，`add()` 会跟着失败并指出真正供值的那一层，而不是悄悄让
   * `credentialsFor()` 在从没调用过 `setPrivateKey()` 的情况下返回一把
   * 不属于这台机器的私钥。
   *
   * 原子性：这里现在是"读 listMachines 判重 -> 写 deleteSecret 清槽 ->
   * 写 putMachine"，中间没有事务，也没有锁。这不只是"两个并发 add()
   * 调用互相踩"这么窄的问题——`RemoteRegistry` 上任意两个方法只要都做
   * "读一下当前状态、await 一次、再写回去"，就可能在同一个进程里、
   * 单线程 event loop 上被交错执行，不需要真的多进程/多线程。例如：
   * `remove('x')` 先 `get('x')` 拿到机器（此时记录还在），同时另一处
   * 代码对同一个 name 发起 `setPrivateKey('x', '...')`，它也 `get('x')`
   * 拿到了同一条（还没删的）记录；`remove('x')` 的两次删除都跑完之后，
   * `setPrivateKey` 的 `writeSecret` 才落地——最终产出的状态是"机器记录
   * 没了，密钥却在"，正是 remove() 那段注释花了二十行想避免的孤儿密钥。
   * Task 7 的 cordis 适配器 + 一个设置 UI 同时对着一个 `RemoteRegistry`
   * 派发调用，就是这种交错的现实版本，不是理论上的边界情况。
   *
   * 这不是"RegistryStore 这个形状做不到原子"——dsh 的 `KvTable` 提供
   * `update(key, fn)`：对同一条写链上的原子读-改-写，`fn` 看到的是它在
   * 写队列里排到的那个时刻的值，并发的多个 update 不会交错。真做的话，
   * 是在 Task 10 的适配器里把"判重-写入"这类操作实现成一次 `update`，
   * 而不是这里"listMachines() 再 putMachine()"这两次独立调用。这里不
   * 现在就改 `RegistryStore` 接口去暴露这种原子操作，是因为测试用的内存
   * fake 用不上、Task 8 的范围也不包括重新设计存储接口；但这是"当前没做
   * 到"，不是"做不到"——不要把这条限制读成这个存储形状天然的天花板。
   */
  async add(input: RemoteMachine): Promise<void> {
    const machine = normalizeMachine(input)
    const existing = await this.store.listMachines()

    if (existing.some((m) => m.name === machine.name)) {
      throw new DuplicateMachineError(machine.name)
    }
    const conflict = existing.find((m) => m.keyRef === machine.keyRef)
    if (conflict) {
      throw new DuplicateKeyRefError(machine.name, conflict.name, machine.keyRef)
    }

    await this.store.deleteSecret(machine.keyRef)
    await this.store.putMachine(machine)
  }

  /**
   * 原子性：remove() 做两次写（deleteSecret、deleteMachine），中间没有
   * 事务。故意选择"先删密钥、再删机器记录"这个顺序，而不是反过来——
   *
   * - 若 deleteSecret 失败：整个 remove() 抛出，机器记录和密钥都还在，
   *   状态一致，调用方可以安全重试。
   * - 若 deleteSecret 成功但 deleteMachine 失败：留下一条"有记录、没
   *   密钥"的机器。get(name) 仍能查到它，credentialsFor() 会抛
   *   MissingCredentialError（见上），失败是显式且可恢复的——重新调用
   *   remove() 会先对已经不存在的密钥再删一次（各 store 实现应当把
   *   删除不存在的 key 当成幂等空操作，内存版 Map.delete 天然如此），
   *   再重试 deleteMachine。
   *
   * 反过来"先删机器、再删密钥"更危险：一旦 deleteMachine 先成功，
   * get(name) 立刻查不到这台机器，remove() 再也无法重试去清理孤儿密钥
   * ——而这个孤儿密钥仍然躺在 keyRef 对应的 slot 里。之后如果有人用
   * 一个会推导出同一个 keyRef 的新名字重新 add() 一台*完全不同*的物理
   * 机器，在它自己调用 setPrivateKey 之前，credentialsFor() 会读到那把
   * 旧密钥并当作"已配置"，造成用旧机器的私钥去连一台新机器——这是静默
   * 的凭据张冠李戴，比"多算一次幂等删除"严重得多。两权相害取其轻：
   * 一条没有密钥的机器记录，好过一把没有机器记录、随时可能被错误复用
   * 的密钥。
   */
  async remove(name: string): Promise<void> {
    const machine = await this.get(name)
    if (!machine) throw new UnknownMachineError(name)

    await this.store.deleteSecret(machine.keyRef)
    await this.store.deleteMachine(name)
  }

  async importUrl(url: string): Promise<RemoteMachine> {
    const machine = parseRemoteUrl(url)
    await this.add(machine)
    return machine
  }

  async setPrivateKey(name: string, privateKey: string): Promise<void> {
    const machine = await this.get(name)
    if (!machine) throw new UnknownMachineError(name)
    await this.store.writeSecret(machine.keyRef, privateKey)
  }

  /**
   * 存归一化后的值：把待更新的指纹塞进当前机器记录，整体交给
   * normalizeMachine 校验+归一化（复用它内部对 FINGERPRINT_RE 的校验，
   * 不在这里重复正则），再整条 putMachine 回去。
   */
  async pinFingerprint(name: string, fingerprint: string): Promise<void> {
    const machine = await this.get(name)
    if (!machine) throw new UnknownMachineError(name)
    const updated = normalizeMachine({ ...machine, hostFingerprint: fingerprint })
    await this.store.putMachine(updated)
  }

  /**
   * 见 MissingCredentialError 的注释：密钥缺失是显式抛错，不是返回 `{}`。
   * 目前只有私钥这一条密钥通道（setPrivateKey 写入的内容），所以这里
   * 只填 privateKey；password/passphrase 留给未来需要时再加对应的
   * setter，不在这个通道里臆测格式。
   */
  async credentialsFor(machine: RemoteMachine): Promise<SshCredentials> {
    const privateKey = await this.store.readSecret(machine.keyRef)
    if (privateKey === undefined) {
      throw new MissingCredentialError(machine.name, machine.keyRef)
    }
    return { privateKey }
  }
}
