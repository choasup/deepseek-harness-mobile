/**
 * 远程机器注册表：机器元数据与私钥物理上分两条通道存储（见 RegistryStore），
 * 本类负责把两者粘合成一个一致的、经过归一化/校验的视图。
 */
import { normalizeMachine, parseRemoteUrl } from './url.ts'
import type { RemoteMachine, SshCredentials } from './types.ts'

/**
 * 存储适配器。机器与密钥分开两条通道，因为私钥绝不能落进
 * 会被同步或导出的设置文档。
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
 * 调用方（shell-ssh 的连接池，Task 7）可以 catch 这个类型，映射成一个
 * 比 SSH_AUTH_FAILED 更明确的提示，引导用户去调用 setPrivateKey，
 * 而不是让人怀疑密钥内容本身写错了。
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

export class RemoteRegistry {
  // 不能用参数属性——根 tsconfig 开了 erasableSyntaxOnly，
  // 参数属性在 Node 类型剥离下是硬 SyntaxError，而 vitest 走 esbuild 抓不到。
  private readonly store: RegistryStore

  constructor(store: RegistryStore) { this.store = store }

  async list(): Promise<RemoteMachine[]> {
    const machines = await this.store.listMachines()
    return [...machines].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
   * 原子性：这里是"读 listMachines 判重 -> 写 putMachine"，中间没有锁。
   * 两个并发的 add() 调用可能都读到"还不存在"从而都通过判重，其中一个
   * 悄悄覆盖另一个——这是已知且接受的限制（单一写者场景：一台手机上的
   * 一个 app 实例，不是多进程共享数据库）。add() 本身只有一次写
   * （putMachine），不涉及密钥通道，所以不会出现"写了一半"的部分失败：
   * putMachine 要么成功要么整体抛错，调用方看到异常就知道没有任何东西
   * 落地。
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
