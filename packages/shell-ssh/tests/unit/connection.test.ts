import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// ssh2 是 CommonJS：具名导入在真实 Node ESM 下抛 SyntaxError，vitest 的 esbuild
// 转译会掩盖这一点。这里跟 fake-sshd.ts / connection.ts 保持一致的写法。
import ssh2 from 'ssh2'
import { SshConnectionPool, fingerprintOfHostKey } from '../../src/connection.ts'
import { SshError } from '../../src/errors.ts'
import { startFakeSshd, type FakeSshd } from '../helpers/fake-sshd.ts'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'

const { Client: SshClient } = ssh2

let sshd: FakeSshd | undefined
let pool: SshConnectionPool | undefined

afterEach(async () => {
  await pool?.disposeAll(); pool = undefined
  await sshd?.close(); sshd = undefined
})

function machineFor(port: number): RemoteMachine {
  return { name: 'test', host: '127.0.0.1', port, user: 'tester', keyRef: 'REMOTE_KEY_TEST', tags: [] }
}

/**
 * 轮询直到 pool.size 达到期望值或超时——取代固定的 `setTimeout(50)`。
 * 断线到摘除之间没有一个可以直接 await 的事件（摘除发生在池内部的
 * 'close' 监听器里），轮询是唯一稳妥的等法；固定睡眠在 CI 负载高时会
 * 偶发落空，把一个真实的时序问题伪装成"更慢一点就好了"。
 */
async function waitForPoolSize(p: SshConnectionPool, expected: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (p.size !== expected) {
    if (Date.now() > deadline) {
      throw new Error(`超时：等待 pool.size 变成 ${expected}，超时时仍是 ${p.size}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * 用一条独立于 SshConnectionPool 的连接去问服务器"你的主机指纹是什么"，
 * 用来在"匹配"测试里事先拿到一个会通过校验的合法值——不能反过来用连接池
 * 自己算出来的指纹去测连接池，那样测试和实现共享同一个 bug 也测不出来。
 * 内部用的是被测模块自己的 fingerprintOfHostKey；它本身的正确性由下面
 * "指纹格式与真实 ssh-keygen -lf 一致" 那个不经过本模块的独立测试兜底。
 */
function captureHostFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const probe = new SshClient()
    probe.on('ready', () => probe.end())
    probe.on('error', (err) => reject(err))
    probe.connect({
      host: '127.0.0.1',
      port,
      username: 'tester',
      password: 'x',
      hostVerifier: (hostKeyBlob: Buffer): boolean => {
        resolve(fingerprintOfHostKey(hostKeyBlob))
        return true
      },
    })
  })
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

  it('服务器整体关闭后，连接从池中摘除', async () => {
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    await pool.acquire(machineFor(sshd.port))
    expect(pool.size).toBe(1)

    await sshd.close()
    await waitForPoolSize(pool, 0) // 断线后自动从池里摘除
  })

  it('挂断连接但服务器保持监听时，对同一个 key 重新 acquire 能连上、拿到不同的 Client 实例', async () => {
    // 用 fake sshd 的 disconnectAll()（只挂断连接，不停止监听）而不是
    // close()（连监听一起关掉），才能真正验证"同一个 user@host:port 断线
    // 后重连"这条路径——此前用重启一台监听在新端口的服务器来模拟重连，
    // 实际上换了 key，测的是"新 key 建连"而不是"同一个 key 断线重连"，
    // 而后者正是 I2（迟到的 close 按身份而非 key 摘除）真正要防的场景。
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    const machine = machineFor(sshd.port)
    const clientBefore = await pool.acquire(machine)
    expect(pool.size).toBe(1)

    sshd.disconnectAll()
    await waitForPoolSize(pool, 0)

    const clientAfter = await pool.acquire(machine)
    expect(pool.size).toBe(1)
    expect(clientAfter).not.toBe(clientBefore)
  })

  it('旧连接迟到的 close 事件不会把占据同一个 key 的新连接挤出池外', async () => {
    // I2 的直接复现：指纹从未验证 -> 已固定指纹这条路径（下面"主机指纹
    // 校验"里的 I1 测试）会摘除旧连接、换上新连接。旧连接的 'close' 是
    // 异步到达的——如果摘除逻辑按 key 无条件 delete，这条迟到的事件会
    // 把此刻已经指向新连接的 key 删掉。这里直接等旧连接自己的 'close'
    // 事件（而不是猜一个够长的延时），断言它触发之后新连接依然在池里。
    sshd = await startFakeSshd()
    const fingerprint = await captureHostFingerprint(sshd.port)
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })

    const unpinned = machineFor(sshd.port)
    const clientA = await pool.acquire(unpinned)
    const clientAClosed = new Promise<void>((resolve) => clientA.once('close', () => resolve()))

    const pinned = { ...unpinned, hostFingerprint: fingerprint }
    const clientB = await pool.acquire(pinned)
    expect(clientB).not.toBe(clientA)

    await clientAClosed
    expect(pool.size).toBe(1)
    expect(await pool.acquire(pinned)).toBe(clientB)
  })

  it('disposeAll 清空连接池', async () => {
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    await pool.acquire(machineFor(sshd.port))
    await pool.disposeAll()
    expect(pool.size).toBe(0)
  })

  it('disposeAll 在握手中途执行时，握手成功也不会让连接复活进被清空的池', async () => {
    // C1 复现：acquire() 发起后立刻 disposeAll()，确保这一刻握手还没
    // 完成（credentials() 的 await 让 connect() 让出控制权，disposeAll
    // 的同步部分——世代号自增——在网络往返完成前必然先跑完）。
    // 修复前：disposeAll 之后 size 是 0，但等 acquire 的 promise 之后
    // resolve，size 又变回 1——一条已经完成握手、已经发送过凭据的活连接
    // 被"复活"进了一个调用方以为已经清空的池，没有任何句柄能再够到它。
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
    const machine = machineFor(sshd.port)

    const acquirePromise = pool.acquire(machine)
    await pool.disposeAll()
    expect(pool.size).toBe(0)

    await expect(acquirePromise).rejects.toSatisfy(
      (err: unknown) => err instanceof SshError && err.code === 'SSH_DISCONNECTED' && err.recoverable,
    )
    // 握手其实成功了（fake sshd 没有理由拒绝这次连接），但世代号已经
    // 不匹配，连接被直接关掉、没有被塞回池里。
    expect(pool.size).toBe(0)
  })

  it('把 credentials() 返回的密码原样传给 ssh2，而不是随便一个值也能连上', async () => {
    sshd = await startFakeSshd()
    const distinctivePassword = 'correct-horse-battery-staple'
    pool = new SshConnectionPool({ credentials: async () => ({ password: distinctivePassword }) })
    await pool.acquire(machineFor(sshd.port))

    // 客户端总会先发一轮 method 'none' 的探测，夹具总是拒绝它；真正有意义
    // 的是紧接着那次带着我们实际密码的 'password' 尝试。用 toContainEqual
    // 而不是 toEqual 整个数组，因为 'none' 那条噪声条目也在数组里。
    expect(sshd.authAttempts.some((a) => a.method === 'none')).toBe(true)
    expect(sshd.authAttempts).toContainEqual({
      method: 'password',
      username: 'tester',
      password: distinctivePassword,
    })
  })

  it('把 credentials() 返回的私钥原样传给 ssh2——生产环境走的是这条路径，不是密码', async () => {
    sshd = await startFakeSshd()
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      // 经 fake-sshd.ts 验证过：ssh2 的 keyParser 认 PKCS1（"BEGIN RSA
      // PRIVATE KEY"），不认通用 PKCS8（"BEGIN PRIVATE KEY"）。
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    // 独立算出这把私钥对应的公钥指纹（十六进制，跟夹具记录的格式一致），
    // 不依赖连接池本身，作为"服务器确实收到了这把特定的钥匙"的证据。
    const parsedKey = ssh2.utils.parseKey(privateKey)
    if (parsedKey instanceof Error) throw parsedKey
    const expectedFingerprint = createHash('sha256').update(parsedKey.getPublicSSH()).digest('hex')

    pool = new SshConnectionPool({ credentials: async () => ({ privateKey }) })
    await pool.acquire(machineFor(sshd.port))

    expect(sshd.authAttempts.some((a) => a.method === 'none')).toBe(true)
    // ssh2 对同一把 key 通常先后触发一次仅查询（无签名）和一次带签名的
    // 尝试，两条都会出现在 authAttempts 里，断言用 toContainEqual。
    expect(sshd.authAttempts).toContainEqual({
      method: 'publickey',
      username: 'tester',
      publicKeyFingerprint: expectedFingerprint,
    })
  })

  it('credentials() 抛错时，acquire() 用 SshError 包一层而不是让裸错误冒泡', async () => {
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({
      credentials: async () => { throw new Error('钥匙串解锁失败') },
    })
    await expect(pool.acquire(machineFor(sshd.port))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof SshError
        && err.code === 'SSH_AUTH_FAILED'
        && !err.recoverable
        && err.message.includes('钥匙串解锁失败'),
    )
  })

  it('credentials() 抛出的 SshError 原样透传，不被二次包装', async () => {
    sshd = await startFakeSshd()
    const original = new SshError('凭据条目不存在', 'SSH_NO_MACHINE', false)
    pool = new SshConnectionPool({ credentials: async () => { throw original } })
    await expect(pool.acquire(machineFor(sshd.port))).rejects.toBe(original)
  })

  describe('主机指纹校验', () => {
    it('未固定指纹时按可信首连处理，正常连接', async () => {
      sshd = await startFakeSshd()
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const client = await pool.acquire(machineFor(sshd.port))
      expect(client).toBeDefined()
      expect(pool.size).toBe(1)
    })

    it('指纹与已固定值匹配时正常连接', async () => {
      sshd = await startFakeSshd()
      const fingerprint = await captureHostFingerprint(sshd.port)
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const machine = { ...machineFor(sshd.port), hostFingerprint: fingerprint }
      const client = await pool.acquire(machine)
      expect(client).toBeDefined()
      expect(pool.size).toBe(1)
    })

    it('指纹与已固定值不符时拒绝连接，标记为不可恢复，且不留下任何连接', async () => {
      sshd = await startFakeSshd()
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const wrongFingerprint = `sha256:${'A'.repeat(43)}`
      const machine = { ...machineFor(sshd.port), hostFingerprint: wrongFingerprint }
      await expect(pool.acquire(machine)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof SshError && err.code === 'SSH_FINGERPRINT_MISMATCH' && !err.recoverable,
      )
      // 硬失败，不能悄悄留下一条"半信任"的连接。
      expect(pool.size).toBe(0)
    })

    it('指纹格式与真实 ssh-keygen -lf 的输出逐字节一致（不经过本模块的独立 oracle）', async () => {
      sshd = await startFakeSshd()

      // fake sshd 的 hostKeyPublic 是 SPKI PEM（"BEGIN PUBLIC KEY"）。
      // 经验证：真实 ssh-keygen -lf 不认这个格式，会报 "is not a public
      // key file"——必须先用 `ssh-keygen -i -m PKCS8` 转换成 OpenSSH 格式
      // （"ssh-rsa AAAA..."）它才认。这个转换只是为了喂给 ssh-keygen，跟
      // fingerprintOfHostKey 的实现（对 hostVerifier 收到的原始 wire
      // blob 算 sha256/base64）无关——hostVerifier 收到的本来就已经是
      // wire blob 形式，不需要这层转换。
      const dir = mkdtempSync(join(tmpdir(), 'sshfp-'))
      const pkcs8File = join(dir, 'host_pkcs8.pub')
      writeFileSync(pkcs8File, sshd.hostKeyPublic)
      const opensshPub = execFileSync('ssh-keygen', ['-i', '-m', 'PKCS8', '-f', pkcs8File], {
        encoding: 'utf8',
      })
      const opensshFile = join(dir, 'host_openssh.pub')
      writeFileSync(opensshFile, opensshPub)
      const keygenOutput = execFileSync('ssh-keygen', ['-lf', opensshFile], { encoding: 'utf8' })

      const match = keygenOutput.match(/SHA256:(\S+)/)
      if (!match) throw new Error(`无法从 ssh-keygen 输出里解析出指纹: ${keygenOutput}`)
      const keygenFingerprint = `sha256:${match[1]}`

      const observedFingerprint = await captureHostFingerprint(sshd.port)
      expect(observedFingerprint).toBe(keygenFingerprint)
    })

    it('已固定的指纹与缓存连接建连时验证的指纹不同，会摘除重连而不是直接复用', async () => {
      // I1 的直接复现：第一次未固定指纹地连（TOFU），池记录"这条连接没有
      // 验证过指纹"；随后带着一个已固定的指纹 acquire 同一台机器，旧连接
      // 从未按这个指纹验证过，必须摘除重连，不能原样交出去——否则 Task 9
      // 的指纹固定 UI 形同虚设：固定之后，池里躺着的还是那条从未验证过
      // 的旧连接。
      sshd = await startFakeSshd()
      const fingerprint = await captureHostFingerprint(sshd.port)
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })

      const unpinned = machineFor(sshd.port)
      const clientA = await pool.acquire(unpinned)

      const pinned = { ...unpinned, hostFingerprint: fingerprint }
      const clientB = await pool.acquire(pinned)
      expect(clientB).not.toBe(clientA)
      expect(pool.size).toBe(1)

      // 再用同一个已固定指纹的 machine 对象 acquire，这次应该复用 clientB。
      const clientC = await pool.acquire(pinned)
      expect(clientC).toBe(clientB)
    })
  })
})
