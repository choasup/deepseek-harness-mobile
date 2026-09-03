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

  it('my-box 与 my_box 推导出同一个 keyRef，第二次 add 抛 DuplicateKeyRefError', async () => {
    await registry.add(machine({ name: 'my-box', keyRef: 'REMOTE_KEY_MY_BOX' }))
    await expect(
      registry.add(machine({ name: 'my_box', keyRef: 'REMOTE_KEY_MY_BOX' })),
    ).rejects.toThrow(DuplicateKeyRefError)
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
