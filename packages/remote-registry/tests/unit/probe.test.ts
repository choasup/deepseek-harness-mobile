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
    credentialSource: async () => ({ configured: true, source: 'file' }),
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

  // --- Addition B: 凭据来源阶段 ---

  it('没有存储密钥时 credential 阶段失败，且不读成认证被拒', async () => {
    const report = await probeMachine(machine, deps({
      credentialSource: async () => ({ configured: false }),
    }))
    const credential = report.stages.find((s) => s.stage === 'credential')!
    expect(credential.ok).toBe(false)
    expect(credential.detail).not.toContain('认证')
    expect(report.ok).toBe(false)
    // handshake 及之后因前置失败被跳过。
    expect(report.stages.find((s) => s.stage === 'handshake')!.skipped).toBe(true)
  })

  it('密钥来自环境变量而非存储配置时，credential 阶段仍是 ok 但注明来源', async () => {
    const report = await probeMachine(machine, deps({
      credentialSource: async () => ({ configured: true, source: 'env' }),
    }))
    const credential = report.stages.find((s) => s.stage === 'credential')!
    expect(credential.ok).toBe(true)
    expect(credential.detail).toContain('环境变量')
    // 后续阶段应正常继续探测，而不是因为这条"警示但非失败"的信息被跳过。
    expect(report.stages.find((s) => s.stage === 'handshake')!.skipped).toBeFalsy()
  })

  it('密钥来自存储配置（file）时 credential 阶段是 ok 且不提示环境变量来源', async () => {
    const report = await probeMachine(machine, deps({
      credentialSource: async () => ({ configured: true, source: 'file' }),
    }))
    const credential = report.stages.find((s) => s.stage === 'credential')!
    expect(credential.ok).toBe(true)
    expect(credential.detail).not.toContain('环境变量')
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
})
