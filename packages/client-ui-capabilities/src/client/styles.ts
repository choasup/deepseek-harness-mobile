/**
 * 样式。与 layout 包同一个做法：运行时注入一段 `<style>`，类名带 `dshc-`
 * 前缀避免跟别的插件撞。
 *
 * 颜色一律走 `--dsw-*` 设计令牌，不写死十六进制——交付包对这一点有明确要求，
 * 而且深浅色主题是靠这些变量切的，写死等于只对一种主题正确。
 */
export const cls = {
  root: 'dshc-root',
  trigger: 'dshc-trigger',
  menu: 'dshc-menu',
  item: 'dshc-item',
  itemIcon: 'dshc-item-icon',
  itemText: 'dshc-item-text',
  itemLabel: 'dshc-item-label',
  itemHint: 'dshc-item-hint',
} as const

const CSS = `
.dshc-root { position: relative; display: inline-flex; }

/* 44×44 的触控目标——iOS HIG 的下限，也是这一版重设计反复强调的一条。
   视觉上是 32 的圆钮，靠 margin 把命中区撑到 44 而不撑大外观。 */
.dshc-trigger {
  width: 32px;
  height: 32px;
  margin: -6px;
  padding: 6px;
  box-sizing: content-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-fill-secondary, rgba(0, 0, 0, .04));
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}

/* 菜单从输入条往**上**弹：输入条贴着键盘，往下没有空间。 */
.dshc-menu {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 0;
  min-width: 232px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  padding: 6px;
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: 0 8px 30px rgba(15, 17, 21, .12);
}

.dshc-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 8px 10px;
  border: none;
  border-radius: 12px;
  background: none;
  cursor: pointer;
  text-align: left;
  color: var(--dsw-alias-label-primary);
}

.dshc-item:active { background: var(--dsw-alias-fill-secondary, rgba(0, 0, 0, .05)); }

.dshc-item-icon {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: var(--dsw-alias-fill-secondary, rgba(0, 0, 0, .05));
}

.dshc-item-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshc-item-label { font-size: 15px; line-height: 20px; font-weight: 500; }
.dshc-item-hint {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-caption);
}

/* 触屏上没有 hover，:active 才是反馈；桌面上补一个 hover。 */
@media (hover: hover) {
  .dshc-item:hover { background: var(--dsw-alias-fill-secondary, rgba(0, 0, 0, .05)); }
}
`

let installed = false

export function installStyles(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  const style = document.createElement('style')
  style.dataset.dshMobileCapabilities = ''
  style.textContent = CSS
  document.head.append(style)
}
