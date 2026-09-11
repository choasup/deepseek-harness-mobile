import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { EnvPage } from './EnvPage.tsx'
import { installStyles } from './styles.ts'

/**
 * 占住「环境」Tab。
 *
 * `env` 这个坑位由 `@dsh-mobile/client-ui-layout-mobile` 的外框声明——
 * **声明等于独占渲染权**，所以外框必须先把这一格留出来，这个包才有地方注册。
 * 没有占位者时外框显示的是一段 fallback 文案（"还没有可显示的环境"），
 * 这个包一挂上就顶掉它。
 */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() =>
    ctx.slots.inject('env', () =>
      ctx.slots.register({ name: 'env' }, EnvPage)))
}
