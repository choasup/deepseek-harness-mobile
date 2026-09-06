import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootRemoteRegistry, type RemoteRegistryHarness } from '../../../remote-registry/tests/mock/harness.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'
import * as sshPlugin from '../../src/plugin.ts'

/**
 * 未注册机器时插件不提供 `ctx.shell`（这是 Task 12 定的形态：提供一个
 * 必然失败的 shell 会让 tool-bash 挂着，而 assertEntriesActivated() 把
 * PENDING 当 FAILED，整棵树起不来）。
 *
 * 但"不提供"不该等于"必须重启才能用"。这组用例证明：机器**稍后**被注册时，
 * 插件通过 `domain/changed` 自己醒过来把 ctx.shell 挂上。
 */
let h: RemoteRegistryHarness | undefined
let sshd: FakeSshd | undefined

afterEach(async () => {
  await h?.disposeAll(); h = undefined
  await sshd?.close(); sshd = undefined
})

/** 轮询等待条件成立，超时即失败——比固定 sleep 稳。 */
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}

const machineFor = (port: number) => ({
  name: 'gpu', host: '127.0.0.1', port, user: 'tester',
  keyRef: 'REMOTE_KEY_GPU', tags: ['gpu'],
})

describe('机器稍后注册时自动挂载 ctx.shell', () => {
  it('挂载时没有机器 → 不提供 ctx.shell，但插件本身正常加载', async () => {
    h = await bootRemoteRegistry(mkdtempSync(join(tmpdir(), 'late-')))
    await h.ctx.plugin(sshPlugin, { machine: 'gpu' })
    await new Promise((r) => setTimeout(r, 80))
    expect(h.ctx.shell).toBeUndefined()
  })

  it('之后注册这台机器 → ctx.shell 自动出现，不需要重启', async () => {
    sshd = await startFakeSshd()
    h = await bootRemoteRegistry(mkdtempSync(join(tmpdir(), 'late-')))
    await h.ctx.plugin(sshPlugin, { machine: 'gpu' })
    await new Promise((r) => setTimeout(r, 80))
    expect(h.ctx.shell, '前置条件：此时还不该有 shell').toBeUndefined()

    await h.ctx.remotes.add(machineFor(sshd.port))

    expect(await waitFor(() => h!.ctx.shell !== undefined), 'ctx.shell 应在注册后出现').toBe(true)
    expect(typeof h.ctx.shell.run).toBe('function')
  })

  it('注册的是**别的**机器名 → 不该被误触发', async () => {
    // 反向对照：证明上一条不是"任何写入都挂载"。
    sshd = await startFakeSshd()
    h = await bootRemoteRegistry(mkdtempSync(join(tmpdir(), 'late-')))
    await h.ctx.plugin(sshPlugin, { machine: 'gpu' })
    await new Promise((r) => setTimeout(r, 80))

    await h.ctx.remotes.add({ ...machineFor(sshd.port), name: 'other', keyRef: 'REMOTE_KEY_OTHER' })
    await new Promise((r) => setTimeout(r, 300))
    expect(h.ctx.shell, '不该因为别的机器被注册就挂载').toBeUndefined()
  })

  it('同一台机器被写多次（add 后再 pinFingerprint）只挂载一次', async () => {
    sshd = await startFakeSshd()
    h = await bootRemoteRegistry(mkdtempSync(join(tmpdir(), 'late-')))

    // 不能用 `ctx.shell === ctx.shell` 判断是否重复挂载：cordis 的服务访问
    // **每次读都返回一个新的绑定代理**（实测确认），身份比较恒为 false。
    // 改成数插件挂载时打的那条 info 日志——那是"挂载发生了"的直接可观测信号。
    let mounts = 0
    const logger = h.ctx.logger as unknown as { info: (...a: unknown[]) => void }
    const realInfo = logger.info.bind(logger)
    logger.info = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('正在挂载 ctx.shell')) mounts += 1
      realInfo(...args)
    }

    await h.ctx.plugin(sshPlugin, { machine: 'gpu' })
    await new Promise((r) => setTimeout(r, 80))

    await h.ctx.remotes.add(machineFor(sshd.port))
    expect(await waitFor(() => mounts === 1)).toBe(true)

    // pinFingerprint 也会写 machines 表（走 putMachine），会再发一次
    // domain/changed——`mounted` 标志必须挡住它。
    await h.ctx.remotes.pinFingerprint('gpu', 'sha256:AbC123')
    await new Promise((r) => setTimeout(r, 400))

    expect(mounts, '重复写入不该再挂载一次').toBe(1)
    expect(h.ctx.shell, '挂载后 shell 仍然可用').toBeDefined()
  })
})
