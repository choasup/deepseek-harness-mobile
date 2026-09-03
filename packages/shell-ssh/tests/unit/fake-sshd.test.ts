import { afterEach, describe, expect, it } from 'vitest'
import { Client } from 'ssh2'
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
