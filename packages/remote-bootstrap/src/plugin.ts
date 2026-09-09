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
  remove(name: string): Promise<void>
  setPrivateKey(name: string, privateKey: string): Promise<void>
}

/** 只比清单能表达的字段——registry 归一化过的其余字段不参与判断。 */
function sameMachine(current: RemoteMachine, spec: MachineSpec): boolean {
  return current.host === spec.host
    && current.port === spec.port
    && current.user === spec.user
    && (current.defaultWorkdir ?? undefined) === (spec.defaultWorkdir ?? undefined)
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
  const existing = new Map((await remotes.list()).map((machine) => [machine.name, machine]))

  for (const spec of specs) {
    // **清单是唯一事实来源，记录跟它对账。** registry 只有 add/remove，
    // 没有 update；不对账的话，第一次用错端口注册进去之后，改配置文件
    // 永远不生效——而症状是"连不上"，跟配置错得毫无关系。
    const current = existing.get(spec.name)
    if (current !== undefined && !sameMachine(current, spec)) {
      await remotes.remove(spec.name)
      existing.delete(spec.name)
      console.log(`[remote-bootstrap] ${spec.name} 的记录与清单不一致，已删除待重建`)
    }
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

  // **开 tool-bash 之前必须先确认这个。**
  //
  // tool-bash 是 ctx.shell 的纯消费者（inject: ['tools','shell',…]）。
  // ctx.shell 不存在时把它设成 enabled，assertEntriesActivated 会把它的
  // PENDING 当成整棵插件树装载失败——那时 app 连界面都出不来，日志也读不到。
  // 所以先把这个事实写进日志：有它才动那个开关。
  //
  // 延后一拍再看：shell-ssh 查不到机器时会订阅 domain/changed，等注册完
  // 才挂上 executor，而那可能发生在这个函数返回之后。
  setTimeout(() => {
    // **用 ctx.get()，不要直接读属性。** cordis 对没在 inject 里声明的服务
    // 会抛 "cannot get property \"shell\" without inject"——而这句在
    // setTimeout 里，未捕获异常会直接把 Node 进程带走。实测踩过：一个本来
    // 用来"避免打开 tool-bash 把树搞崩"的探针，自己把进程杀了。
    //
    // 整段再包一层 try/catch：诊断探针无论如何都不该有能力影响运行。
    try {
      const shell = (ctx as unknown as { get(name: string): unknown }).get('shell')
      console.log(
        `[remote-bootstrap] ctx.shell ${shell === undefined ? '不存在——tool-bash 还不能开' : '已就绪，tool-bash 可以开了'}`,
      )
    } catch (error) {
      console.log(`[remote-bootstrap] 查 ctx.shell 时出错（不影响运行）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, 3000)
}
