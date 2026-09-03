import { beforeEach, describe, expect, it } from 'vitest'
import type { RemoteMachine } from '../../src/types.ts'
import {
  DuplicateKeyRefError,
  DuplicateMachineError,
  MissingCredentialError,
  RemoteRegistry,
  UnknownMachineError,
} from '../../src/registry.ts'

function makeStore() {
  const machines = new Map<string, RemoteMachine>()
  const secrets = new Map<string, string>()
  return {
    machines,
    secrets,
    adapter: {
      listMachines: async () => [...machines.values()],
      putMachine: async (m: RemoteMachine) => { machines.set(m.name, m) },
      deleteMachine: async (name: string) => { machines.delete(name) },
      readSecret: async (ref: string) => secrets.get(ref),
      writeSecret: async (ref: string, value: string) => { secrets.set(ref, value) },
      deleteSecret: async (ref: string) => { secrets.delete(ref) },
    },
  }
}

function machine(overrides: Partial<RemoteMachine> = {}): RemoteMachine {
  return {
    name: 'gpu-h20',
    host: 'example.com',
    port: 22,
    user: 'root',
    keyRef: 'REMOTE_KEY_GPU_H20',
    tags: ['gpu'],
    ...overrides,
  }
}

describe('RemoteRegistry', () => {
  let store: ReturnType<typeof makeStore>
  let registry: RemoteRegistry

  beforeEach(() => {
    store = makeStore()
    registry = new RemoteRegistry(store.adapter)
  })

  it('add 后可以 get 到同一台机器', async () => {
    await registry.add(machine())
    expect(await registry.get('gpu-h20')).toEqual(machine())
  })

  it('get 查询不存在的机器返回 undefined', async () => {
    expect(await registry.get('nope')).toBeUndefined()
  })

  it('重复 add 同名机器抛 DuplicateMachineError', async () => {
    await registry.add(machine())
    await expect(registry.add(machine())).rejects.toThrow(DuplicateMachineError)
  })

  it('my-box 与 my_box 推导出同一个 keyRef，第二次 add 抛 DuplicateKeyRefError，且第一台机器的密钥原封不动', async () => {
    await registry.add(machine({ name: 'my-box', keyRef: 'REMOTE_KEY_MY_BOX' }))
    await registry.setPrivateKey('my-box', 'MY-BOX-PRIVATE-KEY')

    await expect(
      registry.add(machine({ name: 'my_box', keyRef: 'REMOTE_KEY_MY_BOX' })),
    ).rejects.toThrow(DuplicateKeyRefError)

    // 判重必须在任何写入之前就拦下——被拒绝的 add() 不能碰到已有机器的密钥。
    // 这正是这个错误类存在的理由："删掉一台会连带抹掉另一台的私钥"，
    // 这里验证的是它的镜像场景："添加一台"也不能覆盖/清空另一台的私钥。
    expect(store.secrets.get('REMOTE_KEY_MY_BOX')).toBe('MY-BOX-PRIVATE-KEY')
    expect((await registry.get('my-box'))?.name).toBe('my-box')
    expect(await registry.get('my_box')).toBeUndefined()
  })

  it('list() 按 name 排序', async () => {
    await registry.add(machine({ name: 'zeta', keyRef: 'REMOTE_KEY_ZETA' }))
    await registry.add(machine({ name: 'alpha', keyRef: 'REMOTE_KEY_ALPHA' }))
    await registry.add(machine({ name: 'mid', keyRef: 'REMOTE_KEY_MID' }))
    expect((await registry.list()).map((m) => m.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('byTag 按标签过滤', async () => {
    await registry.add(machine({ name: 'a', keyRef: 'REMOTE_KEY_A', tags: ['gpu', 'cuda'] }))
    await registry.add(machine({ name: 'b', keyRef: 'REMOTE_KEY_B', tags: ['cpu'] }))
    expect((await registry.byTag('gpu')).map((m) => m.name)).toEqual(['a'])
    expect((await registry.byTag('nonexistent')).map((m) => m.name)).toEqual([])
  })

  it('remove 同时删除机器与密钥', async () => {
    await registry.add(machine())
    await registry.setPrivateKey('gpu-h20', 'PRIVATE-KEY-DATA')
    expect(store.secrets.has('REMOTE_KEY_GPU_H20')).toBe(true)

    await registry.remove('gpu-h20')

    expect(await registry.get('gpu-h20')).toBeUndefined()
    expect(store.secrets.has('REMOTE_KEY_GPU_H20')).toBe(false)
  })

  it('remove 不存在的机器抛 UnknownMachineError', async () => {
    await expect(registry.remove('nope')).rejects.toThrow(UnknownMachineError)
  })

  it('deleteSecret 失败时 remove() 整体抛错，机器记录原样保留，可以安全重试', async () => {
    await registry.add(machine())
    await registry.setPrivateKey('gpu-h20', 'PRIVATE-KEY-DATA')

    let shouldFail = true
    const originalDeleteSecret = store.adapter.deleteSecret
    store.adapter.deleteSecret = async (ref: string) => {
      if (shouldFail) throw new Error('存储暂时不可写')
      await originalDeleteSecret(ref)
    }

    await expect(registry.remove('gpu-h20')).rejects.toThrow('存储暂时不可写')
    // 失败之后机器记录和密钥都必须还在——remove() 不能是"删了一半"。
    expect(await registry.get('gpu-h20')).toEqual(machine())
    expect(store.secrets.get('REMOTE_KEY_GPU_H20')).toBe('PRIVATE-KEY-DATA')

    shouldFail = false
    await registry.remove('gpu-h20')
    expect(await registry.get('gpu-h20')).toBeUndefined()
    expect(store.secrets.has('REMOTE_KEY_GPU_H20')).toBe(false)
  })

  it('add() 会清空该 keyRef 已有的密钥槽，防止新机器继承残留/环境变量注入的密钥（安全相关）', async () => {
    // 模拟一把"跟这台新机器毫无关系"的孤儿密钥已经躺在同一个 keyRef 槽位——
    // 可能是之前一台同名机器被 remove() 后没清干净（不应该发生，但要防御），
    // 也可能是 Task 10 里 CredentialProvider 分层解析到的裸环境变量。
    store.secrets.set('REMOTE_KEY_GPU_H20', 'OLD-UNRELATED-PRIVATE-KEY')

    await registry.add(machine())

    const m = await registry.get('gpu-h20')
    // 从没调用过 setPrivateKey，credentialsFor() 必须照实报"没配置"，
    // 而不是安静地把那把不相关的旧密钥当成这台新机器的凭据交出去。
    await expect(registry.credentialsFor(m!)).rejects.toThrow(MissingCredentialError)
    expect(store.secrets.has('REMOTE_KEY_GPU_H20')).toBe(false)
  })

  it('私钥进 secret 通道，从不出现在机器记录里', async () => {
    await registry.add(machine())
    await registry.setPrivateKey('gpu-h20', 'PRIVATE-KEY-DATA')

    const stored = await registry.get('gpu-h20')
    expect(stored).not.toHaveProperty('privateKey')
    expect(JSON.stringify(stored)).not.toContain('PRIVATE-KEY-DATA')

    // 底层 store 里，machines 表也绝不能含私钥字段
    for (const m of store.machines.values()) {
      expect(JSON.stringify(m)).not.toContain('PRIVATE-KEY-DATA')
    }
  })

  it('credentialsFor 能取回存好的私钥', async () => {
    await registry.add(machine())
    await registry.setPrivateKey('gpu-h20', 'PRIVATE-KEY-DATA')
    const m = await registry.get('gpu-h20')
    const creds = await registry.credentialsFor(m!)
    expect(creds.privateKey).toBe('PRIVATE-KEY-DATA')
  })

  it('credentialsFor 在密钥缺失时抛出可区分的 MissingCredentialError，而不是静默返回 {}', async () => {
    await registry.add(machine())
    const m = await registry.get('gpu-h20')
    await expect(registry.credentialsFor(m!)).rejects.toThrow(MissingCredentialError)
  })

  it('importUrl 解析 URL 并写入注册表', async () => {
    const m = await registry.importUrl('dsh-remote://root@example.com:11020/?name=gpu-h20&tags=gpu,cuda')
    expect(m.name).toBe('gpu-h20')
    expect(await registry.get('gpu-h20')).toEqual(m)
  })

  it('pinFingerprint 存归一化后的值', async () => {
    await registry.add(machine())
    await registry.pinFingerprint('gpu-h20', 'SHA256:AbC+/123==')
    const m = await registry.get('gpu-h20')
    expect(m?.hostFingerprint).toBe('sha256:AbC+/123')
  })

  it('pinFingerprint 对不存在的机器抛 UnknownMachineError', async () => {
    await expect(registry.pinFingerprint('nope', 'sha256:AbC123')).rejects.toThrow(UnknownMachineError)
  })

  it('setPrivateKey 对不存在的机器抛 UnknownMachineError', async () => {
    await expect(registry.setPrivateKey('nope', 'key')).rejects.toThrow(UnknownMachineError)
  })

  it('add() 会先归一化——host: "H.Test" 存成 "h.test"，不会产生第二条记录', async () => {
    await registry.add(machine({ name: 'box', keyRef: 'REMOTE_KEY_BOX', host: 'H.Test' }))
    const m = await registry.get('box')
    expect(m?.host).toBe('h.test')
    expect(await registry.list()).toHaveLength(1)
  })
})
