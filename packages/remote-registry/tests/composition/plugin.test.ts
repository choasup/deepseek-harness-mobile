// 不只测导出面——起一个真的 Context 装配本插件，断言 ctx.remotes 真的可用、
// 增删查改真的落到磁盘上的 json 文件，密钥真的走 credentials 服务而不落盘。
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MissingCredentialError } from '../../src/registry.ts'
import type { RemoteMachine } from '../../src/types.ts'
import { CredentialShadowedError, isCredentialShadowedError } from '../../src/index.ts'
import { bootRemoteRegistry, type RemoteRegistryHarness } from '../mock/harness.ts'

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

const SECRET = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-bytes-do-not-use\n-----END OPENSSH PRIVATE KEY-----'

describe('remote-registry 的 cordis 接线', () => {
  let root: string
  let harness: RemoteRegistryHarness

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'remote-registry-test-'))
    harness = await bootRemoteRegistry(root)
  })

  afterEach(async () => {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('注册为 ctx.remotes，端到端的增删查改都真的落到存储上', async () => {
    const { ctx } = harness
    expect(ctx.remotes).toBeDefined()

    await ctx.remotes.add(machine())
    expect(await ctx.remotes.get('gpu-h20')).toEqual(machine())
    expect(await ctx.remotes.list()).toEqual([machine()])

    await ctx.remotes.setPrivateKey('gpu-h20', SECRET)
    const creds = await ctx.remotes.credentialsFor(machine())
    expect(creds.privateKey).toBe(SECRET)

    await ctx.remotes.pinFingerprint('gpu-h20', 'sha256:abcd')
    expect((await ctx.remotes.get('gpu-h20'))?.hostFingerprint).toBe('sha256:abcd')
  })

  it('从没设置过密钥的机器：credentialsFor 抛 MissingCredentialError，不是别的错误——shell-ssh 靠这个区分 SSH_NO_CREDENTIAL 与 SSH_AUTH_FAILED', async () => {
    const { ctx } = harness
    await ctx.remotes.add(machine())
    await expect(ctx.remotes.credentialsFor(machine())).rejects.toThrow(MissingCredentialError)
  })

  it('get()/list() 不会交出存储的活引用：调用方改返回值不会写穿到域的内存状态', async () => {
    const { ctx } = harness
    await ctx.remotes.add(machine())

    const first = await ctx.remotes.get('gpu-h20')
    first!.tags.push('polluted')
    ;(first as RemoteMachine).host = 'polluted.example.com'

    const second = await ctx.remotes.get('gpu-h20')
    expect(second).toEqual(machine())
    expect(second!.tags).not.toContain('polluted')

    const listed = await ctx.remotes.list()
    expect(listed[0]).toEqual(machine())
  })

  it('私钥经 credentials 存取，绝不出现在 machines 的 json 文件里', async () => {
    const { ctx, root: dir } = harness
    await ctx.remotes.add(machine())
    await ctx.remotes.setPrivateKey('gpu-h20', SECRET)

    const raw = await readFile(join(dir, 'remote_registry.json'), 'utf8')
    expect(raw).toContain('gpu-h20') // 确认真的读对了文件，不是断言在一个空文件上
    expect(raw).toContain('REMOTE_KEY_GPU_H20') // keyRef 是引用，允许出现
    expect(raw).not.toContain(SECRET) // 私钥本身绝不落这个盘
  })

  it('remove() 同时清掉机器记录和密钥（存储与凭据两条通道）', async () => {
    const { ctx, root: dir, creds } = harness
    await ctx.remotes.add(machine())
    await ctx.remotes.setPrivateKey('gpu-h20', SECRET)

    await ctx.remotes.remove('gpu-h20')

    expect(await ctx.remotes.get('gpu-h20')).toBeUndefined()
    expect(await creds.resolve(credentialRef('REMOTE_KEY_GPU_H20'))).toBeUndefined()

    const raw = await readFile(join(dir, 'remote_registry.json'), 'utf8')
    expect(raw).not.toContain('gpu-h20')
  })

  it('机器记录在 domain close/reopen 之后仍然存在——真实持久化，不是同一个内存 Map 还活着', async () => {
    const { ctx } = harness
    await ctx.remotes.add(machine())
    await ctx.remotes.setPrivateKey('gpu-h20', SECRET)

    await harness.remount()

    const reloaded = await ctx.remotes.get('gpu-h20')
    expect(reloaded).toEqual(machine())
    // 私钥走的是凭据服务（没被 remount），也应该还在
    const creds = await ctx.remotes.credentialsFor(machine())
    expect(creds.privateKey).toBe(SECRET)
  })

  it('删除一台密钥被环境变量遮蔽的机器：抛出能看懂补救办法的错误，而不是 provider 的原始报错；机器记录按设计保留', async () => {
    const { ctx, creds } = harness
    await ctx.remotes.add(machine())
    creds.shadowRef('REMOTE_KEY_GPU_H20', 'value-from-shell-env')

    const rejection = ctx.remotes.remove('gpu-h20')
    await expect(rejection).rejects.toThrow(CredentialShadowedError)
    await expect(rejection).rejects.toThrow(/unset REMOTE_KEY_GPU_H20/)
    await rejection.catch((error: unknown) => {
      expect(isCredentialShadowedError(error)).toBe(true)
    })

    // Task 8 交接项 1 明确的取舍：deleteSecret 先于 deleteMachine 抛出，
    // 机器记录必须还在——用户至少能看到这台删不掉的机器，而不是两者都没了。
    expect(await ctx.remotes.get('gpu-h20')).toEqual(machine())
  })
})
