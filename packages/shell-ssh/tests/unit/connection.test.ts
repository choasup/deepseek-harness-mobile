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
import { MissingCredentialError } from '@dsh-mobile/remote-registry'

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

  it('credentials() 抛 MissingCredentialError 时映射成 SSH_NO_CREDENTIAL，不落进 SSH_AUTH_FAILED 兜底', async () => {
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({
      credentials: async () => { throw new MissingCredentialError('gpu-h20', 'REMOTE_KEY_GPU_H20') },
    })
    await expect(pool.acquire(machineFor(sshd.port))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof SshError
        && err.code === 'SSH_NO_CREDENTIAL'
        && !err.recoverable
        && err.message.includes('gpu-h20')
        && err.message.includes('REMOTE_KEY_GPU_H20'),
    )
  })

  it('credentials() 抛出的 SshError 原样透传，不被二次包装', async () => {
    sshd = await startFakeSshd()
    const original = new SshError('凭据条目不存在', 'SSH_NO_MACHINE', false)
    pool = new SshConnectionPool({ credentials: async () => { throw original } })
    await expect(pool.acquire(machineFor(sshd.port))).rejects.toBe(original)
  })

  // ---------------------------------------------------------------------
  // 协调者验证 Task 7 时发现的真实缺陷：ssh2 的 Client#connect() 对一把
  // 解析不出来的 privateKey 是**同步抛出**（读过 ssh2 1.17.0 的
  // client.js 源码确认：parseKey() 发生在创建 socket 之前，纯本地校验，
  // 从不触发任何事件），会绕过 client.on('error', ...) 那条映射，原样
  // 冒泡成一个裸 Error——这跟 I7（credentials() 回调抛错）是同一个物种，
  // 但 I7 当时只包住了回调本身，没接住 connect() 紧接着这一行的同步抛出。
  // ---------------------------------------------------------------------

  it('私钥格式无法解析（贴错格式/整段不是密钥）时，抛 SSH_AUTH_FAILED 而不是裸 Error', async () => {
    sshd = await startFakeSshd()
    pool = new SshConnectionPool({ credentials: async () => ({ privateKey: '不是一把有效的私钥' }) })
    await expect(pool.acquire(machineFor(sshd.port))).rejects.toSatisfy(
      (err: unknown) =>
        // 不是 SSH_NO_CREDENTIAL——"配了但用不了"跟"压根没配"要求用户做
        // 完全不同的事，必须保持可区分，这里用字面量相等断言直接锁死。
        err instanceof SshError
        && err.code === 'SSH_AUTH_FAILED'
        && !err.recoverable
        // ssh2 的原始报错文本要保留，用户才知道自己的密钥具体错在哪。
        && err.message.includes('Cannot parse privateKey'),
    )
  })

  it('privateKey 字段错填成一把公钥（没有私钥部分）时，同样抛 SSH_AUTH_FAILED 而不是裸 Error', async () => {
    sshd = await startFakeSshd()
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const parsedKey = ssh2.utils.parseKey(privateKey)
    if (parsedKey instanceof Error) throw parsedKey
    // ssh2 认得的 OpenSSH 公钥行形式（"ssh-rsa AAAA..."）——这条命中的是
    // parseKey() 成功之后、`getPrivatePEM() === null` 那个独立的同步
    // throw，跟上一个测试命中的"格式解析失败"是 client.js 里紧挨着的
    // 两条不同语句，值得分别验证都被接住了。
    const opensshPublicLine = `${parsedKey.type} ${parsedKey.getPublicSSH().toString('base64')}`

    pool = new SshConnectionPool({ credentials: async () => ({ privateKey: opensshPublicLine }) })
    await expect(pool.acquire(machineFor(sshd.port))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof SshError
        && err.code === 'SSH_AUTH_FAILED'
        && !err.recoverable
        && err.message.includes('does not contain a (valid) private key'),
    )
  })

  describe('主机指纹校验', () => {
    it('未固定指纹时按可信首连处理，正常连接', async () => {
      sshd = await startFakeSshd()
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const client = await pool.acquire(machineFor(sshd.port))
      expect(client).toBeDefined()
      expect(pool.size).toBe(1)
    })

    it('C2 修复：可信首连（TOFU）后，observedFingerprintFor 返回独立探测到的同一个指纹', async () => {
      // 之前 verifiedFingerprints 在 TOFU 时存的是 pinnedFingerprint 本身
      // （undefined），hostVerifier 里真正算出来的指纹只活在 handshake()
      // 的闭包里，握手一结束就没处可读——探针没法在首次连接后报出"待固定
      // 的指纹"给用户。这里用一条独立于连接池的探测（captureHostFingerprint）
      // 拿到 oracle 值，验证池自己报出来的观测值与其一致。
      sshd = await startFakeSshd()
      const expected = await captureHostFingerprint(sshd.port)
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const machine = machineFor(sshd.port)
      expect(pool.observedFingerprintFor(machine)).toBeUndefined()

      await pool.acquire(machine)
      expect(pool.observedFingerprintFor(machine)).toBe(expected)
    })

    it('C2 修复的回归防护：同一台未固定指纹的机器连续 acquire 两次仍复用同一条连接', async () => {
      // 把"观测到的指纹"和"这条连接是按哪个 pin 建立的"这两件事分进两张表
      // 之前，曾经错误地把观测值直接存进后者——TOFU 下观测值是一个具体
      // 字符串而不是 undefined，会让第二次 acquire()（要求的 pin 仍是
      // undefined）误判成"pin 要求变了"，平白摘除重连一条刚建好的健康
      // 连接。这里直接断言两次拿到的是同一个 Client 实例。
      sshd = await startFakeSshd()
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const machine = machineFor(sshd.port)
      const first = await pool.acquire(machine)
      const second = await pool.acquire(machine)
      expect(second).toBe(first)
      expect(pool.size).toBe(1)
    })

    it('已固定指纹连接建立后，observedFingerprintFor 与固定值一致', async () => {
      sshd = await startFakeSshd()
      const fingerprint = await captureHostFingerprint(sshd.port)
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const machine = { ...machineFor(sshd.port), hostFingerprint: fingerprint }
      await pool.acquire(machine)
      expect(pool.observedFingerprintFor(machine)).toBe(fingerprint)
    })

    it('连接被摘除/池被清空后，observedFingerprintFor 不再返回陈旧的值', async () => {
      sshd = await startFakeSshd()
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const machine = machineFor(sshd.port)
      await pool.acquire(machine)
      expect(pool.observedFingerprintFor(machine)).toBeDefined()

      await pool.disposeAll()
      expect(pool.observedFingerprintFor(machine)).toBeUndefined()
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

    it('C2：撞上 in-flight 连接时也要校验指纹，不能靠 pending 合并绕过', async () => {
      // 复现：一次未固定指纹的 acquire 正在建连（还没进 this.clients，
      // 只在 this.pending 里）；另一次带着错误指纹的 acquire 几乎同时
      // 到达，撞上同一个 key 的 in-flight 条目。修复前，pending 命中分支
      // 直接 `return inflight`，完全不比较指纹——带错误指纹的调用者会
      // "成功"拿到一条从未按它的指纹验证过的连接，指纹校验形同虚设。
      sshd = await startFakeSshd()
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const unpinned = machineFor(sshd.port)
      const wrongFingerprint = `sha256:${'A'.repeat(43)}`
      const pinned = { ...unpinned, hostFingerprint: wrongFingerprint }

      const [unpinnedResult, pinnedResult] = await Promise.allSettled([
        pool.acquire(unpinned),
        pool.acquire(pinned),
      ])

      expect(unpinnedResult.status).toBe('fulfilled')
      // 关键断言：带着错误指纹撞上同一个 in-flight 连接的那次 acquire
      // 必须失败——它落到"指纹不匹配，摘除重连"分支，重新建连时真的会
      // 用这个错误指纹去校验，理应连不上，而不是悄悄拿到 in-flight 那条
      // 从未验证过指纹的连接。
      expect(pinnedResult.status).toBe('rejected')
      if (pinnedResult.status === 'rejected') {
        expect(pinnedResult.reason).toBeInstanceOf(SshError)
        expect((pinnedResult.reason as SshError).code).toBe('SSH_FINGERPRINT_MISMATCH')
        expect((pinnedResult.reason as SshError).recoverable).toBe(false)
      }
    })

    it('并发的两次正确指纹 acquire 都各自摘除重连、互相顶替时，被顶替的一方会被关闭而不是泄漏', async () => {
      // 这是 C2 修复之外仍然存在的一条更窄的残留竞态（acquire() 里也有
      // 注释说明）：两次几乎同时到达、都撞上同一条"未按当前指纹验证过"
      // 的 in-flight 连接的调用者，会在它 resolve 之后各自独立摘除、
      // 各自重新建连——彼此看不到对方也在重连，所以真的会产生两条独立的
      // 新连接，而不是合并成一条。
      //
      // 关键是三个 acquire 必须**同时**发起、都撞上同一条还没 resolve 的
      // in-flight 连接——如果先把未固定指纹那次 await 到完成再发起两次
      // 固定指纹的 acquire（曾经这么写过，测试测不出问题），"摘除 +
      // 重新建连" 的整个同步阶段会在第二次 acquire() 开始之前就跑完，
      // 第二次会经由 pending 分支正常合并到第一次身上，触发不了这条竞态。
      // 只有三个 await inflight 的continuation 都排在同一个已 resolve
      // 的 Promise 后面、各自在自己的微任务里独立执行"发现指纹不对 ->
      // 摘除 -> 建新连接"，才会真的产生两条独立连接。
      //
      // 不会绕过指纹校验（两条新连接都会被正确校验，这里两个指纹都是
      // 对的，所以都会成功），但池的 this.clients 只能记住最后一个 set
      // 进去的——测的就是先完成的那一条被顶替时会被主动关闭，而不是
      // 变成一条谁都够不着的活连接。
      sshd = await startFakeSshd()
      const fingerprint = await captureHostFingerprint(sshd.port)
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const unpinned = machineFor(sshd.port)
      const pinned = { ...unpinned, hostFingerprint: fingerprint }

      const [unpinnedClient, clientX, clientY] = await Promise.all([
        pool.acquire(unpinned),
        pool.acquire(pinned),
        pool.acquire(pinned),
      ])

      expect(clientX).not.toBe(unpinnedClient)
      // 两次 acquire() 各自调用了 connect()，一定是两个不同的 Client 实例
      // ——这个断言本身就是在确认这条残留竞态确实被触发了，而不是被
      // pending 合并掉了。
      expect(clientX).not.toBe(clientY)
      expect(pool.size).toBe(1)

      const survivor = await pool.acquire(pinned)
      const displaced = survivor === clientX ? clientY : clientX
      // 等被顶替那条真正触发 'close'——这本身就是"它被关掉了"的证据；
      // 如果被顶替的连接遭到泄漏（既不在池里、进程里也没有别的东西去
      // 关它），这个 Promise 永远不会 resolve，测试会超时失败。
      await new Promise<void>((resolve) => displaced.once('close', resolve))
      expect(pool.size).toBe(1)
    })
  })

  describe('C3：disposeAll 与 acquire 竞争时，pending 条目不能被按 key 误删', () => {
    it('acquire-1 的连接尝试因世代号不匹配而失败时，不会误删 acquire-2 刚装进 pending 的条目', async () => {
      // 复现步骤（跟 acquire() 里 C3 那段注释描述的一致）：
      //   1. acquire-1 发起 attemptA，装进 pending（还没连上，credentials()
      //      的 await 让它让出控制权）。
      //   2. disposeAll()：世代号自增、清空 pending（attemptA 仍在后台跑，
      //      因为 pending.clear() 只是清空 map，不取消已经在跑的 Promise）。
      //   3. acquire-2 为同一个 key 发起 attemptB，装进 pending。
      //   4. attemptA 随后握手成功，但世代号已经不匹配，自己关掉、抛
      //      SSH_DISCONNECTED——acquire-1 的 finally 执行。修复前：无条件
      //      `pending.delete(key)` 会把此刻属于 attemptB 的条目删掉。
      //   5. acquire-3 这时候如果在 pending 里找不到 attemptB（已被误删），
      //      会另起一条 attemptC——池里最终只记得住最后 set 进去的那条，
      //      前一条变成一条没有任何句柄能关掉的活连接。
      // 修复后，acquire-2 和 acquire-3 应该拿到同一个 Client 实例。
      sshd = await startFakeSshd()
      pool = new SshConnectionPool({ credentials: async () => ({ password: 'x' }) })
      const machine = machineFor(sshd.port)

      const acquire1 = pool.acquire(machine) // attemptA，故意不等
      await pool.disposeAll() // 世代号自增、清空 pending；attemptA 仍在后台跑

      const acquire2 = pool.acquire(machine) // attemptB，装进刚清空的 pending

      await expect(acquire1).rejects.toSatisfy(
        (err: unknown) => err instanceof SshError && err.code === 'SSH_DISCONNECTED',
      )
      // 到这里，attemptA 的 finally 已经执行过——如果 bug 还在，attemptB
      // 在 pending 里的条目已经被误删。

      const acquire3 = pool.acquire(machine) // 如果 bug 还在，这里会另起 attemptC

      const [clientB, clientC] = await Promise.all([acquire2, acquire3])
      expect(clientC).toBe(clientB) // 修复后：acquire-3 复用 acquire-2 的同一条连接
      expect(pool.size).toBe(1)
    })
  })

  describe('onDisconnect 回调', () => {
    it('ready 之后的一次真实故障（error 紧跟 close）只触发一次通知，携带那次错误', async () => {
      sshd = await startFakeSshd()
      const events: Array<{ machine: RemoteMachine; error: Error | undefined }> = []
      pool = new SshConnectionPool({
        credentials: async () => ({ password: 'x' }),
        onDisconnect: (machine, error) => { events.push({ machine, error }) },
      })
      const machine = machineFor(sshd.port)
      const client = await pool.acquire(machine)

      // 摧毁底层 socket 模拟真实故障——经验证这会先后触发 client 的
      // 'error'（level: 'client-socket'）和 'close'，顺序固定。
      const underlyingSocket = (client as unknown as { _sock?: { destroy(err?: Error): void } })._sock
      expect(underlyingSocket).toBeDefined()
      underlyingSocket?.destroy(new Error('模拟的底层 socket 故障'))

      await waitForPoolSize(pool, 0)
      // 关键断言：不是两次（一次带 error、一次不带），是恰好一次，且带着
      // 那次 'error' 事件的错误对象。
      expect(events.length).toBe(1)
      expect(events[0]?.machine).toBe(machine)
      expect(events[0]?.error).toBeInstanceOf(Error)
    })

    it('evict() 摘除的连接（指纹校验触发）不会误报成一次断线', async () => {
      sshd = await startFakeSshd()
      const fingerprint = await captureHostFingerprint(sshd.port)
      const events: Array<{ machine: RemoteMachine; error: Error | undefined }> = []
      pool = new SshConnectionPool({
        credentials: async () => ({ password: 'x' }),
        onDisconnect: (machine, error) => { events.push({ machine, error }) },
      })

      const unpinned = machineFor(sshd.port)
      const clientA = await pool.acquire(unpinned)
      const clientAClosed = new Promise<void>((resolve) => clientA.once('close', () => resolve()))

      const pinned = { ...unpinned, hostFingerprint: fingerprint }
      await pool.acquire(pinned) // 摘除 clientA，换上一条新验证过指纹的连接

      await clientAClosed
      // clientA 真的关闭了（上面已经 await 过它的 'close' 事件），但这是
      // 池自己决定的摘除，调用方刚刚成功拿到了一条健康的替代连接——不
      // 该收到一次"断线"通知。
      expect(events.length).toBe(0)
    })

    it('disposeAll 关闭的连接不会触发 onDisconnect', async () => {
      sshd = await startFakeSshd()
      const events: Array<{ machine: RemoteMachine; error: Error | undefined }> = []
      pool = new SshConnectionPool({
        credentials: async () => ({ password: 'x' }),
        onDisconnect: (machine, error) => { events.push({ machine, error }) },
      })
      await pool.acquire(machineFor(sshd.port))
      await pool.disposeAll()
      expect(events.length).toBe(0)
    })
  })
})
