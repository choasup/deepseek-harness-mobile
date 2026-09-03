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
