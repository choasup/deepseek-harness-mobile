import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { keyRefForName } from '@dsh-mobile/remote-registry'
import type { RemoteMachine } from '@dsh-mobile/remote-registry'

/**
 * 把远程机器**注册进 `ctx.remotes`**——这是"云端是手"那一半此前缺失的入口。
 *
 * ## 为什么需要这个插件
 *
 * `remote-registry` 只提供 `ctx.remotes` 服务，机器记录靠有人调 `add()`。
 * 而手机上**没有任何调它的地方**：没有工具、没有命令、没有设置页。于是
 * `shell-ssh` 永远查不到机器、`ctx.shell` 永远不出现、`tool-bash` 只能关着
 * ——整个"手机是大脑，云端是手"的后半句从来没接通过。这个插件补的就是这一步。
 *
 * ## 明文与密钥严格分开
 *
 * - **机器记录**（host/port/user/tags）不含秘密，放
 *   `$DSH_HOME/remote-machines.json`，可以入库、可以随包分发。
 * - **私钥/密码**单独放 `$DSH_HOME/remote-keys/<机器名>.key`，由用户自己送上
 *   设备（`xcrun devicectl device copy to`）。这个插件读进去、交给
 *   `setPrivateKey()`（它写进 dsh 的凭据库），**然后立刻删掉那个文件**。
 *   密钥不进机器记录、不进日志、不进仓库。
 *
 * 删掉是**有意的**：那个文件是一次性投递通道，不是存储。留着等于在
 * app 容器里多放一份明文私钥，而凭据库本来就是放它的地方。
 */
export const inject = ['remotes']

/** 机器清单文件里一条记录的形状（`keyRef` 由名字派生，不在这里写）。 */
interface MachineSpec {
  name: string
  host: string
  port: number
  user: string
  tags?: string[]
  defaultWorkdir?: string
  hostFingerprint?: string
}

interface Remotes {
  list(): Promise<RemoteMachine[]>
  add(machine: RemoteMachine): Promise<void>
  setPrivateKey(name: string, privateKey: string): Promise<void>
}

export function apply(ctx: Context): void {
  const home = process.env.DSH_HOME
  if (home === undefined) {
    ctx.logger?.info?.('remote-bootstrap: 没有 DSH_HOME，跳过')
    return
  }
  void register(ctx, home).catch((error: unknown) => {
    // 注册失败不该让整棵树起不来——没有远程机器时 harness 的其余能力照常。
    console.log(`[remote-bootstrap] 失败: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function register(ctx: Context, home: string): Promise<void> {
  const listFile = join(home, 'remote-machines.json')
  let specs: MachineSpec[]
  try {
    specs = JSON.parse(await readFile(listFile, 'utf8')) as MachineSpec[]
  } catch {
    // 没有清单是正常状态，不是错误——大多数安装本来就不接远程机器。
    return
  }
  if (!Array.isArray(specs) || specs.length === 0) return

  const remotes = (ctx as unknown as { remotes: Remotes }).remotes
  const existing = new Set((await remotes.list()).map((machine) => machine.name))

  for (const spec of specs) {
    if (!existing.has(spec.name)) {
      await remotes.add({
        name: spec.name,
        host: spec.host,
        port: spec.port,
        user: spec.user,
        // **keyRef 必须自己算好。** registry 的 normalizeMachine 会拿
        // keyRefForName(name) 逐字比对，对不上就抛 BAD_KEY_REF——它不会
        // "帮你填"。用它导出的那个函数，别在这里复制那条派生规则。
        keyRef: keyRefForName(spec.name),
        tags: spec.tags ?? [],
        ...(spec.defaultWorkdir === undefined ? {} : { defaultWorkdir: spec.defaultWorkdir }),
        ...(spec.hostFingerprint === undefined ? {} : { hostFingerprint: spec.hostFingerprint }),
      } as RemoteMachine)
      console.log(`[remote-bootstrap] 已注册 ${spec.name} (${spec.user}@${spec.host}:${spec.port})`)
    }

    // 一次性投递通道：读进凭据库后立刻删掉，不在容器里留第二份明文私钥。
    const keyFile = join(home, 'remote-keys', `${spec.name}.key`)
    let key: string
    try {
      key = await readFile(keyFile, 'utf8')
    } catch {
      continue
    }
    await remotes.setPrivateKey(spec.name, key.trim())
    await rm(keyFile, { force: true })
    console.log(`[remote-bootstrap] ${spec.name} 的私钥已导入凭据库，投递文件已删除`)
  }
}
