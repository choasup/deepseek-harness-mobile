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
    credentialSource: async () => ({ configured: true, source: 'file', writable: true }),
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
  it('全部通过时五个阶段都是 ok', async () => {
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

  it('tcpReachable 未提供 latencyMs 时，detail 里不出现字面量 "undefined"', async () => {
    const report = await probeMachine(machine, deps({
      tcpReachable: async () => ({ ok: true }),
    }))
    expect(report.stages[0].ok).toBe(true)
    expect(report.stages[0].detail).not.toContain('undefined')
  })

  it('已固定 sha256: 而握手返回 SHA256: 时视为匹配，fingerprintStatus 为 matched', async () => {
    // ssh-keygen 打印大写；两边归一化后不应报不匹配。
    const pinned = { ...machine, hostFingerprint: 'sha256:abc' }
    const report = await probeMachine(pinned, deps({
      sshHandshake: async () => ({ ok: true, fingerprint: 'SHA256:abc' }),
    }))
    expect(report.stages.find((s) => s.stage === 'handshake')!.ok).toBe(true)
    expect(report.fingerprintStatus).toBe('matched')
  })

  it('指纹与已固定值不符时握手阶段失败，fingerprintStatus 为 mismatched', async () => {
    const pinned = { ...machine, hostFingerprint: 'sha256:OLD' }
    const report = await probeMachine(pinned, deps())
    const handshake = report.stages.find((s) => s.stage === 'handshake')!
    expect(handshake.ok).toBe(false)
    expect(handshake.detail).toContain('指纹不匹配')
    expect(report.fingerprintStatus).toBe('mismatched')
  })

  it('首次连接时记录待固定的指纹，fingerprintStatus 为 unpinned', async () => {
    const report = await probeMachine(machine, deps())
    expect(report.discoveredFingerprint).toBe('sha256:abc')
    expect(report.fingerprintStatus).toBe('unpinned')
  })

  it('sshHandshake 返回的指纹不是 sha256:<base64> 形状时，报"无法解析"而不是假的"指纹不匹配"', async () => {
    // 两个真实的错误来源：ssh-keygen -lf 的原始整行输出，以及一个带尾随
    // 换行符的值（最可能是 Task 10 适配器忘记 trim() 的那种失误）。两者
    // 都不能被 normalizeFingerprint 悄悄接受、然后跟已固定值比出一个
    // "不匹配"——那是一次假的主机密钥告警，比不告警更糟。
    const pinned = { ...machine, hostFingerprint: 'sha256:abc' }

    const rawKeygenLine = await probeMachine(pinned, deps({
      sshHandshake: async () => ({ ok: true, fingerprint: '256 SHA256:abc root@h (ED25519)' }),
    }))
    const h1 = rawKeygenLine.stages.find((s) => s.stage === 'handshake')!
    expect(h1.ok).toBe(false)
    expect(h1.detail).toContain('无法解析主机指纹')
    expect(h1.detail).not.toContain('指纹不匹配')
    expect(rawKeygenLine.fingerprintStatus).toBeUndefined()
    expect(rawKeygenLine.discoveredFingerprint).toBeUndefined()

    const trailingNewline = await probeMachine(pinned, deps({
      sshHandshake: async () => ({ ok: true, fingerprint: 'sha256:abc\n' }),
    }))
    const h2 = trailingNewline.stages.find((s) => s.stage === 'handshake')!
    expect(h2.ok).toBe(false)
    expect(h2.detail).toContain('无法解析主机指纹')
    expect(h2.detail).not.toContain('指纹不匹配')
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

  it('GPU 探测命令执行失败时，仍是 ok:true，但保留失败原因，不能一律说成"没有 GPU"', async () => {
    // 一台真的插着 H20、但驱动坏掉的机器，跟一台压根没有 GPU 的机器，
    // 从"exec 失败"这一个事实上分不出来——探针至少不能把唯一掌握的信息
    // （失败原因）也吞掉。
    const report = await probeMachine(machine, deps({
      exec: async (_m, command) =>
        command.includes('nvidia-smi')
          ? { ok: false, stdout: '', error: 'Failed to initialize NVML: Driver/library version mismatch' }
          : { ok: true, stdout: 'Linux\n' },
    }))
    const gpu = report.stages.find((s) => s.stage === 'gpu')!
    expect(gpu.ok).toBe(true)
    expect(gpu.detail).toContain('未检测到')
    expect(gpu.detail).toContain('Driver/library version mismatch')
  })

  it('os 阶段的 detail 是单行说明，多行 stdout 会被拼接而不是原样带着换行符', async () => {
    const report = await probeMachine(machine, deps())
    const os = report.stages.find((s) => s.stage === 'os')!
    expect(os.detail).not.toContain('\n')
  })

  // --- Addition B: 凭据来源阶段 ---

  it('没有存储密钥时 credential 阶段失败，且不读成认证被拒', async () => {
    const report = await probeMachine(machine, deps({
      credentialSource: async () => ({ configured: false, writable: true }),
    }))
    const credential = report.stages.find((s) => s.stage === 'credential')!
    expect(credential.ok).toBe(false)
    expect(credential.detail).not.toContain('认证')
    expect(report.ok).toBe(false)
    // handshake 及之后因前置失败被跳过。
    expect(report.stages.find((s) => s.stage === 'handshake')!.skipped).toBe(true)
  })

  it('密钥来自非本机存储的来源、且该来源可写（project-env/user-env）时，remedy 说"可以设置密钥"', async () => {
    const report = await probeMachine(machine, deps({
      credentialSource: async () => ({ configured: true, source: 'project-env', writable: true }),
    }))
    const credential = report.stages.find((s) => s.stage === 'credential')!
    expect(credential.ok).toBe(true)
    // I5：不能断言具体是"环境变量"——source 是 provider 自定义的字符串，
    // 断言的是"不是本机存储的配置"这个不依赖 provider 实现的说法。
    expect(credential.detail).toContain('不是本机存储的配置')
    expect(credential.detail).toContain('project-env')
    expect(credential.detail).toContain('设置密钥')
    // 后续阶段应正常继续探测，而不是因为这条"警示但非失败"的信息被跳过。
    expect(report.stages.find((s) => s.stage === 'handshake')!.skipped).toBeFalsy()
  })

  it('密钥来自非本机存储的来源、但该来源只读（本地 provider 的 env）时，remedy 不能建议"设置密钥"', async () => {
    // I4 的直接复现：本地 provider 对被进程环境变量占据的引用会拒绝
    // set()（"is supplied read-only by the launching environment"）。
    // 让用户去做一件保证失败的事，比不给建议更糟。
    const report = await probeMachine(machine, deps({
      credentialSource: async () => ({ configured: true, source: 'env', writable: false }),
    }))
    const credential = report.stages.find((s) => s.stage === 'credential')!
    expect(credential.ok).toBe(true)
    expect(credential.detail).toContain('不是本机存储的配置')
    expect(credential.detail).not.toContain('可以为这台机器单独设置密钥')
    expect(credential.detail).toContain('只读')
  })

  it('密钥来自存储配置（file）时 credential 阶段是 ok 且不提示来源问题', async () => {
    const report = await probeMachine(machine, deps({
      credentialSource: async () => ({ configured: true, source: 'file', writable: true }),
    }))
    const credential = report.stages.find((s) => s.stage === 'credential')!
    expect(credential.ok).toBe(true)
    expect(credential.detail).not.toContain('不是本机存储的配置')
  })

  // --- Addition C: 整体超时 ---

  it('某一阶段一直不 resolve 时，整体探测会在超时后返回，该阶段标记为超时失败，其余标记为 skipped', async () => {
    const report = await probeMachine(machine, deps({
      sshHandshake: () => new Promise(() => {}), // 永不 resolve/reject
    }), { timeoutMs: 30 })

    expect(report.ok).toBe(false)
    expect(report.stages.map((s) => s.stage)).toEqual([...PROBE_STAGES])
    expect(report.stages.find((s) => s.stage === 'tcp')!.ok).toBe(true)
    expect(report.stages.find((s) => s.stage === 'credential')!.ok).toBe(true)
    const handshake = report.stages.find((s) => s.stage === 'handshake')!
    expect(handshake.ok).toBe(false)
    expect(handshake.skipped).toBeFalsy()
    expect(handshake.detail).toContain('超时')
    const os = report.stages.find((s) => s.stage === 'os')!
    expect(os.ok).toBe(false)
    expect(os.skipped).toBe(true)
    const gpu = report.stages.find((s) => s.stage === 'gpu')!
    expect(gpu.ok).toBe(false)
    expect(gpu.skipped).toBe(true)
  })

  it('C1：超时后被放弃的阶段迟些才 resolve，也不会再修改已经返回的报告', async () => {
    let resolveHandshake!: (value: { ok: boolean; fingerprint?: string }) => void
    const handshakePromise = new Promise<{ ok: boolean; fingerprint?: string }>((resolve) => {
      resolveHandshake = resolve
    })

    const report = await probeMachine(machine, deps({
      sshHandshake: () => handshakePromise,
    }), { timeoutMs: 30 })

    const snapshot = JSON.parse(JSON.stringify(report))

    // 让被放弃的 handshake "迟到"地 resolve 成功——修复前，这会在已经
    // 返回的 report.stages 上继续 push 新的阶段结果（握手成功、os、
    // gpu），而 report.ok 早已定格在超时那一刻的 false，产生自相矛盾、
    // 事后还在变化的报告对象。
    resolveHandshake({ ok: true, fingerprint: 'sha256:abc' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(JSON.parse(JSON.stringify(report))).toEqual(snapshot)
    expect(report.stages).toHaveLength(PROBE_STAGES.length)
  })

  it('I3：一次很快完成的探测不应该让进程/调用方等到 timeoutMs 才收尾（定时器被清理）', async () => {
    const clearSpy: number[] = []
    const originalClearTimeout = globalThis.clearTimeout
    globalThis.clearTimeout = (...args: Parameters<typeof clearTimeout>) => {
      clearSpy.push(1)
      return originalClearTimeout(...args)
    }
    try {
      const start = Date.now()
      await probeMachine(machine, deps(), { timeoutMs: 10_000 })
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(1000)
      expect(clearSpy.length).toBeGreaterThan(0)
    } finally {
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  it('dep 抛出异常而不是返回 { ok:false } 时，不会变成未处理的 rejection，而是落在当前阶段并标注是探针内部错误', async () => {
    const report = await probeMachine(machine, deps({
      tcpReachable: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'pool')")
      },
    }))
    expect(report.ok).toBe(false)
    const tcp = report.stages.find((s) => s.stage === 'tcp')!
    expect(tcp.ok).toBe(false)
    expect(tcp.detail).toContain('探针内部错误')
    expect(tcp.detail).toContain("reading 'pool'")
    expect(report.stages.slice(1).every((s) => s.skipped)).toBe(true)
  })

  it('I8：传入一个已经中止的 signal 不会让探针当场抛错或挂死，仍能正常收尾', async () => {
    // probeMachine 不会因为外部 signal 提前 resolve 一个永远挂起的 dep
    // （那是 dep 自己要不要响应 abort 的事），这里只验证"传入已中止的
    // signal"这条路径本身是安全的：函数不因此抛错，仍然按 timeoutMs
    // 正常收尾并返回一份完整报告。用很短的 timeoutMs 避免测试挂起太久。
    const controller = new AbortController()
    controller.abort()

    const report = await probeMachine(machine, deps({
      sshHandshake: () => new Promise(() => {}),
    }), { timeoutMs: 30, signal: controller.signal })

    expect(report.stages).toHaveLength(PROBE_STAGES.length)
    expect(report.stages.find((s) => s.stage === 'handshake')!.detail).toContain('超时')
  })
})
