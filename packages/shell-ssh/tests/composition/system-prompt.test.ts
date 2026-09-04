// 协调者复审 I2：shell-ssh 的插件原来用 `ctx.get('systemPrompt')` 贡献机器名
// 说明——这是一次性快照，只在 systemPrompt 恰好已经先于这个插件挂载时才
// 拿得到东西。在真实的（并发初始化的）cordis-plugin-loader 组合里，
// 这个插件的 fiber 只要 `remotes`+`credentials` 一齐活就会解除阻塞，没有
// 任何东西保证 dsh-system-prompt 排在它前面——这个文件直接验证两种挂载
// 顺序都要工作，而不是只测"恰好先挂载"这一种被验证过的顺序。
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'
import { bootRemoteRegistry, type RemoteRegistryHarness } from '../../../remote-registry/tests/mock/harness.ts'
import * as shellSshPlugin from '../../src/plugin.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'

function machine(overrides: Partial<RemoteMachine> = {}): RemoteMachine {
  return {
    name: 'gpu-h20',
    host: '127.0.0.1',
    port: 0,
    user: 'tester',
    keyRef: 'REMOTE_KEY_GPU_H20',
    tags: [],
    ...overrides,
  }
}

function freshPrivateKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

/** 轮询一个可能是异步的谓词，直到成立或超时——用来等一个不 await 父 fiber 的子 fiber（ctx.inject()）真的跑完。 */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('超时：等待条件成立')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function hasMachineSection(ctx: RemoteRegistryHarness['ctx']): Promise<boolean> {
  const assembly = await ctx.systemPrompt.assemble()
  return assembly.sections.some((s) => s.name === 'shell-ssh:machine')
}

describe('systemPrompt 贡献不依赖挂载顺序', () => {
  let root: string
  let harness: RemoteRegistryHarness
  let sshd: FakeSshd | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shell-ssh-system-prompt-test-'))
    harness = await bootRemoteRegistry(root)
  })

  afterEach(async () => {
    await harness.disposeAll()
    await sshd?.close()
    sshd = undefined
    await rm(root, { recursive: true, force: true })
  })

  it('systemPrompt 先于 shell-ssh 挂载：section 立刻可见', async () => {
    sshd = await startFakeSshd()
    const { ctx } = harness
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    const systemPromptFiber = ctx.plugin(SystemPrompt, {})
    await systemPromptFiber

    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'gpu-h20' })
    await shellFiber

    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find((s) => s.name === 'shell-ssh:machine')
    expect(section).toBeDefined()
    expect(section!.text).toContain('gpu-h20')

    await shellFiber.dispose()
    await systemPromptFiber.dispose()
  })

  it('systemPrompt 晚于 shell-ssh 挂载：section 最终仍然出现，而不是永久缺失', async () => {
    sshd = await startFakeSshd()
    const { ctx } = harness
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    // shell-ssh 先挂载——用 ctx.get('systemPrompt') 的旧实现会在这一刻
    // 拿到 undefined 且永远定格在这个结果，因为 apply() 只跑一次。
    const shellFiber = ctx.plugin(shellSshPlugin, { machine: 'gpu-h20' })
    await shellFiber
    // 这一步本身就是回归点：apply() 必须在没有 systemPrompt 的情况下
    // 正常跑完（ctx.inject() 不阻塞父 fiber），ctx.shell 应该已经可用。
    expect(ctx.shell).toBeDefined()

    // systemPrompt 后挂载。
    const systemPromptFiber = ctx.plugin(SystemPrompt, {})
    await systemPromptFiber

    // ctx.inject(['systemPrompt'], ...) 是当前 fiber 之下的一个子
    // fiber——不受 `await shellFiber`（已经在上面跑完）的保护，它的触发
    // 时机在 systemPrompt 变得可用之后才会被 cordis 调度，需要轮询等待。
    await waitUntil(() => hasMachineSection(ctx))
    expect(await hasMachineSection(ctx)).toBe(true)

    await shellFiber.dispose()
    await systemPromptFiber.dispose()
  })
})
