import { describe, expect, it } from 'vitest'
import type { RemoteMachine } from '../../src/types.ts'
import { formatRemoteUrl, keyRefForName, parseRemoteUrl, RemoteUrlError } from '../../src/url.ts'

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

  it('tags 中每一项都会被 trim，trim 后为空的项会被丢弃', () => {
    expect(parseRemoteUrl('dsh-remote://me@h.test/?name=box&tags=a%2C+b+%2Cc').tags)
      .toEqual(['a', 'b', 'c'])
  })

  it('host 会被转成小写，避免与大写形式被当成两台不同机器', () => {
    expect(parseRemoteUrl('dsh-remote://me@ExAmple.COM/?name=box').host).toBe('example.com')
  })

  it('fp 前缀大小写不敏感，且会被归一化成小写（ssh-keygen -lf 打印的是大写 SHA256:）', () => {
    const m = parseRemoteUrl('dsh-remote://me@h.test/?name=box&fp=SHA256%3AAbC%2B%2F123')
    expect(m.hostFingerprint).toBe('sha256:AbC+/123')
  })

  it.each([
    ['协议不对', 'https://me@h.test/?name=box', 'BAD_SCHEME'],
    ['缺 user', 'dsh-remote://h.test/?name=box', 'MISSING_USER'],
    ['缺 name', 'dsh-remote://me@h.test/', 'MISSING_NAME'],
    ['name 非法', 'dsh-remote://me@h.test/?name=has%20space', 'BAD_NAME'],
    ['port 越界', 'dsh-remote://me@h.test:99999/?name=box', 'BAD_PORT'],
    // port 0 在 WHATWG URL 看来是合法端口（不会在 new URL() 阶段抛错），
    // 是我们自己在 assertValidMachine 里补的范围检查（port >= 1）把它挡下来的——
    // 这条用例证明那条检查不是死代码，删掉它这里就会回归。
    ['port 为 0', 'dsh-remote://me@h.test:0/?name=box', 'BAD_PORT'],
    ['整个串不是 URL', 'not a url at all', 'BAD_URL'],
    // 一个孤立的 % 是合法的 userinfo 字符（WHATWG URL 会原样保留），
    // 但作为 percent-encoding 去 decodeURIComponent 时是畸形的——
    // 之前这里会抛出未包装的 URIError，而不是 RemoteUrlError。
    ['用户名含非法转义', 'dsh-remote://a%b@h.test/?name=box', 'BAD_URL'],
    ['fp 格式不对', 'dsh-remote://me@h.test/?name=box&fp=not-a-fingerprint', 'BAD_FINGERPRINT'],
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
    const m: RemoteMachine = {
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

  it('host 会被归一化成小写再序列化——用户在表单里敲大写不该报错', () => {
    const url = formatRemoteUrl({
      name: 'box', host: 'Example.COM', port: 22, user: 'me',
      keyRef: 'REMOTE_KEY_BOX', tags: [],
    })
    expect(url).toBe('dsh-remote://me@example.com/?name=box')
  })

  it.each([
    [
      'port 越界（曾经会被 WHATWG 的 port setter 静默丢弃，序列化出端口 22 的 URL）',
      { name: 'box', host: 'h.test', port: 70000, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_PORT',
    ],
    [
      'name 非法',
      { name: 'has space', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_NAME',
    ],
    [
      'user 为空（曾经会序列化成一个 parse 会拒绝的 URL，往返不是逆运算）',
      { name: 'box', host: 'h.test', port: 22, user: '', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'MISSING_USER',
    ],
    [
      'tags 不是数组（曾经会抛出未包装的 TypeError: not iterable）',
      { name: 'box', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: undefined },
      'BAD_TAG',
    ],
    [
      'tag 含逗号（否则往返时会被拆成两个 tag）',
      { name: 'box', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: ['a,b'] },
      'BAD_TAG',
    ],
    [
      'fp 格式不对',
      {
        name: 'box', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [],
        hostFingerprint: 'not-a-fingerprint',
      },
      'BAD_FINGERPRINT',
    ],
    // 下面这一组都是「host 校验只看 new URL() 会不会抛」的漏洞：WHATWG
    // 对 host 位置里的 '/', '?', '#', '@', ':' 不会抛错，而是悄悄把
    // 字符串重新切分成别的部分。只有最后一条（含空格）会让 new URL()
    // 真正抛错——这也是为什么之前只测这一条会给出错误的安全感。
    [
      'host 里混进了端口（会被当成端口 2222，而不是 host 的一部分）',
      { name: 'box', host: 'h.test:2222', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_URL',
    ],
    [
      'host 里混进了 scheme',
      { name: 'box', host: 'ssh://h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_URL',
    ],
    [
      'host 里混进了 userinfo',
      { name: 'box', host: 'a@evil.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_URL',
    ],
    [
      'host 里混进了路径',
      { name: 'box', host: 'h.test/evil', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_URL',
    ],
    [
      'host 为空串',
      { name: 'box', host: '', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_URL',
    ],
    [
      'host 含空格（唯一一种会让 new URL() 直接抛错的畸形 host）',
      { name: 'box', host: 'h test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_URL',
    ],
  ])('拒绝：%s', (_label, machine, code) => {
    try {
      formatRemoteUrl(machine as RemoteMachine)
      expect.unreachable('应当抛出')
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteUrlError)
      expect((err as RemoteUrlError).code).toBe(code)
    }
  })

  it.each([
    [
      '最简单的情况：默认端口、无 tags、无 fp',
      { name: 'a', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_A', tags: [] } satisfies RemoteMachine,
      { name: 'a', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_A', tags: [] } satisfies RemoteMachine,
    ],
    [
      '大写 host + 非默认端口 + 多个 tags',
      {
        name: 'b', host: 'H.Test', port: 2222, user: 'root', keyRef: 'REMOTE_KEY_B', tags: ['x', 'y'],
      } satisfies RemoteMachine,
      {
        name: 'b', host: 'h.test', port: 2222, user: 'root', keyRef: 'REMOTE_KEY_B', tags: ['x', 'y'],
      } satisfies RemoteMachine,
    ],
    [
      'IPv6 host + 大写 fp 前缀',
      {
        name: 'c', host: '[::1]', port: 22, user: 'me', keyRef: 'REMOTE_KEY_C', tags: ['gpu'],
        hostFingerprint: 'SHA256:AbC+/123',
      } satisfies RemoteMachine,
      {
        name: 'c', host: '[::1]', port: 22, user: 'me', keyRef: 'REMOTE_KEY_C', tags: ['gpu'],
        hostFingerprint: 'sha256:AbC+/123',
      } satisfies RemoteMachine,
    ],
    [
      '端口取到上边界 + defaultWorkdir，无 tags',
      {
        name: 'd', host: 'gpu.example.com', port: 65535, user: 'me', keyRef: 'REMOTE_KEY_D', tags: [],
        defaultWorkdir: '/root/work',
      } satisfies RemoteMachine,
      {
        name: 'd', host: 'gpu.example.com', port: 65535, user: 'me', keyRef: 'REMOTE_KEY_D', tags: [],
        defaultWorkdir: '/root/work',
      } satisfies RemoteMachine,
    ],
  ])('批量往返：%s', (_label, input, expected) => {
    expect(parseRemoteUrl(formatRemoteUrl(input))).toEqual(expected)
  })
})

describe('keyRefForName', () => {
  it('不同的机器名可能映射到同一个 keyRef（已知行为）', () => {
    // 'my-box' 与 'my_box' 都会被归一化成 'REMOTE_KEY_MY_BOX'。这里不
    // 修复这个碰撞——唯一性由 registry（Task 8）在 add() 时校验并拒绝
    // 重复的 keyRef，不是这个纯函数的职责。这条测试只是把当前行为钉住，
    // 防止以后有人"顺手"把它改成别的、Task 8 没预期到的派生规则。
    expect(keyRefForName('my-box')).toBe('REMOTE_KEY_MY_BOX')
    expect(keyRefForName('my_box')).toBe('REMOTE_KEY_MY_BOX')
    expect(keyRefForName('my-box')).toBe(keyRefForName('my_box'))
  })
})
