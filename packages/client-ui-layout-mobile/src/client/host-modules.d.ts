/**
 * 宿主在运行时提供的模块的**最小类型声明**。
 *
 * 为什么不直接装 `@deepseek-ai/dsh-client-runtime`：
 *
 * 1. 运行时根本不需要它。这些模块是 bundle 的 external，由 web shell 预置
 *    （见 build.mjs 的说明）——打进包里反而会在页面上造出第二份实例。
 * 2. 装了会污染 workspace 的依赖解析。实测：`pnpm add -D` 之后它拖进来第二个
 *    `@deepseek-ai/cordis`，把 `remote-registry` 的 `Context` 扩展全部遮掉，
 *    typecheck 冒出十几个 "Property 'storageDomain' does not exist"。
 *
 * 所以按用到的那一小块手写声明。同 `types.ts`：契约漂移由运行时暴露，
 * 不由这里的编译暴露。
 */
declare module '@deepseek-ai/dsh-client-runtime/client' {
  /** 定义一个带 immer 风格 draft 写入的面板 store。 */
  export function defineStore<S, A extends Record<string, (draft: S, ...args: never[]) => void>>(
    spec: { init: () => S; actions: A },
  ): { init: () => S; actions: A }

  /** 客户端根 context。只声明这个插件实际用到的面。 */
  export interface ClientContext {
    effect(fn: () => () => void, label: string): void
    on(event: string, handler: (payload: never) => void): () => void
    reflect: { provide(name: string, value: unknown): () => void }
    slots: { register(spec: unknown, component: unknown): () => void }
    theme: { getTheme(): { active: { colorScheme: 'light' | 'dark'; tokens: Record<string, string> } } }
  }
}
