/**
 * 在 Mac 上验证 iOS 的 sharp 桥。**不需要真机。**
 *
 *     node tools/verify-sharp-bridge.mjs
 *
 * 做法：搭一个临时目录，让 `node_modules/sharp` 指向桥、
 * `@deepseek-ai/dsh-attachment-local` 指向真的实现，于是附件服务
 * `import sharp from "sharp"` 拿到的是桥。桥背后接 `fake-native-bridge.mjs`
 * （用真 sharp 复现 ImageOps 的语义）。然后跑与设备上**同一份**自检
 * （`bridge-selftest.mjs`）。
 *
 * 这样能当场发现的，是此前每个都要一趟真机的那类问题：
 *   - 桥少实现了 dsh 会调的方法（.raw / .toColourspace / .trim …）
 *   - 元数据契约不全（depth/space 缺失 → verifyNormalizedImage 判负）
 *   - 输入类型（dsh 在校验那步传的是 Uint8Array，不是 Buffer）
 *   - 编码格式与标签不一致（webp 偷偷退回 jpeg）
 *
 * 发现不了的是 ImageIO 本身的行为，那部分只能上设备。
 */
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startFakeBridge } from './fake-native-bridge.mjs'
import { runAttachmentSelfTest } from './bridge-selftest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** 真的 dsh 装在哪儿。优先仓库里，其次全局。 */
function locateAttachmentLocal() {
  const candidates = [
    resolve(here, '../ios/nodejs-project/node_modules/@deepseek-ai/dsh-attachment-local'),
    resolve(here, '../node_modules/@deepseek-ai/dsh-attachment-local'),
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local',
  ]
  for (const path of candidates) {
    try {
      require.resolve(join(path, 'package.json'))
      return path
    } catch {}
  }
  throw new Error(`找不到 dsh-attachment-local，找过：\n  ${candidates.join('\n  ')}`)
}

async function main() {
  const attachmentLocal = locateAttachmentLocal()
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-verify-'))
  try {
    // 桥装成 node_modules/sharp。附件服务从它自己的位置向上找 sharp，
    // 所以把它一起放进这个目录树里。
    await mkdir(join(root, 'node_modules/sharp'), { recursive: true })
    await cp(join(here, 'sharp-bridge/index.cjs'), join(root, 'node_modules/sharp/index.cjs'))
    await cp(join(here, 'sharp-bridge/package.json'), join(root, 'node_modules/sharp/package.json'))

    // 附件服务用实体拷贝，不用符号链接：Node 默认按 realpath 解析模块，
    // 符号链接会让它从**真实位置**向上找，于是又找回真的 sharp。
    await cp(attachmentLocal, join(root, 'node_modules/@deepseek-ai/dsh-attachment-local'), {
      recursive: true,
    })
    // 它自己的依赖仍指向真实安装位置——那些与桥无关。
    for (const dep of ['dsh-attachment', 'dsh-home-paths', 'schemastery']) {
      const target = dirname(attachmentLocal) + '/' + dep
      await symlink(target, join(root, 'node_modules/@deepseek-ai', dep)).catch(() => {})
    }
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n')

    const bridge = await startFakeBridge()
    process.env.DSH_NATIVE_BRIDGE = bridge.url
    process.env.DSH_SELFTEST_ATTACHMENT = join(
      root,
      'node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js',
    )

    const ok = await runAttachmentSelfTest((line) => console.log(line))
    bridge.close()
    console.log(ok ? '\n桥与附件服务的接口对得上。' : '\n有失败项，见上。')
    process.exitCode = ok ? 0 : 1
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
