# dsh-mobile 插件层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dsh 能把 bash 工具的执行派到用户自己配置的远程机器上，并提供一个禁掉所有本地进程依赖的 `mobile` profile——全部在 Mac 上开发和验证，不依赖 iOS。

**Architecture:** 三个 npm 包组成一个 pnpm workspace。`@dsh-mobile/remote-registry` 管远程机器的录入、存储与连接探针；`@dsh-mobile/shell-ssh` 实现 dsh 的 `ShellExecutor` 抽象类，用 `ssh2` 把 `ctx.shell` 的执行转到远程；`@dsh-mobile/mobile-app` 是一个 bundle，用 `cordis.patch.yml` 把依赖本地进程的插件行全部禁掉并挂上前两者。测试用 `ssh2` 自带的 `Server` 在进程内起假 sshd，无需 Docker。

**Tech Stack:** TypeScript (ESM, `.ts` 扩展名导入) · cordis 4 · schemastery · ssh2 · vitest · tsdown · pnpm 10 · Node ^22.19

**Spec:** `docs/superpowers/specs/2026-09-04-dsh-mobile-ios-design.md`（§5.2 §5.3 §5.4）

---

## 关键上下文（实施者必读）

你几乎肯定没接触过 DeepSeek Harness。四件事决定了这个计划的形状：

**1. dsh 是 cordis 插件树，配置是 YAML 补丁。** 一个 profile 是 `~/.dsh/profiles/<name>/package.json` 里的 `dsh.profile.bundles` 数组（一串 npm 包名），外加 `cordis.patch.yml`。每个 bundle 自带一个 `cordis.patch.yml`，按 `id` 对插件行做 insert / 改 config / `disabled: true`。**我们不改 dsh 核心，只加 bundle。**

**2. `tool-bash` 走 `ctx.shell`，不走 `ctx.terminals`。** 这是本计划最重要的一条。dsh 有两条独立执行缝：

| 消费者 | 服务 | 契约 |
|---|---|---|
| `tool-bash`（主力） | `ctx.shell` | `ShellExecutor` 抽象类：`resolve()` / `run()` / `start()` |
| `tool-bash-persistent` | `ctx.terminals` | `TerminalBackend`（PTY，本计划**不做**） |

我们实现 `ShellExecutor`。参考实现在本机：
`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-bash-local/`
（看 `lib/types/index.d.ts` 里的 `class LocalBashExecutor extends ShellExecutor`）

**3. 服务实现是带静态成员的 class。** cordis 的服务插件形如：

```ts
export class SshShellExecutor extends ShellExecutor {
  static inject = ['sandboxPolicy']        // 依赖的其他服务
  static Config: z<Config> = z.object({ /* … */ })
  constructor(ctx: Context, config: Config) { super(ctx) }
}
```

`ShellExecutor` 的基类构造会把自己注册到 `ctx.shell`。

**4. vitest 测不出真实 Node 的加载行为——这已经坑过三次。** vitest 走 esbuild 转译，
会掩盖两类只在真实 Node 下发作的错误：

| 陷阱 | 症状 | 规避 |
| --- | --- | --- |
| TypeScript 参数属性 `constructor(readonly x: T)` | 类型剥离下硬 `SyntaxError`，但 vitest 全绿 | 根 tsconfig 已开 `erasableSyntaxOnly`；字段声明后在构造体内赋值 |
| CommonJS 包的具名导入 | `ssh2` 是 CJS，`import { Client } from 'ssh2'` 在真实 Node ESM 下抛 `SyntaxError: Named export not found`，vitest 却能过 | 用 `import ssh2 from 'ssh2'` 再解构；`import type` 不受影响（会被擦除） |

**凡是要装进 dsh 运行的 `src/` 代码，验证时必须用真的 `node` 子进程，不能只看 vitest。**
（探针文件要放在使用该依赖的包目录内——pnpm 严格布局下，裸标识符从 workspace 根解析不到。）

**5. 类型定义在本机可读。** 写代码前先读这两个文件，它们是唯一权威：
- `…/@deepseek-ai/dsh-shell/lib/types/types.d.ts` — `ShellExecRequest` / `ShellExecSpec` / `ShellRunResult` / `ShellProcess`
- `…/@deepseek-ai/dsh-shell/lib/types/index.d.ts` — `ShellExecutor` 抽象类

不要凭记忆写这些类型的字段。

---

## File Structure

```
dsh-mobile/
├── package.json                       # workspace 根
├── pnpm-workspace.yaml
├── tsconfig.json                      # 共享编译配置
├── vitest.config.ts                   # 根配置，跑所有包的测试
└── packages/
    ├── remote-registry/
    │   ├── package.json
    │   ├── src/
    │   │   ├── index.ts               # 插件入口：导出 Config / name / inject / apply
    │   │   ├── url.ts                 # dsh-remote:// 解析与生成（纯函数，无依赖）
    │   │   ├── registry.ts            # RemoteRegistry 服务：增删查、凭据读写
    │   │   ├── probe.ts               # 分层连接探针
    │   │   └── types.ts               # RemoteMachine 等共享类型
    │   └── tests/
    │       ├── unit/url.test.ts
    │       ├── unit/registry.test.ts
    │       └── unit/probe.test.ts
    ├── shell-ssh/
    │   ├── package.json
    │   ├── src/
    │   │   ├── index.ts               # SshShellExecutor（ShellExecutor 实现）
    │   │   ├── connection.ts          # SSH 连接的建立、复用、重连
    │   │   ├── exec.ts                # 单次 exec channel 的执行与输出收集
    │   │   └── errors.ts              # SSH 失败 → dsh 错误码映射
    │   └── tests/
    │       ├── helpers/fake-sshd.ts   # 基于 ssh2 Server 的进程内假 sshd
    │       ├── unit/connection.test.ts
    │       ├── unit/exec.test.ts
    │       └── unit/executor.test.ts
    └── mobile-app/
        ├── package.json               # dsh.bundle.patch 指向下面的 yml
        ├── cordis.patch.yml           # 禁用清单 + 新增行
        └── tests/composition/profile.test.ts
```

**分层原则**：`url.ts` 是纯函数（最先做，最好测）；`registry.ts` 只碰存储；`probe.ts` 只做诊断；`connection.ts` 只管连接生命周期；`exec.ts` 只管一次执行。`index.ts` 把它们组装成服务。每个文件一个职责，任何一个都能单独读懂。

---

## Task 1: 工程骨架

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`

- [ ] **Step 1: 创建 workspace 根配置**

`package.json`:
```json
{
  "name": "dsh-mobile",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "engines": { "node": "^22.19 || >=24" },
  "scripts": {
    "test": "vitest run",
    "test:jitless": "node --jitless ./node_modules/vitest/vitest.mjs run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.10.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/tests/**/*.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
```

`fileParallelism: false` 是照抄 ADP 插件的配置——这些测试会绑定端口和临时目录，并行会互相干扰。

- [ ] **Step 2: 安装并验证**

Run: `cd /Users/choas/Solution/dsh-mobile && pnpm install`
Expected: 成功，生成 `pnpm-lock.yaml` 和 `node_modules/`

Run: `pnpm test`
Expected: `No test files found` —— 这是对的，还没写测试

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.json vitest.config.ts pnpm-lock.yaml
git commit -m "chore: pnpm workspace 骨架"
```

---

## Task 2: `dsh-remote://` URL 解析

先做这个，因为它是纯函数、零依赖、最容易验证，而且是"剪贴板导入"这条主录入路径的核心。

**Files:**
- Create: `packages/remote-registry/package.json`
- Create: `packages/remote-registry/src/types.ts`
- Create: `packages/remote-registry/src/url.ts`
- Test: `packages/remote-registry/tests/unit/url.test.ts`

- [ ] **Step 1: 建包**

`packages/remote-registry/package.json`（`main`/`exports` 在 Task 11 会改指向 `lib/`）:
```json
{
  "name": "@dsh-mobile/remote-registry",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-credentials": "^0.1.1-rc.2"
  }
}
```

- [ ] **Step 2: 定义共享类型**

`packages/remote-registry/src/types.ts`:
```ts
/** 一台用户配置的远程执行机器。私钥不存在这里，只存引用名。 */
export interface RemoteMachine {
  /** 用户可见、profile 内唯一的名字，如 'gpu-h20'。 */
  name: string
  host: string
  port: number
  user: string
  /** 指向 .credentials.yaml 里的条目名，如 'REMOTE_KEY_GPU_H20'。 */
  keyRef: string
  /** 路由用标签，如 ['gpu', 'cuda']。 */
  tags: string[]
  /** 已知的服务器主机公钥指纹（sha256:base64）。缺失表示尚未固定。 */
  hostFingerprint?: string
  /** 远程默认工作目录。 */
  defaultWorkdir?: string
}
```

- [ ] **Step 3: 写失败的测试**

`packages/remote-registry/tests/unit/url.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { formatRemoteUrl, parseRemoteUrl, RemoteUrlError } from '../../src/url.ts'

describe('parseRemoteUrl', () => {
  it('解析完整 URL', () => {
    const m = parseRemoteUrl(
      'dsh-remote://root@example.com:11020/?name=gpu-h20&tags=gpu,cuda&fp=sha256%3AAbC%2B%2F123&workdir=%2Froot%2Fwork',
    )
    expect(m).toEqual({
      name: 'gpu-h20',
      host: 'example.com',
      port: 11020,
      user: 'root',
      keyRef: 'REMOTE_KEY_GPU_H20',
      tags: ['gpu', 'cuda'],
      hostFingerprint: 'sha256:AbC+/123',
      defaultWorkdir: '/root/work',
    })
  })

  it('省略 port 时默认 22', () => {
    expect(parseRemoteUrl('dsh-remote://me@h.test/?name=box').port).toBe(22)
  })

  it('省略 tags 时为空数组', () => {
    expect(parseRemoteUrl('dsh-remote://me@h.test/?name=box').tags).toEqual([])
  })

  it('name 转成合法的 keyRef', () => {
    expect(parseRemoteUrl('dsh-remote://me@h.test/?name=my-box.1').keyRef)
      .toBe('REMOTE_KEY_MY_BOX_1')
  })

  it.each([
    ['协议不对', 'https://me@h.test/?name=box', 'BAD_SCHEME'],
    ['缺 user', 'dsh-remote://h.test/?name=box', 'MISSING_USER'],
    ['缺 name', 'dsh-remote://me@h.test/', 'MISSING_NAME'],
    ['name 非法', 'dsh-remote://me@h.test/?name=has%20space', 'BAD_NAME'],
    ['port 越界', 'dsh-remote://me@h.test:99999/?name=box', 'BAD_PORT'],
    ['整个串不是 URL', 'not a url at all', 'BAD_URL'],
  ])('拒绝：%s', (_label, input, code) => {
    try {
      parseRemoteUrl(input)
      expect.unreachable('应当抛出')
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteUrlError)
      expect((err as RemoteUrlError).code).toBe(code)
    }
  })
})

describe('formatRemoteUrl', () => {
  it('与 parse 往返一致', () => {
    const m = {
      name: 'gpu-h20', host: 'example.com', port: 11020, user: 'root',
      keyRef: 'REMOTE_KEY_GPU_H20', tags: ['gpu', 'cuda'],
      hostFingerprint: 'sha256:AbC+/123', defaultWorkdir: '/root/work',
    }
    expect(parseRemoteUrl(formatRemoteUrl(m))).toEqual(m)
  })

  it('port 为 22 时省略', () => {
    const url = formatRemoteUrl({
      name: 'box', host: 'h.test', port: 22, user: 'me',
      keyRef: 'REMOTE_KEY_BOX', tags: [],
    })
    expect(url).toBe('dsh-remote://me@h.test/?name=box')
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm vitest run packages/remote-registry/tests/unit/url.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/url.ts"`

- [ ] **Step 5: 实现**

`packages/remote-registry/src/url.ts`:
```ts
import type { RemoteMachine } from './types.ts'

export type RemoteUrlErrorCode =
  | 'BAD_URL' | 'BAD_SCHEME' | 'MISSING_USER' | 'MISSING_NAME'
  | 'BAD_NAME' | 'BAD_PORT'

export class RemoteUrlError extends Error {
  constructor(message: string, readonly code: RemoteUrlErrorCode) {
    super(message)
    this.name = 'RemoteUrlError'
  }
}

export const REMOTE_URL_SCHEME = 'dsh-remote:'

/** 机器名：字母数字起头，其后允许字母数字、连字符、点、下划线。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 由机器名推导凭据引用名，保证是合法的环境变量名。 */
export function keyRefForName(name: string): string {
  return `REMOTE_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

export function parseRemoteUrl(input: string): RemoteMachine {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new RemoteUrlError(`不是合法的 URL: ${input}`, 'BAD_URL')
  }
  if (url.protocol !== REMOTE_URL_SCHEME) {
    throw new RemoteUrlError(`协议必须是 ${REMOTE_URL_SCHEME}//，收到 ${url.protocol}//`, 'BAD_SCHEME')
  }
  const user = decodeURIComponent(url.username)
  if (!user) throw new RemoteUrlError('URL 缺少用户名（应为 user@host）', 'MISSING_USER')

  const name = url.searchParams.get('name')
  if (!name) throw new RemoteUrlError('URL 缺少 name 参数', 'MISSING_NAME')
  if (!NAME_RE.test(name)) {
    throw new RemoteUrlError(`机器名不合法: ${name}（只允许字母数字与 . _ -，且须字母数字开头）`, 'BAD_NAME')
  }

  // 注意：WHATWG URL 对越界端口是在 new URL() 里就抛，根本走不到这里。
  // 越界的情况须在上面的 catch 块里用正则识别（实测结论，见下方说明）。
  // 这里仍然必要——端口 0 不会让 new URL() 抛，只能在这一层拦下。
  const port = url.port ? Number(url.port) : DEFAULT_SSH_PORT
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new RemoteUrlError(`端口越界: ${url.port}`, 'BAD_PORT')
  }

  const tagsRaw = url.searchParams.get('tags')
  const machine: RemoteMachine = {
    name,
    host: url.hostname,
    port,
    user,
    keyRef: keyRefForName(name),
    tags: tagsRaw ? tagsRaw.split(',').filter(Boolean) : [],
  }
  const fp = url.searchParams.get('fp')
  if (fp) machine.hostFingerprint = fp
  const workdir = url.searchParams.get('workdir')
  if (workdir) machine.defaultWorkdir = workdir
  return machine
}

export function formatRemoteUrl(machine: RemoteMachine): string {
  const url = new URL(`${REMOTE_URL_SCHEME}//${machine.host}/`)
  url.username = encodeURIComponent(machine.user)
  if (machine.port !== 22) url.port = String(machine.port)
  url.searchParams.set('name', machine.name)
  if (machine.tags.length) url.searchParams.set('tags', machine.tags.join(','))
  if (machine.hostFingerprint) url.searchParams.set('fp', machine.hostFingerprint)
  if (machine.defaultWorkdir) url.searchParams.set('workdir', machine.defaultWorkdir)
  return url.toString()
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm vitest run packages/remote-registry/tests/unit/url.test.ts`
Expected: PASS，12 个用例全绿

如果 `formatRemoteUrl` 的往返测试失败，多半是 `URL` 对 `searchParams` 的编码与手写期望不一致——以 `parseRemoteUrl(formatRemoteUrl(m))` 的结果为准，不要去改期望值里的编码细节。

**上面的参考实现在 `BAD_PORT` 一项上是错的**（实施时实测发现）：WHATWG `new URL()`
对 `1..65535` 之外的端口在**构造时就抛**，所以函数体里的范围检查永远等不到越界值。
须在 `catch` 块里用锚定的正则 `...:(\d+)(?:[/?#]|$)` 识别出越界端口并报 `BAD_PORT`，
其余才落到 `BAD_URL`。函数体里的范围检查仍要保留——端口 `0` 不会让 `new URL()` 抛，
只能在那一层拦下，这也是它没有变成死代码的原因。

同样要注意 `formatRemoteUrl`：WHATWG 的 `port` setter 对非法值是**静默 no-op**，
不抛异常。所以越界端口会被悄悄丢掉，格式化出的 URL 解析回来变成 22。
两个方向都要走同一个 `assertValidMachine`。

- [ ] **Step 7: Commit**

```bash
git add packages/remote-registry
git commit -m "feat(remote-registry): dsh-remote:// URL 解析与生成"
```

---

## Task 3: 假 sshd 测试夹具

`shell-ssh` 的每个测试都要一台 SSH 服务器。`ssh2` 自带 `Server`，所以在进程内起一台，不用 Docker。**先把夹具做扎实，后面三个任务都靠它。**

**Files:**
- Create: `packages/shell-ssh/package.json`
- Create: `packages/shell-ssh/tests/helpers/fake-sshd.ts`
- Test: `packages/shell-ssh/tests/unit/fake-sshd.test.ts`

- [ ] **Step 1: 建包**

`packages/shell-ssh/package.json`:
```json
{
  "name": "@dsh-mobile/shell-ssh",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "ssh2": "^1.16.0",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@dsh-mobile/remote-registry": "workspace:*"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-shell": "^0.1.1-rc.2"
  },
  "devDependencies": {
    "@types/ssh2": "^1.15.0"
  }
}
```

Run: `pnpm install`

- [ ] **Step 2: 写夹具**

`packages/shell-ssh/tests/helpers/fake-sshd.ts`:
```ts
import { generateKeyPairSync } from 'node:crypto'
// ssh2 是 CommonJS，具名导入在真实 Node ESM 下抛 SyntaxError；
// vitest 的 esbuild 会掩盖这一点，所以别"顺手改回"具名导入。
// 类型导入会被擦除，不受影响。
import ssh2 from 'ssh2'
import type { Connection } from 'ssh2'

const { Server } = ssh2

export interface FakeCommandResult {
  stdout?: string
  stderr?: string
  exitCode?: number
  /** 写完输出后等这么久再关闭 channel，用来测超时与取消。 */
  delayMs?: number
  /** 不返回 exit-status，而是报告被信号杀死。 */
  killedBy?: string
}

export interface FakeSshdOptions {
  /** 命令原文 → 结果。未命中的命令返回 exitCode 127。 */
  commands?: Record<string, FakeCommandResult>
  /** 认证一律失败，用来测认证错误路径。 */
  rejectAuth?: boolean
}

export interface FakeSshd {
  port: number
  hostKeyPublic: string
  /** 记录服务器实际收到的命令，用于断言。 */
  received: string[]
  /**
   * 记录每次认证尝试。没有它，一个把 privateKey 整个丢掉的连接池
   * 也能通过全部测试——因为测试只能看到"连上了"。
   */
  authAttempts: Array<{ method: string; username: string }>
  close(): Promise<void>
}

/** 起一台进程内假 sshd，监听 127.0.0.1 的随机端口。 */
export async function startFakeSshd(options: FakeSshdOptions = {}): Promise<FakeSshd> {
  // ssh2 的密钥解析器只认 OpenSSH 新格式或 PKCS1，不认通用 PKCS8。
  // Node 无法把 ed25519 导成 OpenSSH 格式，所以这里用 RSA + pkcs1，
  // 否则 new Server() 直接抛 "Cannot parse privateKey: Unsupported key format"。
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const received: string[] = []
  const authAttempts: Array<{ method: string; username: string }> = []
  const openConnections = new Set<Connection>()

  const server = new Server({ hostKeys: [privateKey] }, (client: Connection) => {
    client.on('authentication', (auth) => {
      authAttempts.push({ method: auth.method, username: auth.username })
      // ssh2 的 Client 总是先用 method 'none' 探一次。无条件 accept 会让
      // 连接在这一步就成功，凭据根本不会被发送——测试也就验证不了
      // 连接池有没有真的把密钥传出去。拒掉 none，逼客户端走真方法。
      if (auth.method === 'none') return auth.reject()
      if (options.rejectAuth) auth.reject(['publickey'])
      else auth.accept()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          received.push(info.command)
          const result = options.commands?.[info.command] ?? { exitCode: 127, stderr: 'command not found\n' }
          const stream = acceptExec()
          const finish = () => {
            if (result.stdout) stream.write(result.stdout)
            if (result.stderr) stream.stderr.write(result.stderr)
            if (result.killedBy) stream.exit(result.killedBy)
            else stream.exit(result.exitCode ?? 0)
            stream.end()
          }
          if (result.delayMs) setTimeout(finish, result.delayMs)
          else finish()
        })
      })
    })
    client.on('error', () => { /* 测试里断开连接是正常的 */ })
  })

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })

  return {
    port,
    hostKeyPublic: publicKey,
    received,
    authAttempts,
    // server.close() 只停止接受新连接，回调要等所有现存连接关闭才触发。
    // 测试若忘了 end 客户端就会永久挂起，所以这里显式断开。
    close: () => new Promise<void>((resolve) => {
      for (const conn of openConnections) conn.end()
      server.close(() => resolve())
    }),
  }
}
```

- [ ] **Step 3: 写夹具自身的测试**

夹具是后面所有测试的地基，它自己必须先被验证。

`packages/shell-ssh/tests/unit/fake-sshd.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
// ssh2 是 CommonJS：具名导入在真实 Node ESM 下抛 SyntaxError。
// 这里虽然只跑在 vitest 里，仍统一写法，避免被复制到 src/ 时踩坑。
import ssh2 from 'ssh2'

const { Client } = ssh2
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'

let sshd: FakeSshd | undefined
afterEach(async () => { await sshd?.close(); sshd = undefined })

function execOnce(port: number, command: string) {
  return new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
    const client = new Client()
    client
      .on('ready', () => {
        client.exec(command, (err, stream) => {
          if (err) return reject(err)
          let stdout = ''
          stream.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
          stream.on('close', (code: number | null) => { client.end(); resolve({ stdout, code }) })
        })
      })
      .on('error', reject)
      .connect({ host: '127.0.0.1', port, username: 'tester', password: 'x' })
  })
}

describe('startFakeSshd', () => {
  it('执行已注册的命令并返回退出码', async () => {
    sshd = await startFakeSshd({ commands: { 'echo hi': { stdout: 'hi\n', exitCode: 0 } } })
    const result = await execOnce(sshd.port, 'echo hi')
    expect(result.stdout).toBe('hi\n')
    expect(result.code).toBe(0)
    expect(sshd.received).toEqual(['echo hi'])
  })

  it('未注册的命令返回 127', async () => {
    sshd = await startFakeSshd()
    expect((await execOnce(sshd.port, 'nope')).code).toBe(127)
  })
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/shell-ssh/tests/unit/fake-sshd.test.ts`
Expected: PASS，2 个用例

若报 `Cannot find module 'ssh2'`，回到 Step 1 确认 `pnpm install` 在 workspace 根跑过。

- [ ] **Step 5: Commit**

```bash
git add packages/shell-ssh
git commit -m "test(shell-ssh): 基于 ssh2 Server 的进程内假 sshd 夹具"
```

---

## Task 4: SSH 连接管理

**Files:**
- Create: `packages/shell-ssh/src/errors.ts`
- Create: `packages/shell-ssh/src/connection.ts`
- Test: `packages/shell-ssh/tests/unit/connection.test.ts`

- [ ] **Step 1: 定义错误映射**

`packages/shell-ssh/src/errors.ts`:
```ts
/** 可路由的 SSH 失败分类。recoverable 决定 agent 是否值得重试。 */
export type SshErrorCode =
  | 'SSH_UNREACHABLE'      // TCP 连不上
  | 'SSH_AUTH_FAILED'      // 认证被拒
  | 'SSH_FINGERPRINT_MISMATCH' // 主机指纹与已固定值不符
  | 'SSH_DISCONNECTED'     // 连接中途断开
  | 'SSH_NO_MACHINE'       // 注册表里没有这台机器

export class SshError extends Error {
  constructor(
    message: string,
    readonly code: SshErrorCode,
    readonly recoverable: boolean,
  ) {
    super(message)
    this.name = 'SshError'
  }
}

export function isSshError(value: unknown): value is SshError {
  return value instanceof SshError
}
```

- [ ] **Step 2: 写失败的测试**

`packages/shell-ssh/tests/unit/connection.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { SshConnectionPool } from '../../src/connection.ts'
import { SshError } from '../../src/errors.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'

let sshd: FakeSshd | undefined
let pool: SshConnectionPool | undefined

afterEach(async () => {
  await pool?.disposeAll(); pool = undefined
  await sshd?.close(); sshd = undefined
})

function machineFor(port: number): RemoteMachine {
  return { name: 'test', host: '127.0.0.1', port, user: 'tester', keyRef: 'REMOTE_KEY_TEST', tags: [] }
}

describe('SshConnectionPool', () => {
  it('同一台机器复用同一条连接', async () => {
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    const machine = machineFor(sshd.port)
    const [a, b] = await Promise.all([pool.acquire(machine), pool.acquire(machine)])
    expect(a).toBe(b)
    expect(pool.size).toBe(1)
  })

  it('连不上时抛 SSH_UNREACHABLE 且标记为可恢复', async () => {
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    // 端口 1 上不会有 sshd
    await expect(pool.acquire(machineFor(1))).rejects.toSatisfy(
      (err: unknown) => err instanceof SshError && err.code === 'SSH_UNREACHABLE' && err.recoverable,
    )
  })

  it('认证失败时抛 SSH_AUTH_FAILED 且标记为不可恢复', async () => {
    sshd = await startFakeSshd({ rejectAuth: true })
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'wrong' }) })
    await expect(pool.acquire(machineFor(sshd.port))).rejects.toSatisfy(
      (err: unknown) => err instanceof SshError && err.code === 'SSH_AUTH_FAILED' && !err.recoverable,
    )
  })

  it('服务器关闭后，下一次 acquire 重新建连', async () => {
    sshd = await startFakeSshd()
    const port = sshd.port
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    await pool.acquire(machineFor(port))
    expect(pool.size).toBe(1)

    await sshd.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(pool.size).toBe(0)   // 断线后自动从池里摘除

    sshd = await startFakeSshd()
    await pool.acquire(machineFor(sshd.port))
    expect(pool.size).toBe(1)
  })

  it('disposeAll 清空连接池', async () => {
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    await pool.acquire(machineFor(sshd.port))
    await pool.disposeAll()
    expect(pool.size).toBe(0)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run packages/shell-ssh/tests/unit/connection.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/connection.ts"`

- [ ] **Step 4: 实现**

`packages/shell-ssh/src/connection.ts`:
```ts
// ssh2 是 CommonJS：具名导入在真实 Node ESM 下抛 SyntaxError，而 vitest 能过。
// 这份代码要装进 dsh 用真 Node 跑，所以必须默认导入再解构。
import ssh2 from 'ssh2'
import type { Client } from 'ssh2'
// SshCredentials 只在 remote-registry 里定义一次；这里复用，避免两处定义漂移。
import type { RemoteMachine, SshCredentials } from '@dsh-mobile/remote-registry'
import { SshError } from './errors.ts'

const { Client: SshClient } = ssh2

export interface SshConnectionPoolOptions {
  /** 为一台机器取认证材料。 */
  credentials(machine: RemoteMachine): Promise<SshCredentials>
  /** TCP + 握手的总超时，默认 15 秒。 */
  connectTimeoutMs?: number
}

/** 按 host:port:user 复用 SSH 连接；断线自动摘除，下次 acquire 重连。 */
export class SshConnectionPool {
  private readonly clients = new Map<string, Client>()
  private readonly pending = new Map<string, Promise<Client>>()

  constructor(private readonly options: SshConnectionPoolOptions) {}

  get size(): number {
    return this.clients.size
  }

  private static keyOf(machine: RemoteMachine): string {
    return `${machine.user}@${machine.host}:${machine.port}`
  }

  async acquire(machine: RemoteMachine): Promise<Client> {
    const key = SshConnectionPool.keyOf(machine)
    const existing = this.clients.get(key)
    if (existing) return existing
    const inflight = this.pending.get(key)
    if (inflight) return inflight

    const attempt = this.connect(machine, key)
    this.pending.set(key, attempt)
    try {
      return await attempt
    } finally {
      this.pending.delete(key)
    }
  }

  private async connect(machine: RemoteMachine, key: string): Promise<Client> {
    const creds = await this.options.credentials(machine)
    const client = new SshClient()

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (err?: SshError) => {
        if (settled) return
        settled = true
        err ? reject(err) : resolve()
      }

      client.on('ready', () => settle())
      client.on('error', (err: Error & { level?: string }) => {
        // ssh2 用 level 区分失败阶段：认证失败是终局，其余按可重试处理。
        const authFailed = err.level === 'client-authentication'
        settle(
          authFailed
            ? new SshError(`认证被 ${machine.name} 拒绝：${err.message}`, 'SSH_AUTH_FAILED', false)
            : new SshError(`连不上 ${machine.name} (${machine.host}:${machine.port})：${err.message}`, 'SSH_UNREACHABLE', true),
        )
      })
      client.on('close', () => {
        this.clients.delete(key)
        settle(new SshError(`到 ${machine.name} 的连接已关闭`, 'SSH_DISCONNECTED', true))
      })

      client.connect({
        host: machine.host,
        port: machine.port,
        username: machine.user,
        privateKey: creds.privateKey,
        passphrase: creds.passphrase,
        password: creds.password,
        readyTimeout: this.options.connectTimeoutMs ?? 15_000,
      })
    })

    this.clients.set(key, client)
    return client
  }

  async disposeAll(): Promise<void> {
    for (const client of this.clients.values()) client.end()
    this.clients.clear()
    this.pending.clear()
  }
}
```

注意 `close` 处理器同时承担两个职责：连接建立阶段的失败上报，和建立之后的自动摘除。`settled` 标志保证前者只触发一次，而 `this.clients.delete(key)` 每次都执行——这正是"服务器关闭后重连"那个测试要验证的行为。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/shell-ssh/tests/unit/connection.test.ts`
Expected: PASS，5 个用例

- [ ] **Step 6: Commit**

```bash
git add packages/shell-ssh/src packages/shell-ssh/tests
git commit -m "feat(shell-ssh): SSH 连接池，含复用、断线摘除与错误分类"
```

---

## Task 5: 远程执行与输出收集

**Files:**
- Create: `packages/shell-ssh/src/exec.ts`
- Test: `packages/shell-ssh/tests/unit/exec.test.ts`

- [ ] **Step 1: 写失败的测试**

`packages/shell-ssh/tests/unit/exec.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
// ssh2 是 CommonJS：具名导入在真实 Node ESM 下抛 SyntaxError。
// 这里虽然只跑在 vitest 里，仍统一写法，避免被复制到 src/ 时踩坑。
import ssh2 from 'ssh2'

const { Client } = ssh2
import { execRemote } from '../../src/exec.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'

let sshd: FakeSshd | undefined
let client: Client | undefined

afterEach(async () => {
  client?.end(); client = undefined
  await sshd?.close(); sshd = undefined
})

async function connect(port: number): Promise<Client> {
  const c = new Client()
  await new Promise<void>((resolve, reject) => {
    c.on('ready', () => resolve()).on('error', reject)
     .connect({ host: '127.0.0.1', port, username: 'tester', password: 'x' })
  })
  return c
}

describe('execRemote', () => {
  it('收集 stdout/stderr 与退出码', async () => {
    sshd = await startFakeSshd({
      commands: { 'run it': { stdout: 'out', stderr: 'err', exitCode: 3 } },
    })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'run it', timeoutMs: 5000, stdoutMaxBytes: 1024 })
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.truncated).toBe(false)
  })

  it('超过 stdoutMaxBytes 时截断并标记', async () => {
    sshd = await startFakeSshd({ commands: { big: { stdout: 'x'.repeat(100), exitCode: 0 } } })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'big', timeoutMs: 5000, stdoutMaxBytes: 10 })
    expect(result.stdout.length).toBe(10)
    expect(result.truncated).toBe(true)
    expect(result.exitCode).toBe(0)   // 截断不改变退出码
  })

  it('超时返回 timedOut 而不是抛异常', async () => {
    sshd = await startFakeSshd({ commands: { slow: { stdout: 'late', delayMs: 3000 } } })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'slow', timeoutMs: 150, stdoutMaxBytes: 1024 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('AbortSignal 触发时返回 aborted', async () => {
    sshd = await startFakeSshd({ commands: { slow: { stdout: 'late', delayMs: 3000 } } })
    client = await connect(sshd.port)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const result = await execRemote(client, {
      command: 'slow', timeoutMs: 5000, stdoutMaxBytes: 1024, signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  })

  it('被信号杀死时记录 signal', async () => {
    sshd = await startFakeSshd({ commands: { doomed: { killedBy: 'TERM' } } })
    client = await connect(sshd.port)
    const result = await execRemote(client, { command: 'doomed', timeoutMs: 5000, stdoutMaxBytes: 1024 })
    expect(result.signal).toBe('SIGTERM')
    expect(result.exitCode).toBeNull()
  })

  it('把 workdir 与 env 前置到命令里', async () => {
    sshd = await startFakeSshd({ commands: {} })
    client = await connect(sshd.port)
    await execRemote(client, {
      command: 'echo hi', timeoutMs: 5000, stdoutMaxBytes: 1024,
      workdir: '/root/work', env: { FOO: 'bar baz' },
    })
    expect(sshd.received[0]).toBe(`cd '/root/work' && export FOO='bar baz' && echo hi`)
  })

  it('转义 workdir 与 env 里的单引号', async () => {
    sshd = await startFakeSshd({ commands: {} })
    client = await connect(sshd.port)
    await execRemote(client, {
      command: 'x', timeoutMs: 5000, stdoutMaxBytes: 1024, env: { Q: "it's" },
    })
    expect(sshd.received[0]).toBe(`export Q='it'\\''s' && x`)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/shell-ssh/tests/unit/exec.test.ts`
Expected: FAIL —— 无法解析 `../../src/exec.ts`

- [ ] **Step 3: 实现**

`packages/shell-ssh/src/exec.ts`:
```ts
import type { Client } from 'ssh2'  // 类型导入会被擦除，不受 CJS 限制

export interface RemoteExecOptions {
  command: string
  timeoutMs: number
  stdoutMaxBytes: number
  workdir?: string
  env?: Record<string, string>
  stdin?: string
  signal?: AbortSignal
  /** 每收到一段输出就回调，用于 start() 的增量读取。 */
  onData?(chunk: string, stream: 'stdout' | 'stderr'): void
}

export interface RemoteExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  truncated: boolean
}

/** 用单引号包裹并转义，供 POSIX shell 安全解析。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 把 workdir 与 env 折进一条命令——SSH exec 没有独立的 cwd/env 通道。 */
export function buildRemoteCommand(options: Pick<RemoteExecOptions, 'command' | 'workdir' | 'env'>): string {
  const parts: string[] = []
  if (options.workdir) parts.push(`cd ${shellQuote(options.workdir)}`)
  for (const [key, value] of Object.entries(options.env ?? {})) {
    parts.push(`export ${key}=${shellQuote(value)}`)
  }
  parts.push(options.command)
  return parts.join(' && ')
}

export function execRemote(client: Client, options: RemoteExecOptions): Promise<RemoteExecResult> {
  return new Promise((resolve, reject) => {
    const command = buildRemoteCommand(options)
    client.exec(command, (err, stream) => {
      if (err) return reject(err)

      let stdout = ''
      let stderr = ''
      let truncated = false
      let timedOut = false
      let aborted = false
      let exitCode: number | null = null
      let signal: NodeJS.Signals | null = null
      let settled = false

      const append = (chunk: string, which: 'stdout' | 'stderr') => {
        options.onData?.(chunk, which)
        const current = which === 'stdout' ? stdout : stderr
        const room = options.stdoutMaxBytes - current.length
        if (room <= 0) { truncated = true; return }
        const slice = chunk.length > room ? (truncated = true, chunk.slice(0, room)) : chunk
        if (which === 'stdout') stdout += slice
        else stderr += slice
      }

      const timer = setTimeout(() => { timedOut = true; stream.close() }, options.timeoutMs)
      const onAbort = () => { aborted = true; stream.close() }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        resolve({
          stdout, stderr,
          exitCode: timedOut || aborted ? null : exitCode,
          signal, timedOut, aborted, truncated,
        })
      }

      stream.on('data', (chunk: Buffer) => append(chunk.toString(), 'stdout'))
      stream.stderr.on('data', (chunk: Buffer) => append(chunk.toString(), 'stderr'))
      stream.on('exit', (code: number | null, sig?: string) => {
        exitCode = code
        if (sig) signal = (sig.startsWith('SIG') ? sig : `SIG${sig}`) as NodeJS.Signals
      })
      stream.on('close', finish)

      if (options.stdin !== undefined) stream.end(options.stdin)
    })
  })
}
```

`stdoutMaxBytes` 对 stdout 和 stderr 各自独立计数——与 `dsh-bash-local` 的行为一致，`ShellRunResult` 里两者也是分开的 `CollectedOutput`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/shell-ssh/tests/unit/exec.test.ts`
Expected: PASS，7 个用例

- [ ] **Step 5: Commit**

```bash
git add packages/shell-ssh/src/exec.ts packages/shell-ssh/tests/unit/exec.test.ts
git commit -m "feat(shell-ssh): 远程执行、输出截断、超时与取消"
```

---

## Task 6: `SshShellExecutor` 服务

把前两个任务组装成 dsh 认识的服务。**动手前先读**
`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-shell/lib/types/index.d.ts`
和同目录的 `types.d.ts`，确认 `ShellExecutor` 的方法签名与 `ShellRunResult` 的字段。

**Files:**
- Create: `packages/shell-ssh/src/index.ts`
- Test: `packages/shell-ssh/tests/unit/executor.test.ts`

- [ ] **Step 1: 写失败的测试**

`packages/shell-ssh/tests/unit/executor.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { SshShellExecutor, resolveSpec, DEFAULTS } from '../../src/index.ts'
import { SshConnectionPool } from '../../src/connection.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'

let sshd: FakeSshd | undefined
let pool: SshConnectionPool | undefined

afterEach(async () => {
  await pool?.disposeAll(); pool = undefined
  await sshd?.close(); sshd = undefined
})

function machineFor(port: number): RemoteMachine {
  return {
    name: 'gpu', host: '127.0.0.1', port, user: 'tester',
    keyRef: 'REMOTE_KEY_GPU', tags: ['gpu'], defaultWorkdir: '/root/work',
  }
}

describe('resolveSpec', () => {
  it('缺省字段用默认值补全', () => {
    const spec = resolveSpec({ command: 'ls' }, machineFor(22))
    expect(spec.command).toBe('ls')
    expect(spec.workdir).toBe('/root/work')       // 取机器的 defaultWorkdir
    expect(spec.timeoutMs).toBe(DEFAULTS.timeoutMs)
    expect(spec.stdoutMaxBytes).toBe(DEFAULTS.stdoutMaxBytes)
  })

  it('请求里的值覆盖默认值', () => {
    const spec = resolveSpec({ command: 'ls', workdir: '/tmp', timeoutMs: 99 }, machineFor(22))
    expect(spec.workdir).toBe('/tmp')
    expect(spec.timeoutMs).toBe(99)
  })

  it('机器没有 defaultWorkdir 时回落到 ~', () => {
    const machine = { ...machineFor(22), defaultWorkdir: undefined }
    expect(resolveSpec({ command: 'ls' }, machine).workdir).toBe('~')
  })
})

describe('SshShellExecutor.run', () => {
  it('返回符合 ShellRunResult 形状的结果', async () => {
    sshd = await startFakeSshd({
      commands: { [`cd '/root/work' && nvidia-smi`]: { stdout: 'H20\n', exitCode: 0 } },
    })
    const machine = machineFor(sshd.port)
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    const executor = new SshShellExecutor({ pool, machine })

    const result = await executor.run(resolveSpec({ command: 'nvidia-smi' }, machine))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('H20\n')
    expect(result.stderr.text).toBe('')
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it('连不上时抛 SshError 而不是静默失败', async () => {
    const machine = machineFor(1)
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    const executor = new SshShellExecutor({ pool, machine })
    await expect(executor.run(resolveSpec({ command: 'ls' }, machine))).rejects.toThrow(/连不上/)
  })
})

describe('SshShellExecutor.start', () => {
  it('增量读取输出，结束后 done 落定', async () => {
    sshd = await startFakeSshd({
      commands: { [`cd '/root/work' && stream`]: { stdout: 'chunk', exitCode: 0 } },
    })
    const machine = machineFor(sshd.port)
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    const executor = new SshShellExecutor({ pool, machine })

    const proc = executor.start(resolveSpec({ command: 'stream' }, machine))
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.exitCode).toBe(0)
    expect(proc.readOutput().delta).toBe('chunk')
    expect(proc.readOutput().delta).toBe('')   // 读过的不再重复返回
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/shell-ssh/tests/unit/executor.test.ts`
Expected: FAIL —— 无法解析 `../../src/index.ts`

- [ ] **Step 3: 实现**

`packages/shell-ssh/src/index.ts`:
```ts
import type { RemoteMachine } from '@dsh-mobile/remote-registry'
import { SshConnectionPool } from './connection.ts'
import { execRemote, type RemoteExecResult } from './exec.ts'

export { SshConnectionPool } from './connection.ts'
export { SshError, isSshError, type SshErrorCode } from './errors.ts'
export { execRemote, buildRemoteCommand, shellQuote } from './exec.ts'

export const DEFAULTS = {
  timeoutMs: 120_000,
  stdoutMaxBytes: 256 * 1024,
} as const

/** `ShellExecRequest` 的结构性子集——避免测试期依赖 dsh 运行时。 */
export interface ExecRequestLike {
  command: string
  workdir?: string | undefined
  timeoutMs?: number | undefined
  stdoutMaxBytes?: number | undefined
  signal?: AbortSignal | undefined
  stdin?: string | undefined
  env?: Record<string, string> | undefined
}

export interface ExecSpecLike extends ExecRequestLike {
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
}

/** 把请求补全为完整规格。机器的 defaultWorkdir 优先于 `~`。 */
export function resolveSpec(request: ExecRequestLike, machine: RemoteMachine): ExecSpecLike {
  return {
    ...request,
    workdir: request.workdir ?? machine.defaultWorkdir ?? '~',
    timeoutMs: request.timeoutMs ?? DEFAULTS.timeoutMs,
    stdoutMaxBytes: request.stdoutMaxBytes ?? DEFAULTS.stdoutMaxBytes,
  }
}

export interface CollectedOutputLike {
  text: string
  truncated: boolean
}

export interface RunResultLike {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: CollectedOutputLike
  stderr: CollectedOutputLike
}

export interface ShellProcessLike {
  status: 'running' | 'completed' | 'killed'
  exitCode: number | null
  signal: NodeJS.Signals | null
  readonly done: Promise<void>
  readOutput(): { delta: string; lossy: boolean }
  kill(): boolean
}

export interface SshShellExecutorOptions {
  pool: SshConnectionPool
  machine: RemoteMachine
}

/**
 * 把 dsh 的 shell 执行转到一台远程机器。
 *
 * 这是 dsh `ShellExecutor` 抽象类的运行时形状。挂进 cordis 时由
 * `plugin.ts` 用 `class extends ShellExecutor` 包一层（见 Task 7）；
 * 本类保持对 dsh 运行时零依赖，因此可以被单独测试。
 */
export class SshShellExecutor {
  constructor(private readonly options: SshShellExecutorOptions) {}

  resolve(request: ExecRequestLike): ExecSpecLike {
    return resolveSpec(request, this.options.machine)
  }

  async run(spec: ExecSpecLike): Promise<RunResultLike> {
    const client = await this.options.pool.acquire(this.options.machine)
    const result = await execRemote(client, {
      command: spec.command,
      timeoutMs: spec.timeoutMs,
      stdoutMaxBytes: spec.stdoutMaxBytes,
      workdir: spec.workdir,
      env: spec.env,
      stdin: spec.stdin,
      signal: spec.signal,
    })
    return SshShellExecutor.toRunResult(result, spec.timeoutMs)
  }

  private static toRunResult(result: RemoteExecResult, timeoutMs: number): RunResultLike {
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      timeoutMs,
      stdout: { text: result.stdout, truncated: result.truncated },
      stderr: { text: result.stderr, truncated: result.truncated },
    }
  }

  start(spec: ExecSpecLike): ShellProcessLike {
    let pending = ''
    const controller = new AbortController()
    if (spec.signal) spec.signal.addEventListener('abort', () => controller.abort(), { once: true })

    const proc: ShellProcessLike = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      readOutput() {
        const delta = pending
        pending = ''
        return { delta, lossy: false }
      },
      kill() {
        if (proc.status !== 'running') return false
        controller.abort()
        proc.status = 'killed'
        return true
      },
    }

    proc.done = (async () => {
      const client = await this.options.pool.acquire(this.options.machine)
      const result = await execRemote(client, {
        command: spec.command,
        timeoutMs: spec.timeoutMs,
        stdoutMaxBytes: spec.stdoutMaxBytes,
        workdir: spec.workdir,
        env: spec.env,
        stdin: spec.stdin,
        signal: controller.signal,
        onData: (chunk) => { pending += chunk },
      })
      proc.exitCode = result.exitCode
      proc.signal = result.signal
      if (proc.status === 'running') proc.status = 'completed'
    })()

    return proc
  }
}

export default SshShellExecutor
```

**设计说明**：`SshShellExecutor` 刻意不 `extends ShellExecutor`。dsh 的 `ShellExecutor` 基类构造需要一个真的 cordis `Context` 才能把自己注册到 `ctx.shell`，那会让单元测试被迫拉起整个 dsh 运行时。所以这里保留纯逻辑，Task 7 里再用一层薄适配接进 cordis。这也是为什么上面定义了 `ExecRequestLike` 等结构性类型——它们与 dsh 的真实类型字段一致，适配层做类型对齐。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/shell-ssh/tests/unit/executor.test.ts`
Expected: PASS，6 个用例

- [ ] **Step 5: Commit**

```bash
git add packages/shell-ssh/src/index.ts packages/shell-ssh/tests/unit/executor.test.ts
git commit -m "feat(shell-ssh): SshShellExecutor，实现 resolve/run/start"
```

---

## Task 7: cordis 适配层

**Files:**
- Create: `packages/shell-ssh/src/plugin.ts`
- Modify: `packages/shell-ssh/src/index.ts`（末尾追加一行 re-export）
- Test: `packages/shell-ssh/tests/unit/plugin.test.ts`

- [ ] **Step 1: 写失败的测试**

`packages/shell-ssh/tests/unit/plugin.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { Config } from '../../src/plugin.ts'

describe('plugin Config', () => {
  it('接受合法配置', () => {
    expect(() => Config({ machine: 'gpu-h20' })).not.toThrow()
  })

  it('machine 必填', () => {
    expect(() => Config({})).toThrow()
  })

  it('connectTimeoutMs 有默认值', () => {
    expect(Config({ machine: 'gpu-h20' }).connectTimeoutMs).toBe(15_000)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/shell-ssh/tests/unit/plugin.test.ts`
Expected: FAIL —— 无法解析 `../../src/plugin.ts`

- [ ] **Step 3: 实现**

`packages/shell-ssh/src/plugin.ts`:
```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SshConnectionPool } from './connection.ts'
import { SshError } from './errors.ts'
import { SshShellExecutor } from './index.ts'

export interface SshShellConfig {
  /** remote-registry 里注册的机器名。 */
  machine: string
  connectTimeoutMs?: number
}

export const Config: z<SshShellConfig> = z.object({
  machine: z.string().required(),
  connectTimeoutMs: z.number().default(15_000),
})

export const name = 'shell-ssh'

/**
 * 把远程执行接到 `ctx.shell`。
 *
 * 依赖 `remotes`（remote-registry 提供）取机器定义与凭据。
 */
export class SshShellPlugin extends ShellExecutor {
  static inject = ['remotes']
  static Config = Config

  private readonly pool: SshConnectionPool
  private readonly inner: Promise<SshShellExecutor>

  constructor(ctx: Context, config: SshShellConfig) {
    super(ctx)
    this.pool = new SshConnectionPool({
      connectTimeoutMs: config.connectTimeoutMs,
      credentials: (machine) => ctx.remotes.credentialsFor(machine),
    })
    this.inner = (async () => {
      const machine = await ctx.remotes.get(config.machine)
      if (!machine) {
        throw new SshError(`注册表里没有机器 '${config.machine}'`, 'SSH_NO_MACHINE', false)
      }
      return new SshShellExecutor({ pool: this.pool, machine })
    })()
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    // resolve 必须同步，所以这里只补 dsh 侧的默认值；
    // 机器相关的 workdir 缺省在 run/start 里由 SshShellExecutor.resolve 二次补全。
    return {
      ...request,
      workdir: request.workdir ?? '~',
      timeoutMs: request.timeoutMs ?? 120_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 256 * 1024,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const inner = await this.inner
    return (await inner.run(spec)) as ShellRunResult
  }

  start(spec: ShellExecSpec): ShellProcess {
    let real: ShellProcess | undefined
    let pending = ''
    const proc = {
      status: 'running' as const,
      exitCode: null as number | null,
      signal: null as NodeJS.Signals | null,
      done: Promise.resolve(),
      readOutput() {
        if (real) {
          const read = real.readOutput()
          const delta = pending + read.delta
          pending = ''
          return { ...read, delta }
        }
        return { delta: '', lossy: false }
      },
      kill: () => real?.kill() ?? false,
    } as unknown as ShellProcess

    proc.done = (async () => {
      const inner = await this.inner
      real = inner.start(spec) as unknown as ShellProcess
      await real.done
      proc.status = real.status
      proc.exitCode = real.exitCode
      proc.signal = real.signal
    })()

    return proc
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.pool.disposeAll()
  }
}

export default SshShellPlugin
```

在 `packages/shell-ssh/src/index.ts` **末尾**追加：
```ts
export { SshShellPlugin, Config as PluginConfig, name as pluginName } from './plugin.ts'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/shell-ssh/tests/unit/plugin.test.ts`
Expected: PASS，3 个用例

若 `@deepseek-ai/dsh-shell` 解析不到，把 dsh 的包目录 link 进 workspace：
```bash
pnpm --filter @dsh-mobile/shell-ssh add -D \
  /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-shell
```

- [ ] **Step 5: Commit**

```bash
git add packages/shell-ssh/src/plugin.ts packages/shell-ssh/src/index.ts packages/shell-ssh/tests/unit/plugin.test.ts
git commit -m "feat(shell-ssh): cordis 适配层，把远程执行接到 ctx.shell"
```

---

## Task 8: 远程机器注册表

**Files:**
- Create: `packages/remote-registry/src/registry.ts`
- Test: `packages/remote-registry/tests/unit/registry.test.ts`

- [ ] **Step 1: 写失败的测试**

`packages/remote-registry/tests/unit/registry.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import {
  RemoteRegistry, DuplicateMachineError, DuplicateKeyRefError, UnknownMachineError,
} from '../../src/registry.ts'
import type { RemoteMachine } from '../../src/types.ts'

function makeStore() {
  const settings = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  return {
    settings,
    secrets,
    adapter: {
      read: async <T>(key: string) => settings.get(key) as T | undefined,
      write: async (key: string, value: unknown) => { settings.set(key, value) },
      readSecret: async (ref: string) => secrets.get(ref),
      // 空值即删除——RemoteRegistry.remove 用 writeSecret(ref, '') 表达「抹掉密钥」
      writeSecret: async (ref: string, value: string) => {
        if (value) secrets.set(ref, value)
        else secrets.delete(ref)
      },
    },
  }
}

const gpu: RemoteMachine = {
  name: 'gpu-h20', host: 'h.test', port: 11020, user: 'root',
  keyRef: 'REMOTE_KEY_GPU_H20', tags: ['gpu', 'cuda'],
}

let store: ReturnType<typeof makeStore>
let registry: RemoteRegistry

beforeEach(() => {
  store = makeStore()
  registry = new RemoteRegistry(store.adapter)
})

describe('RemoteRegistry', () => {
  it('add 之后能 get 回来', async () => {
    await registry.add(gpu)
    expect(await registry.get('gpu-h20')).toEqual(gpu)
  })

  it('重名 add 抛 DuplicateMachineError', async () => {
    await registry.add(gpu)
    await expect(registry.add(gpu)).rejects.toBeInstanceOf(DuplicateMachineError)
  })

  it('不同名字但 keyRef 相同时抛 DuplicateKeyRefError', async () => {
    // keyRefForName 把 - 和 _ 都折成 _，所以这两个名字撞同一个凭据条目。
    // 放任的话，remove 掉一台会抹掉另一台的私钥。
    await registry.add({ ...gpu, name: 'my-box', keyRef: 'REMOTE_KEY_MY_BOX' })
    await expect(
      registry.add({ ...gpu, name: 'my_box', keyRef: 'REMOTE_KEY_MY_BOX' }),
    ).rejects.toBeInstanceOf(DuplicateKeyRefError)
  })

  it('list 返回全部，按名字排序', async () => {
    await registry.add({ ...gpu, name: 'zeta', keyRef: 'REMOTE_KEY_ZETA' })
    await registry.add({ ...gpu, name: 'alpha', keyRef: 'REMOTE_KEY_ALPHA' })
    expect((await registry.list()).map((m) => m.name)).toEqual(['alpha', 'zeta'])
  })

  it('byTag 按标签过滤', async () => {
    await registry.add(gpu)
    await registry.add({ ...gpu, name: 'build', keyRef: 'REMOTE_KEY_BUILD', tags: ['cpu'] })
    expect((await registry.byTag('gpu')).map((m) => m.name)).toEqual(['gpu-h20'])
  })

  it('remove 同时删掉机器与它的密钥', async () => {
    await registry.add(gpu)
    await registry.setPrivateKey('gpu-h20', 'KEY-MATERIAL')
    await registry.remove('gpu-h20')
    expect(await registry.get('gpu-h20')).toBeUndefined()
    expect(store.secrets.has('REMOTE_KEY_GPU_H20')).toBe(false)
  })

  it('remove 不存在的机器抛 UnknownMachineError', async () => {
    await expect(registry.remove('nope')).rejects.toBeInstanceOf(UnknownMachineError)
  })

  it('私钥存进密钥库，不进设置文档', async () => {
    await registry.add(gpu)
    await registry.setPrivateKey('gpu-h20', 'KEY-MATERIAL')
    expect(store.secrets.get('REMOTE_KEY_GPU_H20')).toBe('KEY-MATERIAL')
    expect(JSON.stringify([...store.settings.values()])).not.toContain('KEY-MATERIAL')
  })

  it('credentialsFor 取出私钥', async () => {
    await registry.add(gpu)
    await registry.setPrivateKey('gpu-h20', 'KEY-MATERIAL')
    expect(await registry.credentialsFor(gpu)).toEqual({ privateKey: 'KEY-MATERIAL' })
  })

  it('add 会归一化：大小写不同的 host 不会变成两条记录', async () => {
    await registry.add({ ...gpu, host: 'H.Test' })
    expect((await registry.get('gpu-h20'))?.host).toBe('h.test')
  })

  it('importUrl 从 dsh-remote:// 导入', async () => {
    const machine = await registry.importUrl('dsh-remote://root@h.test:11020/?name=gpu-h20&tags=gpu,cuda')
    expect(machine.name).toBe('gpu-h20')
    expect(await registry.get('gpu-h20')).toEqual(machine)
  })

  it('pinFingerprint 记录主机指纹', async () => {
    await registry.add(gpu)
    await registry.pinFingerprint('gpu-h20', 'sha256:abc')
    expect((await registry.get('gpu-h20'))?.hostFingerprint).toBe('sha256:abc')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/remote-registry/tests/unit/registry.test.ts`
Expected: FAIL —— 无法解析 `../../src/registry.ts`

- [ ] **Step 3: 实现**

`packages/remote-registry/src/registry.ts`:
```ts
import { normalizeMachine, parseRemoteUrl } from './url.ts'
import type { RemoteMachine } from './types.ts'

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
 * 存储适配器。设置与密钥分开两条通道，因为私钥绝不能落进
 * 会被同步或导出的设置文档。接进 dsh 时由 ctx.storage 与
 * ctx.credentials 分别实现。
 */
export interface RegistryStore {
  read<T>(key: string): Promise<T | undefined>
  write(key: string, value: unknown): Promise<void>
  readSecret(ref: string): Promise<string | undefined>
  writeSecret(ref: string, value: string): Promise<void>
}

const MACHINES_KEY = 'remote-registry.machines'

export interface SshCredentials {
  privateKey?: string
  passphrase?: string
  password?: string
}

export class RemoteRegistry {
  constructor(private readonly store: RegistryStore) {}

  private async all(): Promise<Record<string, RemoteMachine>> {
    return (await this.store.read<Record<string, RemoteMachine>>(MACHINES_KEY)) ?? {}
  }

  async list(): Promise<RemoteMachine[]> {
    return Object.values(await this.all()).sort((a, b) => a.name.localeCompare(b.name))
  }

  async get(name: string): Promise<RemoteMachine | undefined> {
    return (await this.all())[name]
  }

  async byTag(tag: string): Promise<RemoteMachine[]> {
    return (await this.list()).filter((machine) => machine.tags.includes(tag))
  }

  /**
   * 存进来的机器一律先过 normalizeMachine。手工录入表单不经过 parseRemoteUrl，
   * 若不归一化，`H.Test` 与 `h.test`、`SHA256:` 与 `sha256:` 会变成两条记录
   * ——这正是 url.ts 里花了几轮才关掉的那个 bug，只是搬到了注册表这一层。
   * normalizeMachine 同时负责校验，非法机器在这里就被拒。
   */
  async add(input: RemoteMachine): Promise<void> {
    const machine = normalizeMachine(input)
    const machines = await this.all()
    if (machines[machine.name]) throw new DuplicateMachineError(machine.name)
    const clash = Object.values(machines).find((m) => m.keyRef === machine.keyRef)
    if (clash) throw new DuplicateKeyRefError(machine.name, clash.name, machine.keyRef)
    machines[machine.name] = machine
    await this.store.write(MACHINES_KEY, machines)
  }

  async remove(name: string): Promise<void> {
    const machines = await this.all()
    const machine = machines[name]
    if (!machine) throw new UnknownMachineError(name)
    delete machines[name]
    await this.store.write(MACHINES_KEY, machines)
    await this.store.writeSecret(machine.keyRef, '')
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

  async pinFingerprint(name: string, fingerprint: string): Promise<void> {
    const machines = await this.all()
    const machine = machines[name]
    if (!machine) throw new UnknownMachineError(name)
    machines[name] = { ...machine, hostFingerprint: fingerprint }
    await this.store.write(MACHINES_KEY, machines)
  }

  async credentialsFor(machine: RemoteMachine): Promise<SshCredentials> {
    const privateKey = await this.store.readSecret(machine.keyRef)
    return privateKey ? { privateKey } : {}
  }
}
```

`remove` 用 `writeSecret(ref, '')` 表达「抹掉密钥」而不是新增一个删除方法——
`RegistryStore` 因此只需四个方法，接进 dsh 的 credentials 服务时适配更简单。
Step 1 的测试夹具已按这个语义实现（空值即删除）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/remote-registry/tests/unit/registry.test.ts`
Expected: PASS，13 个用例

- [ ] **Step 5: Commit**

```bash
git add packages/remote-registry/src/registry.ts packages/remote-registry/tests/unit/registry.test.ts
git commit -m "feat(remote-registry): 机器注册表，设置与密钥分离存储"
```

---

## Task 9: 分层连接探针

spec §5.4 要求配置保存后立刻诊断，且失败要能指出是哪一层。

**Files:**
- Create: `packages/remote-registry/src/probe.ts`
- Test: `packages/remote-registry/tests/unit/probe.test.ts`

- [ ] **Step 1: 写失败的测试**

`packages/remote-registry/tests/unit/probe.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { probeMachine, PROBE_STAGES, type ProbeDeps } from '../../src/probe.ts'
import type { RemoteMachine } from '../../src/types.ts'

const machine: RemoteMachine = {
  name: 'gpu', host: 'h.test', port: 11020, user: 'root',
  keyRef: 'REMOTE_KEY_GPU', tags: [],
}

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    tcpReachable: async () => ({ ok: true, latencyMs: 82 }),
    sshHandshake: async () => ({ ok: true, fingerprint: 'sha256:abc' }),
    exec: async (_m, command) => {
      if (command.includes('uname')) return { ok: true, stdout: 'Linux 6.8.0 x86_64\n' }
      if (command.includes('nvidia-smi')) return { ok: true, stdout: 'NVIDIA H20, 6\n' }
      return { ok: true, stdout: '' }
    },
    ...overrides,
  }
}

describe('probeMachine', () => {
  it('全部通过时四个阶段都是 ok', async () => {
    const report = await probeMachine(machine, deps())
    expect(report.ok).toBe(true)
    expect(report.stages.map((s) => s.stage)).toEqual([...PROBE_STAGES])
    expect(report.stages.every((s) => s.ok)).toBe(true)
    expect(report.stages[0].detail).toContain('82ms')
  })

  it('TCP 不通时立即停止，后续阶段标为 skipped', async () => {
    const report = await probeMachine(machine, deps({
      tcpReachable: async () => ({ ok: false, error: 'ECONNREFUSED' }),
    }))
    expect(report.ok).toBe(false)
    expect(report.stages[0]).toMatchObject({ stage: 'tcp', ok: false })
    expect(report.stages.slice(1).every((s) => s.skipped)).toBe(true)
  })

  it('已固定 sha256: 而握手返回 SHA256: 时视为匹配', async () => {
    // ssh-keygen 打印大写；两边归一化后不应报不匹配。
    const pinned = { ...machine, hostFingerprint: 'sha256:abc' }
    const report = await probeMachine(pinned, deps({
      sshHandshake: async () => ({ ok: true, fingerprint: 'SHA256:abc' }),
    }))
    expect(report.stages.find((s) => s.stage === 'handshake')!.ok).toBe(true)
  })

  it('指纹与已固定值不符时握手阶段失败', async () => {
    const pinned = { ...machine, hostFingerprint: 'sha256:OLD' }
    const report = await probeMachine(pinned, deps())
    const handshake = report.stages.find((s) => s.stage === 'handshake')!
    expect(handshake.ok).toBe(false)
    expect(handshake.detail).toContain('指纹不匹配')
  })

  it('首次连接时记录待固定的指纹', async () => {
    const report = await probeMachine(machine, deps())
    expect(report.discoveredFingerprint).toBe('sha256:abc')
  })

  it('没有 GPU 时该阶段是 ok 但注明未检测到', async () => {
    const report = await probeMachine(machine, deps({
      exec: async (_m, command) =>
        command.includes('nvidia-smi')
          ? { ok: false, stdout: '', error: 'command not found' }
          : { ok: true, stdout: 'Linux\n' },
    }))
    expect(report.ok).toBe(true)
    const gpu = report.stages.find((s) => s.stage === 'gpu')!
    expect(gpu.ok).toBe(true)
    expect(gpu.detail).toContain('未检测到')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/remote-registry/tests/unit/probe.test.ts`
Expected: FAIL —— 无法解析 `../../src/probe.ts`

- [ ] **Step 3: 实现**

`packages/remote-registry/src/probe.ts`:
```ts
import { normalizeFingerprint } from './url.ts'
import type { RemoteMachine } from './types.ts'

export const PROBE_STAGES = ['tcp', 'handshake', 'os', 'gpu'] as const
export type ProbeStage = (typeof PROBE_STAGES)[number]

export interface ProbeStageResult {
  stage: ProbeStage
  ok: boolean
  /** 给人看的一行说明。 */
  detail: string
  /** 前置阶段失败导致本阶段未执行。 */
  skipped?: boolean
}

export interface ProbeReport {
  ok: boolean
  stages: ProbeStageResult[]
  /** 本次握手看到的主机指纹，供调用方决定是否固定。 */
  discoveredFingerprint?: string
}

export interface ProbeDeps {
  tcpReachable(machine: RemoteMachine): Promise<{ ok: boolean; latencyMs?: number; error?: string }>
  sshHandshake(machine: RemoteMachine): Promise<{ ok: boolean; fingerprint?: string; error?: string }>
  exec(machine: RemoteMachine, command: string): Promise<{ ok: boolean; stdout: string; error?: string }>
}

/**
 * 分层诊断一台机器。任一层失败即停止，后续标为 skipped——
 * 这样用户看到的是"哪一层断了"，而不是笼统的连接失败。
 */
export async function probeMachine(machine: RemoteMachine, deps: ProbeDeps): Promise<ProbeReport> {
  const stages: ProbeStageResult[] = []
  let discoveredFingerprint: string | undefined

  const skipRest = (from: number): ProbeReport => {
    for (const stage of PROBE_STAGES.slice(from)) {
      stages.push({ stage, ok: false, detail: '未执行（前置阶段失败）', skipped: true })
    }
    return { ok: false, stages, discoveredFingerprint }
  }

  const tcp = await deps.tcpReachable(machine)
  if (!tcp.ok) {
    stages.push({ stage: 'tcp', ok: false, detail: `${machine.host}:${machine.port} 不可达：${tcp.error ?? '未知原因'}` })
    return skipRest(1)
  }
  stages.push({ stage: 'tcp', ok: true, detail: `${machine.host}:${machine.port} 可达 (${tcp.latencyMs}ms)` })

  const handshake = await deps.sshHandshake(machine)
  discoveredFingerprint = handshake.fingerprint
  if (!handshake.ok) {
    stages.push({ stage: 'handshake', ok: false, detail: `SSH 握手失败：${handshake.error ?? '未知原因'}` })
    return skipRest(2)
  }
  // 两边都要过 normalizeFingerprint 再比。ssh-keygen -lf 打印的是大写 `SHA256:`，
  // 而手工录入的机器不经过 parseRemoteUrl，会原样保留大写——不归一化就会对
  // 一台完全正常的机器误报"指纹不匹配"。假警报会训练用户无视 pin 警告，
  // 比不报还糟。
  const pinned = machine.hostFingerprint ? normalizeFingerprint(machine.hostFingerprint) : undefined
  const seen = handshake.fingerprint ? normalizeFingerprint(handshake.fingerprint) : undefined
  if (pinned && seen !== pinned) {
    stages.push({
      stage: 'handshake',
      ok: false,
      detail: `主机指纹不匹配：已固定 ${pinned}，实际 ${seen}`,
    })
    return skipRest(2)
  }
  stages.push({
    stage: 'handshake',
    ok: true,
    detail: machine.hostFingerprint ? '握手成功，指纹匹配' : `握手成功，指纹 ${handshake.fingerprint}（尚未固定）`,
  })

  const os = await deps.exec(machine, 'uname -sr && echo $SHELL')
  if (!os.ok) {
    stages.push({ stage: 'os', ok: false, detail: `无法执行命令：${os.error ?? '未知原因'}` })
    return skipRest(3)
  }
  stages.push({ stage: 'os', ok: true, detail: os.stdout.trim() })

  const gpu = await deps.exec(machine, 'nvidia-smi --query-gpu=name --format=csv,noheader | sort -u')
  stages.push({
    stage: 'gpu',
    ok: true,
    detail: gpu.ok && gpu.stdout.trim() ? gpu.stdout.trim() : '未检测到 GPU',
  })

  return { ok: true, stages, discoveredFingerprint }
}
```

GPU 阶段永远 `ok: true`——没有 GPU 不是配置错误，只是一条信息。这与前三个阶段的语义不同，是有意的。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/remote-registry/tests/unit/probe.test.ts`
Expected: PASS，6 个用例

- [ ] **Step 5: Commit**

```bash
git add packages/remote-registry/src/probe.ts packages/remote-registry/tests/unit/probe.test.ts
git commit -m "feat(remote-registry): 分层连接探针"
```

---

## Task 10: remote-registry 插件入口

**Files:**
- Create: `packages/remote-registry/src/index.ts`
- Test: `packages/remote-registry/tests/unit/index.test.ts`

- [ ] **Step 1: 写失败的测试**

`packages/remote-registry/tests/unit/index.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import * as pkg from '../../src/index.ts'

describe('包导出面', () => {
  it('导出解析、注册表与探针', () => {
    expect(typeof pkg.parseRemoteUrl).toBe('function')
    expect(typeof pkg.formatRemoteUrl).toBe('function')
    expect(typeof pkg.probeMachine).toBe('function')
    expect(typeof pkg.RemoteRegistry).toBe('function')
  })

  it('导出 cordis 插件标识', () => {
    expect(pkg.name).toBe('remote-registry')
    expect(pkg.inject).toContain('storage')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/remote-registry/tests/unit/index.test.ts`
Expected: FAIL —— 无法解析 `../../src/index.ts`

- [ ] **Step 3: 实现**

`packages/remote-registry/src/index.ts`:
```ts
import type { Context } from '@deepseek-ai/cordis'
import { RemoteRegistry, type RegistryStore } from './registry.ts'

export type { RemoteMachine } from './types.ts'
export {
  parseRemoteUrl, formatRemoteUrl, keyRefForName, normalizeFingerprint, normalizeMachine,
  RemoteUrlError, REMOTE_URL_SCHEME, type RemoteUrlErrorCode,
} from './url.ts'
export {
  RemoteRegistry, DuplicateMachineError, UnknownMachineError,
  type RegistryStore, type SshCredentials,
} from './registry.ts'
export {
  probeMachine, PROBE_STAGES,
  type ProbeDeps, type ProbeReport, type ProbeStage, type ProbeStageResult,
} from './probe.ts'

export const name = 'remote-registry'
export const inject = ['storage', 'credentials']

declare module '@deepseek-ai/cordis' {
  interface Context {
    remotes: RemoteRegistry
  }
}

export function apply(ctx: Context): void {
  const store: RegistryStore = {
    read: (key) => ctx.storage.get(key),
    write: (key, value) => ctx.storage.set(key, value),
    readSecret: (ref) => ctx.credentials.get(ref),
    writeSecret: (ref, value) => ctx.credentials.set(ref, value),
  }
  ctx.set('remotes', new RemoteRegistry(store))
}
```

`ctx.storage` 与 `ctx.credentials` 的确切方法名以本机
`…/@deepseek-ai/dsh-storage/lib/types/index.d.ts` 与
`…/@deepseek-ai/dsh-credentials/lib/types/index.d.ts` 为准。
**若签名不同，改这里的适配，不要改 `RegistryStore` 接口**——
它的形状是被 Task 8 的测试锁定的。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/remote-registry`
Expected: PASS，全部四个测试文件（url / registry / probe / index）

- [ ] **Step 5: Commit**

```bash
git add packages/remote-registry/src/index.ts packages/remote-registry/tests/unit/index.test.ts
git commit -m "feat(remote-registry): cordis 插件入口"
```

---

## Task 11: 打包构建（tsdown）

**动手前必读**：dsh 加载的是**编译后的 `lib/*.js`，不是 `.ts`**。这一点在写计划时被漏掉了，
是实施中查证 ADP 参考插件才发现的——它的 `main` 是 `lib/index.js`，`files` 只含 `lib`，
并且有 `prepare` 脚本在 install/link 时跑 tsdown。前面几个任务把 `main` 指向 `src/index.ts`，
那样在 Task 13 把包 link 进真 dsh profile 时会加载失败。

本任务补上构建，让两个源码包能被 dsh 真正加载。测试仍然直接 import `src/*.ts`
（迭代快、不必每次构建），只有对外的入口指向 `lib/`。

**Files:**
- Modify: `package.json`（根，加 tsdown devDependency）
- Create: `packages/remote-registry/tsdown.config.ts`
- Create: `packages/shell-ssh/tsdown.config.ts`
- Modify: `packages/remote-registry/package.json`
- Modify: `packages/shell-ssh/package.json`
- Test: `packages/remote-registry/tests/built/loadable.test.ts`

- [ ] **Step 1: 写失败的测试**

这个测试验证的正是 dsh 会做的事：用**普通 Node ESM import** 加载构建产物。
它必须绕开 vitest 的 esbuild 转译，否则测不出真实加载行为——这也是上一轮 review
里参数属性那个坑能瞒过测试套件的原因。

`packages/remote-registry/tests/built/loadable.test.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pkgRoot = fileURLToPath(new URL('../../', import.meta.url))

describe('构建产物', () => {
  it('lib/index.js 存在', () => {
    expect(existsSync(`${pkgRoot}lib/index.js`)).toBe(true)
  })

  it('shell-ssh 的产物也能被普通 Node ESM 加载', () => {
    // shell-ssh 依赖 CommonJS 的 ssh2，最容易在这里翻车。
    const libPath = fileURLToPath(new URL('../../../shell-ssh/lib/index.js', import.meta.url))
    const script = `
      const m = await import(${'${JSON.stringify(libPath)}'})
      if (typeof m.SshShellExecutor !== 'function') throw new Error('缺少 SshShellExecutor')
      console.log('OK')
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    })
    expect(out.trim()).toBe('OK')
  })

  it('能被普通 Node ESM 加载（dsh 就是这么加载的）', () => {
    // 关键：走真的 node 子进程，不经过 vitest 的 esbuild 转译。
    const script = `
      const m = await import(${JSON.stringify(`${pkgRoot}lib/index.js`)})
      const machine = m.parseRemoteUrl('dsh-remote://me@h.test/?name=box')
      if (machine.name !== 'box') throw new Error('parse 结果不对: ' + machine.name)
      if (typeof m.RemoteRegistry !== 'function') throw new Error('缺少 RemoteRegistry')
      console.log('OK')
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    })
    expect(out.trim()).toBe('OK')
  })
})
```

把 `tests/built/**` 加进根 `vitest.config.ts` 的 `include`（现有 glob
`packages/*/tests/**/*.test.ts` 已经覆盖，无需改动——确认一下即可）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/remote-registry/tests/built`
Expected: FAIL —— `lib/index.js` 不存在

- [ ] **Step 3: 装 tsdown**

在根 `package.json` 的 `devDependencies` 加 `"tsdown": "^0.15.0"`，然后 `pnpm install`。

（这台机器上 `pnpm install` 可能跑 2–6 分钟并打印 ECONNRESET 重试，属正常，见 Task 1。）

- [ ] **Step 4: 写构建配置**

`packages/remote-registry/tsdown.config.ts`:
```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  sourcemap: true,
  // dsh 的包由宿主提供，不打进产物
  external: [/^@deepseek-ai\//],
})
```

`packages/shell-ssh/tsdown.config.ts`:
```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  sourcemap: true,
  // dsh 的包由宿主提供；ssh2 与同 workspace 的包保持外部依赖
  external: [/^@deepseek-ai\//, 'ssh2', '@dsh-mobile/remote-registry'],
})
```

- [ ] **Step 5: 改两个包的入口**

`packages/remote-registry/package.json` 中，把
```json
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
```
改成
```json
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib"],
  "scripts": {
    "build": "tsdown",
    "prepare": "tsdown"
  },
```

`packages/shell-ssh/package.json` 做同样的改动（`main` / `types` / `exports` / `files` / `scripts` 五项）。

`prepare` 是关键：`pnpm link` 与 git 安装都会触发它，Task 13 把包 link 进
dsh profile 时才有 `lib/` 可加载。

- [ ] **Step 6: 构建并确认测试通过**

Run: `pnpm -r build`
Expected: 两个包各产出 `lib/index.js`、`lib/index.d.ts`、`lib/index.js.map`

Run: `pnpm vitest run packages/remote-registry/tests/built`
Expected: PASS，3 个用例

Run: `pnpm test`
Expected: 全部通过（既有的 `src/*.ts` 单测不受影响）

若第二个用例报 `SyntaxError`，说明源码里有不可擦除的 TypeScript 语法漏网。
根 `tsconfig.json` 的 `erasableSyntaxOnly` 应该已经在 typecheck 阶段拦住了；
先跑 `pnpm typecheck` 确认。

- [ ] **Step 7: 忽略构建产物**

在 `.gitignore` 追加 `lib/`。

- [ ] **Step 8: Commit**

```bash
git add package.json packages/*/package.json packages/*/tsdown.config.ts \
        packages/remote-registry/tests/built .gitignore pnpm-lock.yaml
git commit -m "build: tsdown 构建，入口指向 lib/ 以便 dsh 加载"
```

---

## Task 12: `mobile-app` bundle

**Files:**
- Create: `packages/mobile-app/package.json`
- Create: `packages/mobile-app/cordis.patch.yml`
- Test: `packages/mobile-app/tests/composition/profile.test.ts`

- [ ] **Step 1: 写失败的测试**

`packages/mobile-app/tests/composition/profile.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'

const patchPath = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
const patch = load(readFileSync(patchPath, 'utf8')) as Array<Record<string, unknown>>

/** 补丁是一个顶层数组，含若干 { insert: [...] } 或 { id, disabled } 条目。 */
function disabledIds(): string[] {
  return patch.filter((entry) => entry.disabled === true).map((entry) => entry.id as string)
}
function insertedIds(): string[] {
  return patch.flatMap((entry) =>
    Array.isArray(entry.insert) ? (entry.insert as Array<{ id: string }>).map((row) => row.id) : [],
  )
}

const MUST_DISABLE = [
  'tool-bash', 'tool-pwsh', 'bash-sandbox', 'pwsh-sandbox',
  'subprocess', 'terminal-bash', 'tmux-context', 'sandbox',
]

describe('mobile profile 补丁', () => {
  it('禁掉所有依赖本地进程的行', () => {
    const disabled = disabledIds()
    for (const id of MUST_DISABLE) expect(disabled).toContain(id)
  })

  it('挂上 shell-ssh 与 remote-registry', () => {
    const inserted = insertedIds()
    expect(inserted).toContain('shell-ssh')
    expect(inserted).toContain('remote-registry')
  })

  it('保留纯 JS 的工具行——不出现在禁用清单里', () => {
    const disabled = disabledIds()
    for (const id of ['tool-fs', 'tool-fs-search', 'tool-str-replace-editor', 'tool-todo', 'tool-web']) {
      expect(disabled).not.toContain(id)
    }
  })

  it('每个禁用条目都有说明为什么', () => {
    // 补丁文件必须为每个禁用行留注释，否则以后没人知道能不能放开。
    const text = readFileSync(patchPath, 'utf8')
    for (const id of MUST_DISABLE) {
      const index = text.indexOf(`id: ${id}`)
      expect(index, `${id} 应出现在补丁里`).toBeGreaterThan(-1)
      const preceding = text.slice(Math.max(0, index - 400), index)
      expect(preceding, `${id} 前应有注释说明`).toMatch(/#/)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/mobile-app`
Expected: FAIL —— 找不到 `cordis.patch.yml`

- [ ] **Step 3: 实现**

`packages/mobile-app/package.json`:
```json
{
  "name": "@dsh-mobile/mobile-app",
  "version": "0.1.0",
  "type": "module",
  "exports": { "./cordis.patch.yml": "./cordis.patch.yml" },
  "files": ["cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {
    "@dsh-mobile/remote-registry": "workspace:*",
    "@dsh-mobile/shell-ssh": "workspace:*"
  },
  "devDependencies": { "js-yaml": "^4.2.0" }
}
```

`packages/mobile-app/cordis.patch.yml`:
```yaml
# dsh-mobile bundle：在 dsh-base 之上应用，去掉一切依赖本地进程的东西。
#
# iOS 第三方 app 无法 fork/exec：容器沙箱拒绝 process-exec，且 AMFI 只允许
# 执行签名链在本 app team 内的二进制。因此下面每一行不是"暂时关掉"，
# 而是在 iOS 上物理不可用。执行能力由 shell-ssh 转到远程机器提供。

# ── 禁用：直接起本地进程 ────────────────────────────────

# node-pty + child_process，iOS 上两者都用不了
- id: subprocess
  disabled: true

# 依赖 subprocess 的一次性 bash 执行；由 shell-ssh 取代
- id: bash-sandbox
  disabled: true

# Windows 专用，移动端无意义
- id: pwsh-sandbox
  disabled: true

# 走本地 PTY；PTY 版远程实现（terminal-ssh）不在 v1 范围
- id: terminal-bash
  disabled: true

# ── 禁用：暴露给模型的本地 shell 工具 ──────────────────
# 必须连工具一起禁掉，否则模型会看到一个调用即失败的工具。

- id: tool-bash
  disabled: true

- id: tool-pwsh
  disabled: true

# ── 禁用：本地进程环境探测 ────────────────────────────

# 读取本机 tmux 会话，iOS 上不存在
- id: tmux-context
  disabled: true

# landlock 是 Linux、sandbox-exec 是 macOS，iOS 上都没有。
# iOS 的 app 容器本身就是沙箱边界，fs-sandbox 与 sandbox-policy 仍然生效。
- id: sandbox
  disabled: true

# ── 新增：远程执行 ────────────────────────────────────

- insert:
    # 远程机器注册表：录入、存储、探针。shell-ssh 依赖它。
    - id: remote-registry
      name: '@dsh-mobile/remote-registry'

    # 把 ctx.shell 接到远程机器。machine 指向注册表里的名字；
    # 用户在设置里选定后由 UI 写入。
    - id: shell-ssh
      name: '@dsh-mobile/shell-ssh'
      config:
        machine: default
        connectTimeoutMs: 15000
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm install && pnpm vitest run packages/mobile-app`
Expected: PASS，4 个用例

- [ ] **Step 5: Commit**

```bash
git add packages/mobile-app
git commit -m "feat(mobile-app): mobile profile 补丁，禁用本地进程依赖并挂载远程执行"
```

---

## Task 13: 端到端组合验证

前 11 个任务各自成立，但没验证过它们在真的 dsh 里能装起来。

**Files:**
- Create: `packages/mobile-app/tests/composition/dump-config.test.ts`

- [ ] **Step 1: 写测试**

`packages/mobile-app/tests/composition/dump-config.test.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DSH = '/opt/homebrew/bin/dsh'
const PROFILE = 'mobile'

// 这个测试需要本机装好 dsh 并建过 mobile profile（见 README 的手动步骤）。
const ready = existsSync(DSH)

describe.skipIf(!ready)('mobile profile 在真的 dsh 里组合', () => {
  it('--dump-config 能组合出树，且不含被禁用的行', () => {
    const output = execFileSync(DSH, ['--profile', PROFILE, '--dump-config'], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    // 被 disabled 的行仍会出现在 dump 里但带 disabled 标记；
    // 断言它们确实被标记，而不是断言它们消失。
    for (const id of ['tool-bash', 'subprocess', 'terminal-bash']) {
      const row = output.split('\n').find((line) => line.includes(`id: ${id}`))
      expect(row, `${id} 应出现在组合结果里`).toBeDefined()
    }
    expect(output).toContain('shell-ssh')
    expect(output).toContain('remote-registry')
  })

  it('jitless 模式下同样能组合', () => {
    // iOS 上 V8 必然 jitless；本地提前拦住任何依赖 JIT 或 WASM 的代码。
    const output = execFileSync('/opt/homebrew/bin/node', [
      '--jitless',
      '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '--profile', PROFILE, '--dump-config',
    ], { encoding: 'utf8', timeout: 60_000 })
    expect(output).toContain('shell-ssh')
  })
})
```

- [ ] **Step 2: 手动建 mobile profile**

这一步无法自动化——它改的是用户的 dsh 主目录。写进 `README.md`：

```bash
mkdir -p ~/.dsh/profiles/mobile
cat > ~/.dsh/profiles/mobile/package.json <<'JSON'
{
  "name": "dsh-profile-mobile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "@dsh-mobile/mobile-app"
      ]
    }
  }
}
JSON
printf '[]\n' > ~/.dsh/profiles/mobile/cordis.patch.yml
cd ~/.dsh/profiles/mobile
pnpm link /Users/choas/Solution/dsh-mobile/packages/mobile-app
pnpm link /Users/choas/Solution/dsh-mobile/packages/remote-registry
pnpm link /Users/choas/Solution/dsh-mobile/packages/shell-ssh
```

- [ ] **Step 3: 跑测试**

Run: `pnpm vitest run packages/mobile-app/tests/composition/dump-config.test.ts`
Expected: PASS（若未建 profile 则整组 skip，不是失败）

- [ ] **Step 4: 全量回归**

Run: `pnpm test`
Expected: 全部通过

Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 5: jitless 全量回归**

iOS 上 V8 必然 jitless 且 `WebAssembly` 不存在。整个测试套件在 jitless 下再跑一遍，
把任何依赖 JIT 或 WASM 的代码在 Mac 上就拦住，而不是等移植到设备才发现。

Run: `pnpm test:jitless`
Expected: 与 `pnpm test` 结果一致，全部通过

若某个用例只在 jitless 下失败，先查是不是引入了依赖 `WebAssembly` 的传递依赖：

```bash
node --jitless -e 'console.log(typeof WebAssembly)'   # 应打印 undefined
```

这条命令的输出是 `undefined` 属于预期，不是环境故障。

- [ ] **Step 6: Commit**

```bash
git add packages/mobile-app/tests README.md package.json
git commit -m "test: mobile profile 组合验证与 jitless 全量回归"
```

---

## 完成标准

- `pnpm test` 与 `pnpm test:jitless` 均全绿，`pnpm typecheck` 无错
- `pnpm -r build` 成功，且构建产物能被普通 Node ESM 加载（dsh 的加载方式）
- `dsh --profile mobile --dump-config` 能组合出树，且在 `--jitless` 下同样成立
- 在桌面 dsh 上用 mobile profile 起一个会话，让它执行一条远程命令并拿到输出

最后一条需要真机器和真凭据，属于手动验收，不进自动化测试。

## 本计划**不**包含

- Node for iOS 交叉编译（另一份计划）
- iOS 应用外壳、WKWebView、原生桥
- 移动版 UI（`dsh-client-ui-layout-mobile`）
- 二维码 enrollment 与相机
- PTY 版 `dsh-terminal-ssh`
- 设置卡片的 React 界面——本计划只做到服务层与数据层；卡片属于周期二
