import { describe, expect, it } from 'vitest'
import type { RemoteMachine } from '../../src/types.ts'
import {
  formatRemoteUrl, keyRefForName, normalizeFingerprint, normalizeMachine, parseRemoteUrl,
  RemoteUrlError,
} from '../../src/url.ts'

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

  it('展开形式的 IPv6 host 会被压缩成规范形式', () => {
    expect(parseRemoteUrl('dsh-remote://me@[0:0:0:0:0:0:0:1]/?name=box').host).toBe('[::1]')
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
    // port 0 通不过 new URL()（WHATWG 不会在这一步抛错），
    // 靠 normalizeAndValidate 的范围检查挡下来——这条用例证明那条
    // 检查不是死代码。
    ['port 为 0', 'dsh-remote://me@h.test:0/?name=box', 'BAD_PORT'],
    ['整个串不是 URL', 'not a url at all', 'BAD_URL'],
    // 孤立的 % 是合法的 userinfo 字符（WHATWG 原样保留），但拿去
    // decodeURIComponent 是畸形的转义。
    ['用户名含非法转义', 'dsh-remote://a%b@h.test/?name=box', 'BAD_URL'],
    ['fp 格式不对', 'dsh-remote://me@h.test/?name=box&fp=not-a-fingerprint', 'BAD_FINGERPRINT'],
    // 非 ASCII host 会被 WHATWG percent-encode 成一串乱码而不是拒绝，
    // 必须显式挡住，让用户改用 punycode。
    ['host 含非 ASCII 字符', 'dsh-remote://me@%E4%BE%8B%E3%81%88.jp/?name=box', 'BAD_URL'],
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

  it('fp 前缀会被归一化成小写再序列化——format 与 parse 用同一套归一化', () => {
    const url = formatRemoteUrl({
      name: 'box', host: 'h.test', port: 22, user: 'me',
      keyRef: 'REMOTE_KEY_BOX', tags: [], hostFingerprint: 'SHA256:AbC+/123',
    })
    expect(url).toContain('fp=sha256%3AAbC%2B%2F123')
  })

  it.each([
    [
      'port 越界（曾经会被 WHATWG 的 port setter 静默丢弃，序列化出端口 22 的 URL）',
      { name: 'box', host: 'h.test', port: 70000, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_PORT',
    ],
    [
      'port 是字符串（表单输入的常见形状）——类型错，不是"越界"',
      { name: 'box', host: 'h.test', port: '22', user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_PORT',
    ],
    [
      'name 非法',
      { name: 'has space', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_NAME',
    ],
    [
      'name 是 undefined（曾经会序列化成 name=undefined 并解析回一条"合法"记录）',
      { name: undefined, host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_NAME',
    ],
    [
      'keyRef 与 name 派生值不一致（曾经会被往返悄悄改指到别的凭据条目）',
      { name: 'box', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_SHARED', tags: [] },
      'BAD_KEY_REF',
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
      'tags 里混进了非字符串',
      { name: 'box', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [123] },
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
    // 下面这一组都是「只看 new URL() 会不会抛」骗过 host 校验的写法：
    // WHATWG 对 '/', '?', '#', '@', ':' 不抛错，而是把字符串重新
    // 切分成别的部分。只有含空格那条会让 new URL() 真正抛错。
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
      // 空 username、非空 password 的 userinfo——只查 probe.username
      // 会漏过去，必须同时查 probe.password。
      'host 里混进了 userinfo（空 username，只有 password）',
      { name: 'box', host: ':pw@evil.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_URL',
    ],
    [
      'host 里混进了 userinfo（username 和 password 都为空，只有 @）',
      { name: 'box', host: '@evil.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_URL',
    ],
    [
      'host 里混进了 userinfo（双冒号写法）',
      { name: 'box', host: '::pw@evil.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
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
      'host 是 undefined（曾经会抛出未包装的 TypeError）',
      { name: 'box', host: undefined, port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_URL',
    ],
    [
      'host 含空格（唯一一种会让 new URL() 直接抛错的畸形 host）',
      { name: 'box', host: 'h test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
      'BAD_URL',
    ],
    [
      'host 含非 ASCII 字符（会被 percent-encode 成谁也连不上的乱码）',
      { name: 'box', host: '例え.jp', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [] },
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

  const ROUND_TRIP_CASES: Array<[string, RemoteMachine, RemoteMachine]> = [
    [
      '最简单的情况：默认端口、无 tags、无 fp',
      { name: 'a', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_A', tags: [] },
      { name: 'a', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_A', tags: [] },
    ],
    [
      '大写 host + 非默认端口 + 多个 tags',
      {
        name: 'b', host: 'H.Test', port: 2222, user: 'root', keyRef: 'REMOTE_KEY_B', tags: ['x', 'y'],
      },
      {
        name: 'b', host: 'h.test', port: 2222, user: 'root', keyRef: 'REMOTE_KEY_B', tags: ['x', 'y'],
      },
    ],
    [
      'IPv6 host（压缩形式）+ 大写 fp 前缀',
      {
        name: 'c', host: '[::1]', port: 22, user: 'me', keyRef: 'REMOTE_KEY_C', tags: ['gpu'],
        hostFingerprint: 'SHA256:AbC+/123',
      },
      {
        name: 'c', host: '[::1]', port: 22, user: 'me', keyRef: 'REMOTE_KEY_C', tags: ['gpu'],
        hostFingerprint: 'sha256:AbC+/123',
      },
    ],
    [
      'IPv6 host（展开形式会被压缩）',
      { name: 'e', host: '[0:0:0:0:0:0:0:1]', port: 22, user: 'me', keyRef: 'REMOTE_KEY_E', tags: [] },
      { name: 'e', host: '[::1]', port: 22, user: 'me', keyRef: 'REMOTE_KEY_E', tags: [] },
    ],
    [
      '端口取到上边界 + defaultWorkdir，无 tags',
      {
        name: 'd', host: 'gpu.example.com', port: 65535, user: 'me', keyRef: 'REMOTE_KEY_D', tags: [],
        defaultWorkdir: '/root/work',
      },
      {
        name: 'd', host: 'gpu.example.com', port: 65535, user: 'me', keyRef: 'REMOTE_KEY_D', tags: [],
        defaultWorkdir: '/root/work',
      },
    ],
    [
      '末尾带点的合法 FQDN 写法会被保留',
      { name: 'f', host: 'h.test.', port: 22, user: 'me', keyRef: 'REMOTE_KEY_F', tags: [] },
      { name: 'f', host: 'h.test.', port: 22, user: 'me', keyRef: 'REMOTE_KEY_F', tags: [] },
    ],
  ]

  it.each(ROUND_TRIP_CASES)('批量往返：%s', (_label, input, expected) => {
    expect(parseRemoteUrl(formatRemoteUrl(input))).toEqual(expected)
  })

  // 不依赖任何手写字面量的性质测试：format 应当是幂等的——先归一化
  // 一次之后再走一遍 parse→format，字符串必须原样不变。这条测试不需要
  // 知道归一化的具体规则是什么，规则本身和字面量一旦互相漂移，
  // 它就会挂（例如 format 曾经不归一化 fp 前缀时，这条就会失败）。
  it.each(ROUND_TRIP_CASES)('format∘parse 是幂等的: %s', (_label, input) => {
    const once = formatRemoteUrl(input)
    expect(formatRemoteUrl(parseRemoteUrl(once))).toBe(once)
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

describe('normalizeMachine', () => {
  it('导出给外部调用方用——例如 Task 8 手动录入表单在 add() 前应该存这个返回值，而不是原始输入', () => {
    const m = normalizeMachine({
      name: 'box', host: 'H.Test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [],
      hostFingerprint: 'SHA256:AbC=',
    })
    expect(m).toEqual({
      name: 'box', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: [],
      hostFingerprint: 'sha256:AbC',
    })
  })

  it('返回的 tags 是拷贝，不是输入数组的引用——调用方事后改自己那份不会连带改到返回值', () => {
    const inputTags = ['gpu']
    const m = normalizeMachine({
      name: 'box', host: 'h.test', port: 22, user: 'me', keyRef: 'REMOTE_KEY_BOX', tags: inputTags,
    })
    inputTags.push('MUTATED-AFTER-NORMALIZE')
    expect(m.tags).toEqual(['gpu'])
  })
})

describe('normalizeFingerprint', () => {
  it('只归一化前缀大小写，base64 payload 原样保留', () => {
    expect(normalizeFingerprint('SHA256:AbC+/123')).toBe('sha256:AbC+/123')
    expect(normalizeFingerprint('sha256:AbC+/123')).toBe('sha256:AbC+/123')
  })

  it('去掉 base64 的尾部 padding，与 ssh-keygen -lf 的输出对齐', () => {
    // ssh-keygen -lf 打印不带 padding 的形式；其他工具可能带 padding。
    // 两种写法必须归一化成同一个值，否则 Task 9 的握手比对会把一台
    // 存了带 padding 指纹的机器永远判定为"指纹不匹配"。
    expect(normalizeFingerprint('sha256:AbC=')).toBe('sha256:AbC')
    expect(normalizeFingerprint('SHA256:AbC')).toBe('sha256:AbC')
    expect(normalizeFingerprint('sha256:AbC=')).toBe(normalizeFingerprint('SHA256:AbC'))
  })
})
