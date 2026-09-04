// Task 7 交代的风险点："remote-registry 和 shell-ssh 各自的插件测试都是靠
// 直接 ctx.plugin() 装配的，但真实 dsh 用的是 cordis-plugin-loader，它把
// 条目挂进（可能是隔离的）entry group——`ctx.provide('remotes', ...)` 在一个
// group 里注册，可能对另一个 group 里的 shell-ssh 条目不可见"。这个文件
// 就是那句话里点名的"只有 Loader-based test 才能揭穿"的那个测试。
//
// 结论先写在这里（细节见下面两个 it 和最终报告）：读过
// @deepseek-ai/cordis-plugin-loader 的源码（config/isolate.ts +
// config/group.ts）之后，服务隔离是**完全 opt-in** 的——只有一个条目显式
// 声明 `isolate: { <serviceName>: true | 'label' }` 时，cordis 才会给它切一张
// 新的 isolate 符号表；`group: true` 条目本身（cordis-plugin-loader 自己的
// `Group` 类，dsh-app-boot 通过 `ctx.loader.builtins.group = Group` 注册成
// `cordis:group`）只是把子条目组织成一棵嵌套的 EntryTree，不触碰任何 isolate
// 状态。下面两个用例分别验证：(1) 同级、都不声明 isolate 的两个条目正常互见；
// (2) 就算把 remote-registry 的条目包进一个 `cordis:group` 子组、shell-ssh
// 的条目留在顶层，只要都没声明 isolate，仍然正常互见——因为分组这件事本身
// 不引入隔离。真正会导致 Task 12/13 描述的那种失败的，是 profile 配置**主动**
// 给 'remotes'/'credentials'/'shell'/'systemPrompt' 这类跨插件共享的服务名
// 声明了 isolate；只要 Task 12 的 mobile profile 不这么做，这条风险不会
// 发生。
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'
import { bootStorageStack, MemoryCredentials, type StorageStack } from '../../../remote-registry/tests/mock/harness.ts'
import { buildRemoteCommand } from '../../src/exec.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'

// Task 11：`ctx.loader.create()` 下面按 '../../../remote-registry/lib/plugin.js'
// 加载的是构建产物，不是这份 vitest 进程本来就在跑的 src/*.ts——不能假设
// 别的测试文件（remote-registry/tests/build/lib.test.ts）先跑一遍把它建好；
// vitest 的文件执行顺序不是这个文件该依赖的东西。这里显式重建一次，让这个
// 文件单独跑（`vitest run .../loader.test.ts`）时也不依赖 lib/ 是不是已经
// 存在、是不是跟当前 src 一致。
const REMOTE_REGISTRY_PKG_DIR = fileURLToPath(new URL('../../../remote-registry', import.meta.url))
const ROOT_DIR = fileURLToPath(new URL('../../../..', import.meta.url))
const TSDOWN_BIN = join(ROOT_DIR, 'node_modules', '.bin', 'tsdown')

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

function wrapped(command: string, workdir = '~'): string {
  return buildRemoteCommand({ command, workdir })
}

describe('装配层风险核查：cordis-plugin-loader 的 entry group 是否隔离服务', () => {
  let root: string
  let stack: StorageStack
  let sshd: FakeSshd | undefined

  beforeAll(() => {
    execFileSync(TSDOWN_BIN, [], { cwd: REMOTE_REGISTRY_PKG_DIR, stdio: 'pipe' })
  }, 30_000)

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shell-ssh-loader-test-'))
    stack = await bootStorageStack(root)
  })

  afterEach(async () => {
    await stack.dispose()
    await sshd?.close()
    sshd = undefined
    await rm(root, { recursive: true, force: true })
  })

  it('两个插件都以 Loader 条目（非 ctx.plugin() 直接装配）挂载，不声明 isolate 时互相可见', async () => {
    sshd = await startFakeSshd({ commands: { [wrapped('echo hi')]: { stdout: 'hi\n', exitCode: 0 } } })
    const { ctx } = stack

    await ctx.plugin(Loader, { baseUrl: import.meta.url })
    const credsFiber = ctx.plugin(MemoryCredentials)
    await credsFiber

    // 两个条目都是 Loader 的顶层子条目，互为兄弟——真实 dsh profile 里
    // 插件也是这样按名字列出来的，不是靠手写 ctx.plugin() 拼起来的。
    //
    // Task 11：这里指向构建产物 lib/plugin.js，不再是 src/plugin.ts——
    // `ctx.loader.create()` 内部做的是一次原始 `import()`，绕开了 vitest
    // 的 transform；dsh 真实加载的就是 package.json `exports` 指向的
    // lib/ 产物（main=lib/index.js），不是源码。指向构建产物才是这个
    // 测试真正要覆盖的装配路径。
    await ctx.loader.create({ name: '../../../remote-registry/lib/plugin.js', config: {} })
    await ctx.loader.await()

    // remote-registry 的插件条目已经跑完 apply()，ctx.remotes 应该已经
    // 挂在这棵树的根 ctx 上——从这里就能看到，不需要经过 shell-ssh。
    expect(ctx.remotes).toBeDefined()
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    await ctx.loader.create({ name: '../../src/plugin.ts', config: { machine: 'gpu-h20' } })
    await ctx.loader.await()

    // 关键断言：shell-ssh 这个 Loader 条目的 apply() 里 `await
    // ctx.remotes.get(...)` 必须能看到另一个 Loader 条目 provide 的
    // 'remotes'——如果 Loader 真的按条目切了 isolate 符号表，这里
    // ctx.shell 会是 undefined（shell-ssh 的 apply() 从未跑完，因为
    // `inject: ['remotes', 'credentials']` 会让它的 fiber 永远挂起等待）。
    expect(ctx.shell).toBeDefined()
    const spec = ctx.shell.resolve({ command: 'echo hi' })
    const result = await ctx.shell.run(spec)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('hi\n')
  })

  it('remote-registry 嵌在一个 cordis:group 子组里、shell-ssh 留在顶层，不声明 isolate 时仍然互相可见', async () => {
    sshd = await startFakeSshd({ commands: { [wrapped('echo hi')]: { stdout: 'hi\n', exitCode: 0 } } })
    const { ctx } = stack

    await ctx.plugin(Loader, { baseUrl: import.meta.url })
    // dsh-app-boot 真实是这样注册 'cordis:group' 这个 builtin 名字的
    // （见 dsh-app-boot/lib/index.js: `ctx.loader.builtins.group = Group`）。
    const { Group } = await import('@deepseek-ai/cordis-plugin-loader')
    ctx.loader.builtins.group = Group
    const credsFiber = ctx.plugin(MemoryCredentials)
    await credsFiber

    // 建一个 group 条目，remote-registry 的插件条目挂在它下面——用它自己
    // 返回的 id 作为后续 create() 的 parent 参数。
    const groupId = await ctx.loader.create({ name: 'cordis:group', config: [] })
    // Task 11：同上，指向构建产物 lib/plugin.js，不再是 src/plugin.ts。
    await ctx.loader.create({ name: '../../../remote-registry/lib/plugin.js', config: {} }, groupId)
    await ctx.loader.await()

    expect(ctx.remotes).toBeDefined()
    await ctx.remotes.add(machine({ port: sshd.port }))
    await ctx.remotes.setPrivateKey('gpu-h20', freshPrivateKey())

    // shell-ssh 的条目留在顶层（parent 缺省为根组），跟装着 remote-registry
    // 的那个子组是兄弟关系，不是同一个组。
    await ctx.loader.create({ name: '../../src/plugin.ts', config: { machine: 'gpu-h20' } })
    await ctx.loader.await()

    expect(ctx.shell).toBeDefined()
    const spec = ctx.shell.resolve({ command: 'echo hi' })
    const result = await ctx.shell.run(spec)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('hi\n')
  })
})
