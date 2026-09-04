// 不只测导出面——起一个真的 Context 装配本插件，断言 ctx.remotes 真的可用、
// 增删查改真的落到磁盘上的 json 文件，密钥真的走 credentials 服务而不落盘。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MissingCredentialError } from '../../src/registry.ts'
import type { RemoteMachine } from '../../src/types.ts'
import { CredentialShadowedError, isCredentialShadowedError } from '../../src/plugin.ts'
import * as remoteRegistryPlugin from '../../src/plugin.ts'
import {
  bootRemoteRegistry,
  bootStorageStack,
  MemoryCredentials,
  type RemoteRegistryHarness,
} from '../mock/harness.ts'

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
    await harness.disposeAll()
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

  // ---------------------------------------------------------------------
  // Task 10 复审 C1：`unset()` 只能清管理态存储自己那一层。dotenv 兜底层
  // （project-env/user-env）在写之前的 describe() 里会谎报 writable:true，
  // 且 unset() 对它完全无效也不报错——如果适配层只做"写之前检查
  // writable"，这个组合会让 add() 静默成功、credentialsFor() 悄悄返回一把
  // 不属于这台机器的私钥。MemoryCredentials 没有真实 provider 的进程环境/
  // .env 文件读取能力，所以需要 dotenvRef() 这个测试专用控制口来复现。
  // ---------------------------------------------------------------------

  it('C1回归：keyRef 撞上 dotenv 兜底层供的值时，add() 显式失败并指出真正供值的那一层，而不是让机器悄悄创建成功', async () => {
    const { ctx, creds } = harness
    creds.dotenvRef('REMOTE_KEY_GPU_H20', 'stray-value-from-a-dotenv-file')

    const rejection = ctx.remotes.add(machine())
    await expect(rejection).rejects.toThrow(CredentialShadowedError)
    await expect(rejection).rejects.toThrow(/project-env/)

    // add() 在判重通过之后、写入机器记录之前才调用 deleteSecret()——
    // deleteSecret 抛出意味着 putMachine 根本没跑到，机器压根没被创建。
    expect(await ctx.remotes.get('gpu-h20')).toBeUndefined()
  })

  it('C1回归：机器建好之后 keyRef 才被 dotenv 供上值——remove() 同样响亮失败，不会悄悄留下清不掉的密钥', async () => {
    const { ctx, creds } = harness
    await ctx.remotes.add(machine())
    creds.dotenvRef('REMOTE_KEY_GPU_H20', 'stray-value-from-a-dotenv-file')

    const rejection = ctx.remotes.remove('gpu-h20')
    await expect(rejection).rejects.toThrow(CredentialShadowedError)
    await expect(rejection).rejects.toThrow(/project-env/)

    // 与 env 遮蔽的取舍一致：机器记录必须保留，用户至少能看到这台删不掉的机器。
    expect(await ctx.remotes.get('gpu-h20')).toEqual(machine())
  })

  // ---------------------------------------------------------------------
  // Task 10 复审的三个"顺手修"之一：readSecret 现在用 isCredentialRefName()
  // 挡在 credentialRef() 前面。手改磁盘上的 json 文件（绕开 normalizeMachine/
  // keyRefForName 的校验）可以造出一个不合法的 keyRef；不挡的话
  // credentialRef() 会抛一个裸 TypeError，把 MissingCredentialError →
  // SSH_NO_CREDENTIAL 这条跨包错误区分链在这一层意外压扁。
  // ---------------------------------------------------------------------

  it('顺手修回归：磁盘上手改出一个不合法的 keyRef 时，credentialsFor 仍然抛 MissingCredentialError，不是裸 TypeError', async () => {
    const { ctx, root: dir } = harness
    await ctx.remotes.add(machine())

    // 直接读回真实写盘的 json，把 keyRef 改成一个 credentialRef() 的
    // REF_PATTERN（POSIX shell 标识符）不接受的名字，模拟手改文件。
    const raw = await readFile(join(dir, 'remote_registry.json'), 'utf8')
    const document = JSON.parse(raw) as { tables: { machines: Record<string, RemoteMachine> } }
    document.tables.machines['gpu-h20']!.keyRef = 'not-a-valid-ref!'
    await writeFile(join(dir, 'remote_registry.json'), JSON.stringify(document, null, 2), 'utf8')

    // remount 强制从磁盘重新 loadAll()，而不是继续用内存里那份没改过的记录。
    await harness.remount()

    const reloaded = await ctx.remotes.get('gpu-h20')
    expect(reloaded?.keyRef).toBe('not-a-valid-ref!')
    await expect(ctx.remotes.credentialsFor(reloaded!)).rejects.toThrow(MissingCredentialError)
  })

  // ---------------------------------------------------------------------
  // Task 10 复审 I1：apply() 在 `await ctx.storageDomain.open()` 还没返回
  // 时被上游 dispose（`inject: ['storageDomain', 'credentials']` 意味着
  // 这两个依赖之一重新 provide 就会触发，不需要真的 HMR），`ctx.effect()`
  // 会抛 INACTIVE_EFFECT。不接住的话 domain 永远关不掉、它的名字永远留在
  // DomainFacility 的 reserved 集合里，且这次 dispose 本身不报任何错——
  // 完全静默、且此后这个进程里任何人再 open 同名 domain 都会撞上
  // "already-open"。这里通过临时包一层 ctx.storageDomain.open 拿到"apply()
  // 已经调用了 open()"这个信号（真实插件不暴露这个时机，只能从外面截获），
  // 在真实 open() 尚未 resolve 的那个窗口里触发 dispose，直接跑本包真正
  // 出货的 plugin.ts，而不是一份手写的模拟实现。
  // ---------------------------------------------------------------------

  it('I1回归：dispose 落在 open() in-flight 期间不会永久泄漏 domain（下一次挂载不会撞上 already-open）', async () => {
    // 用自己的临时目录，不借用外层 beforeEach 那个 harness 的 root——
    // 那个 harness 已经在同一个目录下开着自己的一份 json 后端/domain；
    // 这里如果共用 root，就会有两个互不知情的 JsonStorageBackend 实例
    // 同时对着同一个 remote_registry.json 抢，第一次这么写时把整个测试
    // 拖到 30s 超时（不是这条 I1 复现路径本身的问题，是复现脚手架的
    // 隔离没做对）。
    const i1Root = await mkdtemp(join(tmpdir(), 'remote-registry-i1-'))
    const stack = await bootStorageStack(i1Root)
    const { ctx } = stack
    const credsFiber = ctx.plugin(MemoryCredentials)
    await credsFiber

    // 一个忙等 + setTimeout(0) 的"猜时机"策略在真实 node 下能命中这个窗口
    // （用来找 I1 的手写复现脚本就是这么验证的），但在 vitest/esbuild 下
    // 计时会漂移：真正的 open() 经常在我们的 while 循环第一次看到
    // openStarted 变 true 之前就已经跑完了，整个测试因此"假绿"——从没真的
    // 落进那个窗口。改成一个可控的门：包一层 open()，先把 openStarted 标
    // 成 true，然后卡在 `gate` 上，直到测试主动放行才真正调用底层 open()。
    // 这样"dispose 落在 open() resolve 之前"就不再是猜时机，而是确定的：
    // 我们先在 gate 卡住的时候 dispose 这个 fiber，再放行，让真正的
    // open() 在 fiber 已经 disposed 之后才 resolve——apply() 恢复执行、
    // 拿到 domain、调用 ctx.effect() 时炸出 INACTIVE_EFFECT，正是要复现的
    // 那条路径。
    const realOpen = ctx.storageDomain.open.bind(ctx.storageDomain)
    let openStarted = false
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    ctx.storageDomain.open = (async (spec: Parameters<typeof realOpen>[0]) => {
      openStarted = true
      await gate
      return realOpen(spec)
    }) as typeof ctx.storageDomain.open

    const fiber = ctx.plugin(remoteRegistryPlugin)
    // 忙等到 apply() 真的调用了 open()（而不是还没被 cordis 调度到）。
    // 门还没放行，所以这个 while 循环不会"猜过头"（不会在 open() 真正
    // resolve 之前就已经错过窗口）。
    while (!openStarted) await new Promise((resolve) => setTimeout(resolve, 0))

    // 这一下确定地落在 open() 那次 await 还没 resolve 的窗口里（门还锁着）。
    // dispose() 本身"不报错"正是 I1 的陷阱之一（真正的泄漏在下面第二次
    // 挂载才现形）。不用 expect(...).resolves 这类会在失败时尝试把
    // fiber/ctx 这种 cordis Proxy 对象序列化打印出来的 matcher（会在
    // pretty-format 里踩 "cannot get property without inject"），而是直接
    // 拿到 Promise 手动摆弄时机：fiber.dispose() 同步地把这个 fiber 标成
    // disposing（后面挂起的 ctx.effect() 调用一旦恢复执行就会看到这个
    // 状态、抛 INACTIVE_EFFECT），但它返回的 Promise 要等被挂起的 apply()
    // continuation（包括我们自己那段 catch 里的手动 domain.close()）真正
    // 跑完才 resolve——而那段 continuation 正卡在 `gate` 上等我们放行。
    // 所以不能先 await dispose() 再放行，那是自己等自己的死锁：必须先拿到
    // dispose() 的 Promise（这一步已经同步标记了 disposing），再放行
    // gate，最后才 await 这个 Promise。
    const disposePromise = fiber.dispose()
    releaseGate?.()
    await disposePromise

    // 关键断言：如果 domain 泄漏在 facility 的 reserved 里，下面这次挂载
    // 会抛 DomainError: domain 'remote_registry' is already open。同样避免
    // 用 expect(promise).resolves/rejects 包裹一个 cordis fiber，原因同上。
    let secondMountError: unknown
    let fiber2: ReturnType<typeof ctx.plugin> | undefined
    try {
      fiber2 = ctx.plugin(remoteRegistryPlugin)
      await fiber2
    } catch (error) {
      secondMountError = error
    }
    expect(secondMountError).toBeUndefined()
    expect(ctx.remotes).toBeDefined()

    await fiber2?.dispose()
    await credsFiber.dispose()
    await stack.dispose()
    await rm(i1Root, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------
  // shell-ssh 协调者二审 I3：`port: z.number()` 单独放着接受任何数字——一条
  // 绕开 normalizeMachine（手改磁盘 json、未来的迁移脚本、直接调用
  // putMachine）到达这里的记录可以带一个非法端口，一路撑到 shell-ssh 的
  // `client.connect()`，在那里同步抛出 `ERR_SOCKET_BAD_PORT`。收紧到跟
  // url.ts 的 normalizeMachine 完全一致的 `.int().min(1).max(65535)`，
  // 把这类记录挡在域重新载入快照的那一刻，而不是等到真的去连它才发现。
  // ---------------------------------------------------------------------

  it('I3 回归：磁盘上手改出一个越界端口时，域重新加载响亮失败，而不是悄悄把它载入内存', async () => {
    const { ctx, root: dir } = harness
    await ctx.remotes.add(machine())

    const raw = await readFile(join(dir, 'remote_registry.json'), 'utf8')
    const document = JSON.parse(raw) as { tables: { machines: Record<string, RemoteMachine> } }
    document.tables.machines['gpu-h20']!.port = 70000
    await writeFile(join(dir, 'remote_registry.json'), JSON.stringify(document, null, 2), 'utf8')

    await expect(harness.remount()).rejects.toThrow()
  })

  it('I3 回归：磁盘上手改出一个非整数端口时，域重新加载同样响亮失败', async () => {
    const { ctx, root: dir } = harness
    await ctx.remotes.add(machine())

    const raw = await readFile(join(dir, 'remote_registry.json'), 'utf8')
    const document = JSON.parse(raw) as { tables: { machines: Record<string, RemoteMachine> } }
    document.tables.machines['gpu-h20']!.port = 22.5
    await writeFile(join(dir, 'remote_registry.json'), JSON.stringify(document, null, 2), 'utf8')

    await expect(harness.remount()).rejects.toThrow()
  })
})
