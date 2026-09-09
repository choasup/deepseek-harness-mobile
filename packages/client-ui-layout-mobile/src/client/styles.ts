/**
 * 这个包自己的样式。
 *
 * 手写类名 + 一次性注入 <style>，跟 dsh 编译产物的做法一致（它用的是 CSS
 * modules，构建期生成同样形状的注入代码）。用 `dshm-` 前缀避免跟别的插件撞。
 *
 * 颜色一律走 `--dsw-*` 设计令牌，不写死——那些变量由 theme-presenter 写在
 * body 上，跟其余 32 个 UI 插件用的是同一套，所以深浅色跟随全局主题。
 */
export const cls = {
  frame: 'dshm-frame',
  topbar: 'dshm-topbar',
  menuButton: 'dshm-menu',
  title: 'dshm-title',
  center: 'dshm-center',
  drawer: 'dshm-drawer',
  scrim: 'dshm-scrim',
  sheet: 'dshm-sheet',
  sheetGrip: 'dshm-sheet-grip',
  sheetBody: 'dshm-sheet-body',
  overlay: 'dshm-overlay',
} as const

const CSS = `
.dshm-frame {
  background: var(--dsw-alias-bg-base);
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  overflow: hidden;
}

/* 顶栏。桌面版没有这个东西——侧栏收起后靠一条 56px 常驻控制条提供入口，
   而手机上那条竖栏纯属浪费宽度，所以改成顶部一个菜单键。 */
.dshm-topbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding-top: env(safe-area-inset-top);
  padding-left: max(4px, env(safe-area-inset-left));
  padding-right: max(4px, env(safe-area-inset-right));
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base));
}

/* 44x44 是 iOS HIG 的最小触控目标；桌面版的把手是 8px 宽，手指点不中。 */
.dshm-menu {
  width: 44px;
  height: 44px;
  flex: none;
  display: grid;
  place-items: center;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--dsw-alias-text-1, currentColor);
  border-radius: 8px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.dshm-menu:active { background: var(--dsw-alias-fill-2, rgba(127, 127, 127, .18)); }

.dshm-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--dsw-alias-text-1, currentColor);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshm-center {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 抽屉与 sheet 都用 transform 移出屏幕，而不是卸载——占位插件（ui-sidebar、
   ui-conversation 的 DetailsPanel）的内部状态因此在开合之间保留，
   跟桌面版"width 0 但子树仍挂载"是同一个约定。 */
.dshm-drawer {
  position: absolute;
  inset: 0 auto 0 0;
  width: min(84vw, 320px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base));
  border-right: 1px solid var(--dsw-alias-border-l1);
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  transform: translateX(-100%);
  visibility: hidden;
  transition: transform var(--ds-transition-duration-slow, .24s) var(--ds-ease-in-out, ease),
              visibility 0s linear var(--ds-transition-duration-slow, .24s);
}
.dshm-frame[data-drawer='open'] .dshm-drawer {
  transform: translateX(0);
  visibility: visible;
  transition: transform var(--ds-transition-duration-slow, .24s) var(--ds-ease-in-out, ease);
}

.dshm-sheet {
  position: absolute;
  inset: auto 0 0 0;
  max-height: 76%;
  z-index: 30;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  border-top: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px 14px 0 0;
  padding-bottom: env(safe-area-inset-bottom);
  transform: translateY(100%);
  visibility: hidden;
  transition: transform var(--ds-transition-duration-slow, .24s) var(--ds-ease-in-out, ease),
              visibility 0s linear var(--ds-transition-duration-slow, .24s);
}
.dshm-frame[data-details='open'] .dshm-sheet {
  transform: translateY(0);
  visibility: visible;
  transition: transform var(--ds-transition-duration-slow, .24s) var(--ds-ease-in-out, ease);
}

/* 下拉把手：一条横杠，兼作"这里能拖/能点关"的可见提示。 */
.dshm-sheet-grip {
  flex: none;
  height: 28px;
  display: grid;
  place-items: center;
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
.dshm-sheet-grip::after {
  content: '';
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--dsw-alias-border-l3, rgba(127, 127, 127, .5));
}
.dshm-sheet-body { flex: 1 1 auto; min-height: 0; overflow: auto; }

.dshm-scrim {
  position: absolute;
  inset: 0;
  z-index: 25;
  background: rgba(0, 0, 0, .38);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--ds-transition-duration-slow, .24s) var(--ds-ease-in-out, ease);
}
.dshm-frame[data-drawer='open'] .dshm-scrim,
.dshm-frame[data-details='open'] .dshm-scrim {
  opacity: 1;
  pointer-events: auto;
}

/* 与桌面版同名同语义的整框浮层：默认穿透，条目自己要回指针事件。 */
.dshm-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  pointer-events: none;
}
.dshm-overlay > * { pointer-events: auto; }

/* ── 触屏上关掉悬停提示 ──────────────────────────────────────────────
   桌面版给按钮配了 hover tooltip（"发送消息"那类）。触屏没有"移开指针"
   这个动作：手指点一下，:hover 就**留在**那个元素上不走，于是提示框赖在
   屏幕中间，挡住内容且怎么都不消失。

   hover:none 只匹配真正没有悬停能力的指针设备——桌面完全不受影响，
   带触控板的笔记本也不受影响。

   用 display:none 而不是 opacity:0：后者只是看不见，仍然占据布局、
   仍然拦截点击。 */
@media (hover: none) {
  [role='tooltip'],
  [class*='tooltip'],
  [class*='Tooltip'] {
    display: none !important;
  }

  /* 行内操作在触屏上必须常显。

     dsh 的侧栏把每行的操作放在一个 display:none 的容器里，靠
     \`:hover\` 或 \`.menuOpen\` 放成 inline-flex。触屏**两个条件都不成立**，
     于是手机上重命名、删除会话、在某个工作区里新建会话——全都没有入口，
     按钮实测是 0×0。

     **选择器用结构而不是类名**：那些类名是 CSS-module 哈希
     （YDXeBa_rowActions 这种），dsh 每次构建都会变。而"treeitem 的直接
     子元素、内部含按钮"这个关系稳定得多；实测它精确命中 7 个操作容器，
     行标签、时间戳之类一个都没误伤。

     用 !important 是因为要盖的是别的包的基础规则，而我们无法预知它下次
     构建后的选择器权重。 */
  .dshm-drawer [role='treeitem'] > :has(button) {
    display: inline-flex !important;
  }

  /* 那些图标按钮是 16×16，对手指太小。行高 34px，撑到 28 是塞得下的上限
     ——HIG 推荐的 44 会把整行挤变形，这里取能做到的最好值而不是照搬数字。 */
  .dshm-drawer [role='treeitem'] > :has(button) button {
    min-width: 28px;
    min-height: 28px;
  }
}

/* ── 设置对话框的窄屏降级 ────────────────────────────────────────────
   dsh 的设置面板是桌面版两栏：左侧 nav + 右侧内容。在 375px 宽的手机上
   nav 独占 188px，内容只剩 127px——文字变成一个字一行。

   **选择器刻意用结构而不是类名**：那些类名是 CSS-module 哈希
   （VOzbGW_panel 这种），dsh 每次重新构建都会变。而
   [role=dialog] > nav 这种结构关系稳定得多。代价是万一 dsh 改了 DOM 结构
   这段会静默失效（回到挤压的样子，不会坏），可以接受。

   只在窄屏生效，桌面完全不受影响。 */
@media (max-width: 640px) {
  [role='dialog'] {
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100dvh !important;
    max-height: 100dvh !important;
    border-radius: 0 !important;
    flex-direction: column !important;
  }

  /* 左栏变成顶部的横向标签条 */
  [role='dialog'] > nav {
    width: 100% !important;
    flex: none !important;
    border-right: none !important;
    border-bottom: 1px solid var(--dsw-alias-border-l1);
    padding-bottom: 4px;
  }
  [role='dialog'] > nav > div:last-child {
    display: flex !important;
    flex-direction: row !important;
    overflow-x: auto !important;
    gap: 4px;
    /* 手机上横滑时不要出现滚动条占位 */
    scrollbar-width: none;
  }
  [role='dialog'] > nav > div:last-child::-webkit-scrollbar { display: none; }
  [role='dialog'] > nav button {
    width: auto !important;
    flex: 0 0 auto !important;
    white-space: nowrap !important;
    /* 44pt 触控目标 */
    min-height: 44px;
  }

  /* 右栏吃满剩余宽度——这一条是"一个字一行"的正解 */
  [role='dialog'] > div {
    width: 100% !important;
    min-width: 0 !important;
    flex: 1 1 auto !important;
    overflow-y: auto !important;
  }
  /* 面板内的行在窄屏下从"标签｜控件"并排改成上下堆叠，
     否则标签被挤成竖排。 */
  [role='dialog'] label,
  [role='dialog'] [class*='row'] {
    min-width: 0 !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dshm-drawer, .dshm-sheet, .dshm-scrim { transition: none; }
}
`

/**
 * 注入一次。守卫条件跟 dsh 编译产物一致：按 `data-plugin-css` 查重，
 * 这样插件热重载重复 materialize 时不会堆出一摞 <style>。
 */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  const tagId = '@dsh-mobile/client-ui-layout-mobile/frame.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-mobile/client-ui-layout-mobile'
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
}
